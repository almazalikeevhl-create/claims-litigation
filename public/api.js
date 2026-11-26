/*
 * Хранилище данных сайта.
 * Предоставляет window.claude.use("db" | "user" | "assets") с тем же интерфейсом,
 * что и опубликованная на claude.ai версия.
 *
 * Два режима:
 *  - «сервер»: сайт открыт через server.ps1 — общая база для всех сотрудников,
 *    изменения коллег подтягиваются опросом раз в 2 секунды;
 *  - «демо в браузере»: сервера нет (например, GitHub Pages) — записи хранятся
 *    в localStorage, документы в IndexedDB этого браузера; при первом открытии
 *    загружаются демонстрационные дела из demo-seed.json.
 */
(function () {
  "use strict";
  var POLL_MS = 2000;
  var ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
  var LS_KEY = "pir-local-db-v1";
  var BLOB_TYPES = ["application/pdf", "image/jpeg", "image/png"];
  var MAX_BLOB = 20 * 1048576;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function rid(n) {
    var a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", s = "";
    var r = new Uint8Array(n || 20);
    window.crypto.getRandomValues(r);
    for (var i = 0; i < r.length; i++) s += a[r[i] % a.length];
    return s;
  }
  function err(code, msg) { var e = new Error(msg || code); e.code = code; return e; }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  /* ---------- текущий сотрудник ---------- */
  var uid = lsGet("pir-uid");
  if (!uid || !ID_RE.test(uid)) { uid = "u" + rid(16); lsSet("pir-uid", uid); }

  /* ---------- общее: состояние и подписчики ---------- */
  var state = { rev: null, cols: {} };
  var listeners = []; // {col, cb}
  function emit(col) {
    listeners.forEach(function (l) {
      if (col && l.col !== col) return;
      var docs = state.cols[l.col] || {};
      var snap = {
        metadata: { fromCache: false },
        docs: Object.keys(docs).map(function (id) {
          var d = docs[id];
          return { id: id, exists: true, data: function () { return clone(d); } };
        })
      };
      try { l.cb(snap); } catch (e) { console.error(e); }
    });
  }

  /* =====================================================================
   * Бэкенд «сервер» (server.ps1)
   * ===================================================================== */
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
  var polling = false, timer = null;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      var s = await req("GET", "/api/state?rev=" + encodeURIComponent(state.rev == null ? "" : state.rev));
      if (s && !s.same && s.cols) { state.rev = s.rev; state.cols = s.cols; emit(); }
    } catch (e) { /* сеть пропала — попробуем на следующем тике */ }
    finally { polling = false; }
  }
  var server = {
    connect: async function () {
      if (location.protocol === "file:") return false;
      await poll();
      if (state.rev == null) return false;
      timer = setInterval(poll, POLL_MS);
      document.addEventListener("visibilitychange", function () { if (!document.hidden) poll(); });
      return true;
    },
    get: async function (col, id) { var d = await req("GET", "/api/doc/" + col + "/" + id); return d && d.exists ? d.data : null; },
    put: async function (col, id, body) { await req("PUT", "/api/doc/" + col + "/" + id, body); poll(); },
    del: async function (col, id) { await req("DELETE", "/api/doc/" + col + "/" + id); poll(); },
    upload: async function (file, type) { return await req("POST", "/api/blob", file, { "X-Content-Type": type }); },
    unblob: async function (id) { await req("DELETE", "/api/blob/" + id); }
  };

  /* =====================================================================
   * Бэкенд «демо в браузере» (localStorage + IndexedDB)
   * ===================================================================== */
  function loadLocal() {
    var raw = lsGet(LS_KEY);
    var s = null;
    try { s = raw ? JSON.parse(raw) : null; } catch (e) {}
    if (!s || typeof s !== "object" || !s.cols) return null;
    ["cases", "notices", "files", "users"].forEach(function (c) { if (!s.cols[c] || typeof s.cols[c] !== "object") s.cols[c] = {}; });
    return s;
  }
  function saveLocal() {
    state.rev = String(Date.now());
    if (!lsSet(LS_KEY, JSON.stringify(state))) throw err("quota_exceeded", "Хранилище браузера заполнено");
  }
  var idb = null;
  function openIdb() {
    if (idb) return idb;
    idb = new Promise(function (res, rej) {
      if (!window.indexedDB) { rej(err("unavailable")); return; }
      var r = indexedDB.open("pir-files", 1);
      r.onupgradeneeded = function () { r.result.createObjectStore("blobs"); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(err("unavailable")); };
    });
    return idb;
  }
  async function idbDo(mode, fn) {
    var dbh = await openIdb();
    return new Promise(function (res, rej) {
      var tx = dbh.transaction("blobs", mode), st = tx.objectStore("blobs"), out;
      var r = fn(st);
      if (r) r.onsuccess = function () { out = r.result; };
      tx.oncomplete = function () { res(out); };
      tx.onerror = tx.onabort = function () { rej(err(tx.error && tx.error.name === "QuotaExceededError" ? "quota_or_state" : "unavailable")); };
    });
  }
  var local = {
    connect: async function () {
      var s = loadLocal();
      if (!s) {
        s = { rev: null, cols: { cases: {}, notices: {}, files: {}, users: {} } };
        try {
          var r = await fetch("demo-seed.json", { cache: "no-store" });
          if (r.ok) { var seed = await r.json(); if (seed && seed.cases) s.cols.cases = seed.cases; }
        } catch (e) { /* без примеров */ }
      }
      state.cols = s.cols;
      saveLocal();
      // изменения в другой вкладке этого браузера
      window.addEventListener("storage", function (e) {
        if (e.key !== LS_KEY) return;
        var n = loadLocal(); if (n) { state.rev = n.rev; state.cols = n.cols; emit(); }
      });
      // ссылки на документы открываем из IndexedDB
      document.addEventListener("click", function (e) {
        var a = e.target.closest && e.target.closest('a[href^="/_blob/"]');
        if (!a) return;
        e.preventDefault();
        var id = a.getAttribute("href").slice(7);
        var w = window.open("", "_blank");
        idbDo("readonly", function (st) { return st.get(id); }).then(function (rec) {
          if (!rec || !rec.blob) { if (w) w.close(); alert("Файл не найден в этом браузере."); return; }
          var url = URL.createObjectURL(rec.blob);
          if (w) w.location.href = url; else location.href = url;
          setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        }).catch(function () { if (w) w.close(); });
      }, true);
      return true;
    },
    get: async function (col, id) { var d = (state.cols[col] || {})[id]; return d ? clone(d) : null; },
    put: async function (col, id, body) {
      var prev = state.cols[col][id];
      state.cols[col][id] = clone(body);
      try { saveLocal(); } catch (e) { if (prev === undefined) delete state.cols[col][id]; else state.cols[col][id] = prev; throw e; }
      emit(col);
    },
    del: async function (col, id) { delete state.cols[col][id]; saveLocal(); emit(col); },
    upload: async function (file, type) {
      var id = rid(24);
      await idbDo("readwrite", function (st) { return st.put({ blob: file.slice(0, file.size, type), type: type }, id); });
      return { id: id, contentType: type, sizeBytes: file.size };
    },
    unblob: async function (id) { await idbDo("readwrite", function (st) { return st.delete(id); }); }
  };

  /* =====================================================================
   * Общий интерфейс
   * ===================================================================== */
  var B = null;
  function docRef(col, id) {
    if (!ID_RE.test(col)) throw err("invalid_argument", "Некорректная коллекция");
    id = id || rid(20);
    if (!ID_RE.test(id)) throw err("invalid_argument", "Некорректный идентификатор");
    return {
      id: id,
      get: async function () { var d = await B.get(col, id); return { id: id, exists: !!d, data: function () { return d; } }; },
      set: async function (body) { await B.put(col, id, body); },
      update: async function (patch) {
        var cur = await B.get(col, id);
        if (!cur) throw err("not_found", "Запись не найдена");
        await B.put(col, id, Object.assign({}, cur, patch));
      },
      delete: async function () { await B.del(col, id); }
    };
  }
  var db = {
    collection: function (col) {
      return {
        doc: function (id) { return docRef(col, id); },
        onSnapshot: function (cb) {
          var l = { col: col, cb: cb };
          listeners.push(l);
          if (state.rev != null) emit(col);
          return function () { listeners = listeners.filter(function (x) { return x !== l; }); };
        }
      };
    }
  };
  var user = {
    id: async function () { return uid; },
    can: async function () { return true; },
    profiles: async function (ids) {
      var users = state.cols.users || {}, out = {};
      ids.forEach(function (id) { if (users[id] && users[id].name) out[id] = { name: users[id].name }; });
      return out;
    }
  };
  var assets = {
    upload: async function (file, opt) {
      var type = (opt && opt.type) || file.type || "application/octet-stream";
      if (BLOB_TYPES.indexOf(type) < 0) throw err("unsupported_type");
      if (file.size > MAX_BLOB) throw err("too_large");
      return await B.upload(file, type);
    },
    delete: async function (id) {
      if (!ID_RE.test(id)) throw err("invalid_argument");
      await B.unblob(id);
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
      try { await B.put("users", uid, { name: name, updatedAt: new Date().toISOString() }); } catch (e) {}
    };
    inp.addEventListener("change", save);
    if (inp.value) save();
  }

  var ready = null;
  function connect() {
    if (!ready) {
      ready = (async function () {
        if (await server.connect()) { B = server; }
        else if (await local.connect()) { B = local; window.claude.browserMode = true; }
        else throw err("unavailable");
        bindName();
      })();
      ready.catch(function () {});
    }
    return ready;
  }

  window.claude = {
    browserMode: false,
    use: async function (name) {
      await connect();
      if (name === "db") return db;
      if (name === "user") return user;
      if (name === "assets") return assets;
      throw err("unknown_capability");
    }
  };
})();
