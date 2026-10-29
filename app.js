(function () {
  "use strict";

  var DB_NAME = "kisa-akis-mobile-demo";
  var DB_VERSION = 1;
  var SESSION_KEY = "kisa-akis-mobile-user";
  var PBKDF2_ITERATIONS = 120000;
  var DEMO_PASSWORD = "demo123";
  var db;
  var activeUser;
  var currentPage = "feed";
  var selectedChatUserId = null;
  var selectedProfileUserId = null;
  var pendingVideoFile = null;
  var toastTimeout;

  var $ = function (selector, root) {
    return (root || document).querySelector(selector);
  };
  var $$ = function (selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  };
  var randomId = function () {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (byte) {
      return byte.toString(16).padStart(2, "0");
    }).join("");
  };
  var element = function (tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };
  var initials = function (text) {
    var value = String(text || "?").trim();
    return value.slice(0, 2).toLocaleUpperCase("tr");
  };
  var formatTime = function (timestamp) {
    return new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
  };
  var formatDate = function (timestamp) {
    return new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short" }).format(new Date(timestamp));
  };

  function showToast(message) {
    var toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("visible");
    window.clearTimeout(toastTimeout);
    toastTimeout = window.setTimeout(function () {
      toast.classList.remove("visible");
    }, 3000);
  }

  function openDatabase() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) {
        reject(new Error("Tarayıcı yerel depolamayı desteklemiyor. Güncel Chrome, Safari veya Edge deneyin."));
        return;
      }

      var request = window.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        var database = request.result;
        if (!database.objectStoreNames.contains("users")) {
          var users = database.createObjectStore("users", { keyPath: "id" });
          users.createIndex("username", "username", { unique: true });
        }
        if (!database.objectStoreNames.contains("videos")) {
          var videos = database.createObjectStore("videos", { keyPath: "id" });
          videos.createIndex("ownerId", "ownerId", { unique: false });
        }
        if (!database.objectStoreNames.contains("messages")) {
          var messages = database.createObjectStore("messages", { keyPath: "id" });
          messages.createIndex("conversationId", "conversationId", { unique: false });
        }
      };
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        reject(request.error || new Error("Yerel veritabanı açılamadı."));
      };
      request.onblocked = function () {
        reject(new Error("Veritabanı başka bir sekmede açık. Diğer Kısa Akış sekmelerini kapatıp yeniden deneyin."));
      };
    });
  }

  function readAll(storeName) {
    return new Promise(function (resolve, reject) {
      var transaction = db.transaction(storeName, "readonly");
      var request = transaction.objectStore(storeName).getAll();
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        reject(request.error || new Error("Kayıtlar okunamadı."));
      };
      transaction.onerror = function () {
        reject(transaction.error || new Error("Veritabanı okuma hatası."));
      };
    });
  }

  function saveRecord(storeName, record) {
    return new Promise(function (resolve, reject) {
      var transaction = db.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(record);
      transaction.oncomplete = function () {
        resolve(record);
      };
      transaction.onerror = function () {
        reject(transaction.error || new Error("Değişiklik kaydedilemedi."));
      };
      transaction.onabort = function () {
        reject(transaction.error || new Error("Kaydetme işlemi iptal edildi."));
      };
    });
  }

  function removeRecord(storeName, id) {
    return new Promise(function (resolve, reject) {
      var transaction = db.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).delete(id);
      transaction.oncomplete = function () {
        resolve();
      };
      transaction.onerror = function () {
        reject(transaction.error || new Error("Kayıt silinemedi."));
      };
    });
  }

  function conversationId(first, second) {
    return [first, second].sort().join(":");
  }

  function storeFormText(form, name) {
    var field = form.elements.namedItem(name);
    return field ? field.value.trim() : "";
  }

  function bytesToHex(bytes) {
    return Array.prototype.map.call(bytes, function (byte) {
      return byte.toString(16).padStart(2, "0");
    }).join("");
  }

  async function hashPassword(password, saltHex) {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error("Bu tarayıcıda güvenli şifreleme kullanılamıyor. Kayıt için HTTPS, localhost veya güncel Chrome kullanın.");
    }
    var salt = new Uint8Array(saltHex.match(/.{2}/g).map(function (byte) {
      return parseInt(byte, 16);
    }));
    var keyMaterial = await window.crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    var bits = await window.crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
      keyMaterial,
      256
    );
    return bytesToHex(new Uint8Array(bits));
  }

  async function seedDemoUsers() {
    var users = await readAll("users");
    var demos = [
      { username: "gezgin", displayName: "Gezgin", bio: "Seyahat ve yeni yerler." },
      { username: "dansseven", displayName: "Dans Seven", bio: "Kısa akış demo profili." },
      { username: "mavi", displayName: "Mavi", bio: "Burada bir demo hesabı var." }
    ];

    for (var index = 0; index < demos.length; index += 1) {
      if (users.some(function (user) { return user.username === demos[index].username; })) continue;
      var saltBytes = new Uint8Array(16);
      window.crypto.getRandomValues(saltBytes);
      var salt = bytesToHex(saltBytes);
      await saveRecord("users", {
        id: randomId(),
        username: demos[index].username,
        displayName: demos[index].displayName,
        bio: demos[index].bio,
        salt: salt,
        passwordHash: await hashPassword(DEMO_PASSWORD, salt),
        following: [],
        friends: [],
        createdAt: Date.now()
      });
    }

    var refreshedUsers = await readAll("users");
    $("#demo-accounts").replaceChildren();
    refreshedUsers
      .filter(function (user) { return ["gezgin", "dansseven", "mavi"].includes(user.username); })
      .forEach(function (user) {
        var button = element("button", "demo-account-button", "@" + user.username);
        button.type = "button";
        button.addEventListener("click", function () {
          $("#username").value = user.username;
          $("#password").value = DEMO_PASSWORD;
          $("#password").focus();
          $("#demo-accounts").closest("details").open = false;
        });
        $("#demo-accounts").appendChild(button);
      });
  }

  function renderNavigation() {
    var pages = [
      { id: "feed", label: "Akış", icon: "⌂" },
      { id: "following", label: "Takip", icon: "↗" },
      { id: "discover", label: "Keşfet", icon: "⌕" },
      { id: "friends", label: "Arkadaşlar", icon: "♧" },
      { id: "messages", label: "Mesajlar", icon: "▤" },
      { id: "profile", label: "Profil", icon: "◉" }
    ];

    function populate(target, subset) {
      target.replaceChildren();
      subset.forEach(function (item) {
        var button = element("button", "nav-button" + (item.id === currentPage ? " active" : ""));
        button.type = "button";
        button.setAttribute("aria-current", item.id === currentPage ? "page" : "false");
        var icon = element("span", "nav-icon", item.icon);
        icon.setAttribute("aria-hidden", "true");
        button.append(icon, element("span", "", item.label));
        button.addEventListener("click", function () {
          openPage(item.id);
        });
        target.appendChild(button);
      });
    }

    populate($("#desktop-nav"), pages);
    populate($("#mobile-nav"), pages.filter(function (item) {
      return ["feed", "discover", "messages", "profile"].includes(item.id);
    }).map(function (item) {
      return item;
    }));

    var mobileNav = $("#mobile-nav");
    var upload = element("button", "nav-button");
    upload.type = "button";
    upload.setAttribute("aria-label", "Video paylaş");
    var uploadIcon = element("span", "nav-icon", "＋");
    uploadIcon.setAttribute("aria-hidden", "true");
    upload.append(uploadIcon, element("span", "", "Paylaş"));
    upload.addEventListener("click", chooseVideo);
    var messageButton = $$(".nav-button", mobileNav).filter(function (button) {
      return button.textContent.indexOf("Mesajlar") !== -1;
    })[0];
    if (messageButton) mobileNav.insertBefore(upload, messageButton);
  }

  function setAuthMode(createAccount) {
    var displayLabel = $("#display-name-label");
    displayLabel.classList.toggle("hidden", !createAccount);
    $("#display-name").disabled = !createAccount;
    $("#auth-title").textContent = createAccount ? "Hesabını oluştur." : "Akışa katıl.";
    $("#auth-submit").textContent = createAccount ? "Hesap oluştur" : "Giriş yap";
    $("#password").autocomplete = createAccount ? "new-password" : "current-password";
    $("#auth-switch").textContent = createAccount ? "Zaten hesabım var" : "Yeni hesap oluştur";
    $("#auth-error").textContent = "";
    $("#auth-form").dataset.mode = createAccount ? "register" : "login";
  }

  $("#auth-switch").addEventListener("click", function () {
    setAuthMode($("#auth-form").dataset.mode !== "register");
  });

  $("#auth-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var form = event.currentTarget;
    var username = storeFormText(form, "username").toLowerCase();
    var password = storeFormText(form, "password");
    var error = $("#auth-error");
    var submit = $("#auth-submit");
    error.textContent = "";

    if (!/^[a-z0-9_]{3,20}$/.test(username)) {
      error.textContent = "Kullanıcı adı 3-20 karakter olmalı; İngilizce harf, sayı veya _ kullan.";
      return;
    }
    if (password.length < 6 || password.length > 128) {
      error.textContent = "Şifre en az 6, en fazla 128 karakter olmalı.";
      return;
    }

    submit.disabled = true;
    var oldText = submit.textContent;
    submit.textContent = "Kontrol ediliyor…";

    try {
      var users = await readAll("users");
      var user = users.find(function (item) { return item.username === username; });
      if (form.dataset.mode === "register") {
        var displayName = storeFormText(form, "displayName");
        if (displayName.length < 2 || displayName.length > 32) {
          error.textContent = "Görünen ad 2-32 karakter olmalı.";
          return;
        }
        if (user) {
          error.textContent = "Bu kullanıcı adı bu cihazda zaten kayıtlı.";
          return;
        }
        var saltBytes = new Uint8Array(16);
        window.crypto.getRandomValues(saltBytes);
        var salt = bytesToHex(saltBytes);
        user = {
          id: randomId(),
          username: username,
          displayName: displayName,
          bio: "",
          salt: salt,
          passwordHash: await hashPassword(password, salt),
          following: [],
          friends: [],
          createdAt: Date.now()
        };
        await saveRecord("users", user);
      } else {
        if (!user || (await hashPassword(password, user.salt)) !== user.passwordHash) {
          error.textContent = "Kullanıcı adı veya şifre yanlış.";
          return;
        }
      }

      activeUser = user;
      window.localStorage.setItem(SESSION_KEY, activeUser.id);
      form.reset();
      openApplication();
    } catch (reason) {
      error.textContent = reason && reason.message ? reason.message : "Giriş tamamlanamadı. Yeniden deneyin.";
    } finally {
      submit.disabled = false;
      submit.textContent = oldText;
    }
  });

  function openApplication() {
    $("#auth-screen").classList.add("hidden");
    $("#app-screen").classList.remove("hidden");
    renderNavigation();
    openPage("feed");
  }

  function closeApplication() {
    activeUser = null;
    window.localStorage.removeItem(SESSION_KEY);
    $("#app-screen").classList.add("hidden");
    $("#auth-screen").classList.remove("hidden");
    setAuthMode(false);
    $("#username").focus();
  }

  $("#logout").addEventListener("click", closeApplication);

  function openPage(page, options) {
    currentPage = page;
    if (options && options.chatUserId) selectedChatUserId = options.chatUserId;
    if (options && options.profileId) selectedProfileUserId = options.profileId;
    else if (page === "profile") selectedProfileUserId = activeUser.id;
    renderNavigation();
    var host = $("#page");
    host.replaceChildren();
    host.scrollTop = 0;

    if (page === "upload") {
      chooseVideo();
      openPage("feed");
      return;
    }
    if (page === "messages") {
      renderMessages(host);
      return;
    }
    if (page === "discover" || page === "friends") {
      renderPeople(host, page === "friends");
      return;
    }
    if (page === "profile") {
      renderProfile(host, selectedProfileUserId || activeUser.id);
      return;
    }
    renderFeed(host, page === "following");
  }

  function pageHeader(title, subtitle, action) {
    var header = element("header", "page-heading");
    var texts = element("div");
    texts.append(element("h1", "", title), element("p", "page-subtitle", subtitle));
    header.appendChild(texts);
    if (action) header.appendChild(action);
    return header;
  }

  function emptyState(title, message, actionLabel, actionHandler) {
    var panel = element("section", "empty-state");
    panel.append(element("h2", "", title), element("p", "", message));
    if (actionLabel && actionHandler) {
      var action = element("button", "button button-primary", actionLabel);
      action.type = "button";
      action.addEventListener("click", actionHandler);
      panel.appendChild(action);
      action.style.marginTop = "15px";
    }
    return panel;
  }

  async function renderFeed(host, followingOnly) {
    var upload = element("button", "button button-primary", "＋ Video paylaş");
    upload.type = "button";
    upload.addEventListener("click", chooseVideo);
    var actions = element("div");
    actions.style.display = "flex";
    actions.style.flexWrap = "wrap";
    actions.style.gap = "8px";
    if (!followingOnly) {
      var following = element("button", "button", "Takip akışı");
      following.type = "button";
      following.addEventListener("click", function () { openPage("following"); });
      actions.appendChild(following);
    }
    actions.appendChild(upload);
    host.appendChild(pageHeader(
      followingOnly ? "Takip ettiklerin" : "Video akışı",
      followingOnly ? "Takip ettiğin demo hesaplarının paylaşımları." : "Bu tarayıcıda kaydedilen kısa videolar.",
      actions
    ));

    try {
      var allVideos = (await readAll("videos"))
        .filter(function (video) { return video.blob instanceof Blob; })
        .sort(function (first, second) { return second.createdAt - first.createdAt; });
      var users = await readAll("users");
      var userById = new Map(users.map(function (user) { return [user.id, user]; }));
      if (followingOnly) {
        allVideos = allVideos.filter(function (video) { return activeUser.following.includes(video.ownerId); });
      }
      allVideos = allVideos.filter(function (video) { return userById.has(video.ownerId); });
      if (allVideos.length === 0) {
        host.appendChild(emptyState(
          followingOnly ? "Takip akışı şimdilik boş" : "Burada henüz video yok",
          followingOnly ? "Keşfet bölümünden bir demo hesabını takip et veya videonu paylaş." : "Bilgisayarından ya da telefonundan bir video seçip bu cihaza ekleyebilirsin.",
          "İlk videonu paylaş",
          chooseVideo
        ));
        return;
      }
      var list = element("div", "video-list");
      host.appendChild(list);
      allVideos.forEach(function (video) {
        list.appendChild(createVideoCard(video, userById.get(video.ownerId)));
      });
    } catch (reason) {
      showToast("Videolar yüklenemedi: " + reason.message);
    }
  }

  function createVideoCard(video, owner) {
    var card = element("article", "video-card");
    var header = element("div", "video-header");
    var userButton = element("button", "user-chip");
    userButton.type = "button";
    userButton.addEventListener("click", function () { openPage("profile", { profileId: owner.id }); });
    userButton.append(element("span", "avatar avatar-small", initials(owner.displayName)));
    var name = element("span", "user-name-block");
    name.append(element("strong", "", owner.displayName), element("small", "", "@" + owner.username + " · " + formatDate(video.createdAt)));
    userButton.appendChild(name);
    header.appendChild(userButton);

    if (owner.id !== activeUser.id) {
      var follow = element("button", "button button-follow", activeUser.following.includes(owner.id) ? "Takipte" : "Takip et");
      follow.type = "button";
      follow.addEventListener("click", async function () {
        toggleFollowing(owner.id);
      });
      header.appendChild(follow);
    }

    var frame = element("div", "video-frame");
    var videoElement = element("video");
    videoElement.controls = true;
    videoElement.playsInline = true;
    videoElement.preload = "metadata";
    videoElement.setAttribute("aria-label", (video.caption || video.name) + " videosu");
    videoElement.src = URL.createObjectURL(video.blob);
    frame.appendChild(videoElement);

    var caption = element("p", "video-caption", video.caption || video.name || "Video");
    var actions = element("div", "video-actions");
    var liked = (video.likes || []).includes(activeUser.id);
    var like = element("button", "button" + (liked ? " button-liked" : ""), (liked ? "♥" : "♡") + "  " + (liked ? "Beğendin" : "Beğen") + " · " + (video.likes || []).length);
    like.type = "button";
    like.setAttribute("aria-pressed", String(liked));
    like.addEventListener("click", function () { toggleLike(video, liked); });
    actions.appendChild(like);
    if (owner.id !== activeUser.id) {
      var message = element("button", "button", "Mesaj");
      message.type = "button";
      message.addEventListener("click", function () { openPage("messages", { chatUserId: owner.id }); });
      actions.appendChild(message);
    }
    card.append(header, frame, caption, actions);
    return card;
  }

  function chooseVideo() {
    $("#video-input").click();
  }

  $("#upload-top").addEventListener("click", chooseVideo);
  $("#caption-cancel").addEventListener("click", function () {
    pendingVideoFile = null;
    $("#caption-dialog").close("cancel");
  });
  $("#caption-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    if (!pendingVideoFile) return;

    var file = pendingVideoFile;
    var caption = $("#video-caption-input").value.trim().slice(0, 240);
    pendingVideoFile = null;
    $("#caption-dialog").close("share");
    var saveButton = $("#upload-top");
    saveButton.disabled = true;
    try {
      await saveRecord("videos", {
        id: randomId(),
        ownerId: activeUser.id,
        caption: caption,
        name: file.name,
        type: file.type,
        blob: file,
        likes: [],
        createdAt: Date.now()
      });
      showToast("Video bu cihazdaki deneme akışına eklendi.");
      openPage("feed");
    } catch (reason) {
      showToast("Video kaydedilemedi. Telefonun veya tarayıcının boş depolama alanını kontrol et. " + reason.message);
    } finally {
      saveButton.disabled = false;
    }
  });
  $("#video-input").addEventListener("change", async function (event) {
    var input = event.currentTarget;
    var file = input.files && input.files[0];
    if (!file) return;
    input.value = "";

    if (!file.type || !file.type.startsWith("video/")) {
      showToast("Lütfen telefonundan veya bilgisayarından bir video dosyası seç.");
      return;
    }

    try {
      pendingVideoFile = file;
      $("#video-caption-input").value = "";
      $("#caption-dialog").showModal();
      $("#video-caption-input").focus();
    } catch (reason) {
      pendingVideoFile = null;
      showToast("Video paylaşma penceresi açılamadı: " + reason.message);
    }
  });

  async function toggleLike(video, wasLiked) {
    var likes = (video.likes || []).filter(function (id) { return id !== activeUser.id; });
    if (!wasLiked) likes.push(activeUser.id);
    video.likes = likes;
    try {
      await saveRecord("videos", video);
      openPage(currentPage);
    } catch (reason) {
      showToast("Beğeni kaydedilemedi: " + reason.message);
    }
  }

  async function toggleFollowing(userId) {
    var currentlyFollowing = activeUser.following.includes(userId);
    activeUser.following = activeUser.following.filter(function (id) { return id !== userId; });
    if (!currentlyFollowing) activeUser.following.push(userId);
    try {
      await saveRecord("users", activeUser);
      renderNavigation();
      showToast(currentlyFollowing ? "Takibi bıraktın." : "Kullanıcıyı takip ediyorsun.");
      openPage(currentPage);
    } catch (reason) {
      if (currentlyFollowing) activeUser.following.push(userId);
      else activeUser.following = activeUser.following.filter(function (id) { return id !== userId; });
      showToast("Takip bilgisi kaydedilemedi: " + reason.message);
    }
  }

  async function renderPeople(host, friendsOnly) {
    host.appendChild(pageHeader(
      friendsOnly ? "Arkadaşların" : "Kişileri keşfet",
      friendsOnly ? "Bu tarayıcıda eklediğin arkadaşların." : "Kullanıcı adını veya görünen adı yazıp demo kullanıcılarını bul."
    ));
    var search = element("input", "search-input");
    search.type = "search";
    search.placeholder = "Kullanıcı adını yaz…";
    search.maxLength = 32;
    search.setAttribute("aria-label", "Kullanıcı adına veya görünen ada göre ara");
    var searchWrap = element("div", "search-wrap");
    searchWrap.appendChild(search);
    host.appendChild(searchWrap);
    var list = element("div", "person-list");
    host.appendChild(list);

    async function refresh() {
      try {
        var query = search.value.trim().toLocaleLowerCase("tr");
        var users = (await readAll("users"))
          .filter(function (user) { return user.id !== activeUser.id; })
          .filter(function (user) {
            if (friendsOnly && !activeUser.friends.includes(user.id)) return false;
            return !query || (user.username + " " + user.displayName).toLocaleLowerCase("tr").includes(query);
          })
          .sort(function (a, b) { return a.displayName.localeCompare(b.displayName, "tr"); });
        list.replaceChildren();
        if (users.length === 0) {
          list.appendChild(emptyState(friendsOnly ? "Henüz arkadaş eklemedin" : "Kullanıcı bulunamadı",
            friendsOnly ? "Keşfet bölümünde kullanıcı adını aratıp arkadaş ekleyebilirsin." : "Başka bir kullanıcı adı deneyebilirsin."));
          return;
        }
        users.forEach(function (user) { list.appendChild(personCard(user)); });
      } catch (reason) {
        showToast("Kullanıcılar yüklenemedi: " + reason.message);
      }
    }
    search.addEventListener("input", refresh);
    await refresh();
  }

  function personCard(user) {
    var card = element("article", "person-card");
    var info = element("div", "person-info");
    info.appendChild(element("span", "avatar avatar-small", initials(user.displayName)));
    var names = element("div", "user-name-block");
    names.append(element("strong", "", user.displayName), element("small", "", "@" + user.username));
    names.appendChild(element("div", "person-bio", user.bio || "Henüz bir profil açıklaması yok."));
    info.appendChild(names);
    card.appendChild(info);

    var actions = element("div", "person-actions");
    var isFriend = activeUser.friends.includes(user.id);
    var friendButton = element("button", "button", isFriend ? "Arkadaşsınız ✓" : "Arkadaş ekle");
    friendButton.type = "button";
    friendButton.addEventListener("click", async function () { await toggleFriend(user); });
    actions.appendChild(friendButton);

    var followButton = element("button", "button", activeUser.following.includes(user.id) ? "Takiptesin" : "Takip et");
    followButton.type = "button";
    followButton.addEventListener("click", async function () { await toggleFollowing(user.id); });
    actions.appendChild(followButton);

    var messageButton = element("button", "button", "Mesaj");
    messageButton.type = "button";
    messageButton.addEventListener("click", function () { openPage("messages", { chatUserId: user.id }); });
    actions.appendChild(messageButton);
    card.appendChild(actions);

    var showProfile = function () { openPage("profile", { profileId: user.id }); };
    info.querySelector(".user-name-block").addEventListener("click", showProfile);
    info.querySelector(".user-name-block").style.cursor = "pointer";
    return card;
  }

  async function toggleFriend(user) {
    var alreadyFriends = activeUser.friends.includes(user.id);
    activeUser.friends = activeUser.friends.filter(function (id) { return id !== user.id; });
    if (!alreadyFriends) activeUser.friends.push(user.id);
    if (alreadyFriends) {
      user.friends = (user.friends || []).filter(function (id) { return id !== activeUser.id; });
    } else {
      user.friends = user.friends || [];
      if (!user.friends.includes(activeUser.id)) user.friends.push(activeUser.id);
    }

    try {
      await saveRecord("users", activeUser);
      await saveRecord("users", user);
      showToast(alreadyFriends ? "Arkadaş listesinden çıkarıldı." : "Arkadaş eklendi. Bu cihazdaki demo hesabı.");
      openPage(currentPage);
    } catch (reason) {
      showToast("Arkadaş bilgisi kaydedilemedi: " + reason.message);
    }
  }

  async function renderProfile(host, profileId) {
    var user = profileId && profileId !== activeUser.id
      ? (await readAll("users")).find(function (entry) { return entry.id === profileId; })
      : activeUser;
    if (!user) {
      host.appendChild(emptyState("Profil bulunamadı", "Kullanıcı artık mevcut değil."));
      return;
    }

    var users = await readAll("users");
    var videos = (await readAll("videos"))
      .filter(function (video) { return video.ownerId === user.id; })
      .sort(function (a, b) { return b.createdAt - a.createdAt; });
    var followers = users.filter(function (entry) { return entry.following.includes(user.id); }).length;

    var profile = element("section", "profile-card");
    var heading = element("div", "profile-heading");
    heading.appendChild(element("span", "avatar profile-avatar", initials(user.displayName)));
    var names = element("div");
    names.append(element("h1", "", user.displayName), element("p", "page-subtitle", "@" + user.username));
    heading.appendChild(names);
    profile.appendChild(heading);

    var stats = element("div", "profile-stats");
    [
      ["Video", videos.length],
      ["Takipçi", followers],
      ["Takip edilen", user.following.length],
      ["Arkadaş", user.friends.length]
    ].forEach(function (item) {
      var value = element("span");
      value.append(element("strong", "", String(item[1])), document.createTextNode(" " + item[0]));
      stats.appendChild(value);
    });
    profile.appendChild(stats);

    if (user.id === activeUser.id) {
      var label = element("label", "bio-editor", "Profil açıklaması");
      var textarea = element("textarea", "bio-input");
      textarea.maxLength = 240;
      textarea.placeholder = "Kendinden kısaca bahset…";
      textarea.value = user.bio || "";
      label.appendChild(textarea);
      profile.appendChild(label);

      var saveBio = element("button", "button button-primary", "Açıklamayı kaydet");
      saveBio.type = "button";
      saveBio.style.marginTop = "10px";
      saveBio.addEventListener("click", async function () {
        user.bio = textarea.value.trim();
        try {
          await saveRecord("users", user);
          activeUser = user;
          showToast("Profil açıklaması kaydedildi.");
        } catch (reason) {
          showToast("Profil kaydedilemedi: " + reason.message);
        }
      });
      profile.appendChild(saveBio);
    } else {
      var actions = element("div", "profile-actions");
      var follow = element("button", "button", activeUser.following.includes(user.id) ? "Takiptesin" : "Takip et");
      follow.type = "button";
      follow.addEventListener("click", async function () { await toggleFollowing(user.id); });
      var message = element("button", "button button-primary", "Mesaj gönder");
      message.type = "button";
      message.addEventListener("click", function () { openPage("messages", { chatUserId: user.id }); });
      actions.append(follow, message);
      profile.appendChild(actions);
    }
    host.append(pageHeader("Profil", "Profil bilgileri ve bu kullanıcı tarafından bu cihazda paylaşılan videolar."), profile);

    var videoList = element("div", "video-list");
    host.appendChild(videoList);
    if (videos.length === 0) {
      videoList.appendChild(emptyState("Henüz video yok", user.id === activeUser.id ? "Bir video paylaşınca burada görünür." : "Bu kullanıcının bu cihazda paylaşılmış videosu henüz yok."));
      return;
    }
    videos.forEach(function (video) { videoList.appendChild(createVideoCard(video, user)); });
  }

  function renderMessages(host) {
    host.appendChild(pageHeader("Mesajlar", "Bu tarayıcıdaki demo hesaplarıyla yerel sohbet denemesi."));
    var shell = element("section", "chat-shell");
    var contacts = element("div", "chat-contacts");
    var conversation = element("div", "chat-conversation");
    shell.append(contacts, conversation);
    host.appendChild(shell);

    Promise.all([readAll("users"), readAll("messages")]).then(function (results) {
      var users = results[0];
      var messages = results[1];
      var available = users.filter(function (user) {
        if (user.id === activeUser.id) return false;
        var thread = conversationId(activeUser.id, user.id);
        return activeUser.friends.includes(user.id) || messages.some(function (message) { return message.conversationId === thread; });
      });
      available.sort(function (a, b) {
        if (a.id === selectedChatUserId) return -1;
        if (b.id === selectedChatUserId) return 1;
        return a.displayName.localeCompare(b.displayName, "tr");
      });
      if (!available.some(function (user) { return user.id === selectedChatUserId; })) {
        selectedChatUserId = available.length ? available[0].id : null;
      }

      if (available.length === 0) {
        conversation.appendChild(element("div", "message-empty", "Henüz sohbetin yok. Keşfet sayfasında bir kullanıcı bulup önce arkadaş ekleyebilir veya mesaj gönderebilirsin."));
        return;
      }

      available.forEach(function (user) {
        var contact = element("button", "chat-contact" + (user.id === selectedChatUserId ? " active" : ""));
        contact.type = "button";
        contact.append(element("span", "avatar avatar-small", initials(user.displayName)), element("span", "user-name-block",
          user.displayName + " @" + user.username));
        contact.addEventListener("click", function () {
          selectedChatUserId = user.id;
          openPage("messages");
        });
        contacts.appendChild(contact);
      });

      var recipient = users.find(function (user) { return user.id === selectedChatUserId; });
      if (!recipient) return;

      conversation.appendChild(element("div", "chat-title", recipient.displayName + "  ·  @" + recipient.username));
      var listCard = element("div", "message-list-card");
      listCard.style.display = "flex";
      listCard.style.flex = "1";
      listCard.style.minHeight = "0";
      listCard.style.flexDirection = "column";
      var messageList = element("div", "message-list");
      listCard.appendChild(messageList);
      conversation.appendChild(listCard);

      var threadId = conversationId(activeUser.id, recipient.id);
      messages.filter(function (message) { return message.conversationId === threadId; })
        .sort(function (a, b) { return a.createdAt - b.createdAt; })
        .forEach(function (message) {
          var mine = message.senderId === activeUser.id;
          var bubble = element("div", "message-bubble" + (mine ? " mine" : ""));
          bubble.append(document.createTextNode(message.text), element("time", "message-time", formatTime(message.createdAt)));
          messageList.appendChild(bubble);
        });
      if (!messageList.children.length) {
        messageList.appendChild(element("div", "message-empty", "Bu sohbet bu cihazda henüz boş."));
      }
      messageList.scrollTop = messageList.scrollHeight;

      var composer = element("form", "message-compose");
      var input = element("input", "message-input");
      input.type = "text";
      input.name = "message";
      input.maxLength = 500;
      input.autocomplete = "off";
      input.placeholder = "Mesajını yaz…";
      input.setAttribute("aria-label", "Sohbet mesajı");
      var send = element("button", "button button-primary", "Gönder");
      send.type = "submit";
      composer.append(input, send);
      composer.addEventListener("submit", async function (event) {
        event.preventDefault();
        var text = input.value.trim();
        if (!text) return;
        send.disabled = true;
        try {
          await saveRecord("messages", {
            id: randomId(),
            conversationId: threadId,
            senderId: activeUser.id,
            recipientId: recipient.id,
            text: text,
            createdAt: Date.now()
          });
          openPage("messages");
        } catch (reason) {
          send.disabled = false;
          showToast("Mesaj kaydedilemedi: " + reason.message);
        }
      });
      conversation.appendChild(composer);
    }).catch(function (reason) {
      showToast("Mesajlar yüklenemedi: " + reason.message);
    });
  }

  document.addEventListener("click", function (event) {
    var link = event.target.closest("a[href^='#']");
    if (link) event.preventDefault();
  });

  window.addEventListener("storage", function (event) {
    if (event.key === SESSION_KEY && activeUser) closeApplication();
  });

  async function initialize() {
    try {
      if (!window.crypto || !window.crypto.subtle) {
        throw new Error("Bu tarayıcı güvenli şifrelemeyi desteklemiyor. Chrome veya Edge'in güncel sürümünü kullanın.");
      }
      db = await openDatabase();
      await seedDemoUsers();
      if ("serviceWorker" in navigator && /^https?:$/.test(window.location.protocol)) {
        navigator.serviceWorker.register("./sw.js").catch(function (reason) {
          console.warn("Uygulama çevrimdışı önbelleğe alınamadı:", reason);
        });
      }

      var savedId = window.localStorage.getItem(SESSION_KEY);
      if (savedId) {
        var users = await readAll("users");
        activeUser = users.find(function (user) { return user.id === savedId; });
        if (activeUser) {
          openApplication();
          return;
        }
        window.localStorage.removeItem(SESSION_KEY);
      }
      setAuthMode(false);
    } catch (reason) {
      $("#auth-error").textContent = reason && reason.message ? reason.message : "Uygulama başlatılamadı.";
    }
  }

  initialize();
}());
