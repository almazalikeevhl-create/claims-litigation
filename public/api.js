/*
 * Клиент локального сервера реестра.
 * Предоставляет window.claude.use("db" | "user" | "assets") с тем же интерфейсом,
 * что и опубликованная версия сайта, но поверх REST API сервера server.ps1.
 * Изменения других пользователей подтягиваются опросом сервера раз в 2 секунды.
 */
(function () {
  "use strict";
  var POLL_MS = 2000;
  var ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function rid(n) {
    var a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", s = "";
    var r = new Uint8Array(n || 20);
    (window.crypto || window.msCrypto).getRandomValues(r);
    for (var i = 0; i < r.length; i++) s += a[r[i] % a.length];
    return s;
  }
  function err(code, msg) { var e = new Error(msg || code); e.code = code; return e; }

  /* ---------- текущий сотрудник ---------- */
  var uid = lsGet("pir-uid");
  if (!uid || !ID_RE.test(uid)) { uid = "u" + rid(16); lsSet("pir-uid", uid); }

  /* ---------- состояние и опрос ---------- */
  var state = { rev: null, cols: {} };
  var listeners = []; // {col, cb}
  var polling = false, timer = null;

  async function req(method, url, body, headers) {
    var opt = { method: method, headers: Object.assign({ "X-User": uid }, headers || {}) };
    if (body !== undefined) {
      if (body instanceof Blob) opt.body = body;
      else { opt.body = JSON.stringify(body); opt.headers["Content-Type"] = "application/json; charset=utf-8"; }
    }
    var r;
    try { r = await fetch(url, opt); } catch (e) { throw err("unavailable", "Сервер недоступен"); }
    var txt = await r.text();
    var data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch (e) {}
    if (!r.ok) throw err((data && data.code) || "http_" + r.status, data && data.message);
    return data;
  }

  function emit(col) {
    listeners.forEach(function (l) {
      if (col && l.col !== col) return;
      var docs = state.cols[l.col] || {};
      var snap = {
        metadata: { fromCache: false },
        docs: Object.keys(docs).map(function (id) {
          var d = docs[id];
          return { id: id, exists: true, data: function () { return JSON.parse(JSON.stringify(d)); } };
        })
      };
      try { l.cb(snap); } catch (e) { console.error(e); }
    });
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      var s = await req("GET", "/api/state?rev=" + encodeURIComponent(state.rev == null ? "" : state.rev));
      if (s && !s.same) {
        state.rev = s.rev;
        state.cols = s.cols || {};
        emit();
      }
    } catch (e) {
      /* сеть пропала — попробуем на следующем тике */
    } finally {
      polling = false;
    }
  }
  function startPolling() {
    if (timer) return;
    timer = setInterval(poll, POLL_MS);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) poll(); });
  }

  /* ---------- db ---------- */
  function docRef(col, id) {
    if (!ID_RE.test(col)) throw err("invalid_argument", "Некорректная коллекция");
    id = id || rid(20);
    if (!ID_RE.test(id)) throw err("invalid_argument", "Некорректный идентификатор");
    var url = "/api/doc/" + col + "/" + id;
    return {
      id: id,
      get: async function () {
        var d = await req("GET", url);
        return { id: id, exists: !!(d && d.exists), data: function () { return d && d.data; } };
      },
      set: async function (body) { await req("PUT", url, body); poll(); },
      update: async function (patch) {
        var cur = await req("GET", url);
        if (!cur || !cur.exists) throw err("not_found", "Запись не найдена");
        await req("PUT", url, Object.assign({}, cur.data, patch));
        poll();
      },
      delete: async function () { await req("DELETE", url); poll(); }
    };
  }
  var db = {
    collection: function (col) {
      return {
        doc: function (id) { return docRef(col, id); },
        onSnapshot: function (cb, onErr) {
          var l = { col: col, cb: cb };
          listeners.push(l);
          if (state.rev != null) emit(col);
          return function () { listeners = listeners.filter(function (x) { return x !== l; }); };
        }
      };
    }
  };

  /* ---------- user ---------- */
  var user = {
    id: async function () { return uid; },
    can: async function () { return true; },
    profiles: async function (ids) {
      var users = state.cols.users || {}, out = {};
      ids.forEach(function (id) { if (users[id] && users[id].name) out[id] = { name: users[id].name }; });
      return out;
    }
  };

  /* ---------- assets ---------- */
  var assets = {
    upload: async function (file, opt) {
      var type = (opt && opt.type) || file.type || "application/octet-stream";
      if (["application/pdf", "image/jpeg", "image/png"].indexOf(type) < 0) throw err("unsupported_type");
      if (file.size > 20 * 1048576) throw err("too_large");
      return await req("POST", "/api/blob", file, { "X-Content-Type": type });
    },
    delete: async function (id) {
      if (!ID_RE.test(id)) throw err("invalid_argument");
      await req("DELETE", "/api/blob/" + id);
    }
  };

  /* ---------- поле «Сотрудник» в шапке ---------- */
  function bindName() {
    var inp = document.getElementById("me");
    if (!inp) return;
    inp.value = lsGet("pir-name") || "";
    var save = async function () {
      var name = inp.value.trim();
      lsSet("pir-name", name);
      try { await req("PUT", "/api/doc/users/" + uid, { name: name, updatedAt: new Date().toISOString() }); poll(); } catch (e) {}
    };
    inp.addEventListener("change", save);
    if (inp.value) save();
    else setTimeout(function () { inp.focus(); }, 300);
  }

  var ready = null;
  function connect() {
    if (!ready) {
      ready = (async function () {
        if (location.protocol === "file:") throw err("unavailable");
        await poll();
        if (state.rev == null) throw err("unavailable");
        startPolling();
        bindName();
      })();
      ready.catch(function () {});
    }
    return ready;
  }

  window.claude = {
    use: async function (name) {
      await connect();
      if (name === "db") return db;
      if (name === "user") return user;
      if (name === "assets") return assets;
      throw err("unknown_capability");
    }
  };
})();
