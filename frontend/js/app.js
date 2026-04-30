/**
 * Alpine.js app — all state, routing, and view logic for the iCourse frontend.
 * References ICS.crypto, ICS.github, ICS.db, ICS.render globals.
 */

/* ── Gzip helpers (Compression Streams API) ── */
async function _gunzip(compressedBytes) {
  var ds = new DecompressionStream("gzip");
  var writer = ds.writable.getWriter();
  writer.write(compressedBytes);
  writer.close();
  var chunks = [];
  var reader = ds.readable.getReader();
  while (true) {
    var r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
  }
  var total = chunks.reduce(function(s, c) { return s + c.length; }, 0);
  var result = new Uint8Array(total);
  var offset = 0;
  for (var i = 0; i < chunks.length; i++) {
    result.set(chunks[i], offset);
    offset += chunks[i].length;
  }
  return result;
}

/* ── IndexedDB cache for decrypted shards (keyed by git blob sha) ────
   Shard contents are content-addressed: a shard's git blob sha changes
   only when its bytes change, so we can keep decrypted bytes around and
   skip the network + decrypt + decompress chain on subsequent loads.
*/
var _idbName = "ics_cache_v2";

function _idbOpen() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open(_idbName, 1);
    req.onupgradeneeded = function() { req.result.createObjectStore("blobs"); };
    req.onsuccess = function() { resolve(req.result); };
    req.onerror = function() { reject(req.error); };
  });
}

async function _idbGet(key) {
  var db = await _idbOpen();
  return new Promise(function(resolve) {
    var tx = db.transaction("blobs", "readonly");
    var req = tx.objectStore("blobs").get(key);
    req.onsuccess = function() { resolve(req.result || null); };
    req.onerror = function() { resolve(null); };
  });
}

async function _idbPut(key, value) {
  var db = await _idbOpen();
  return new Promise(function(resolve) {
    var tx = db.transaction("blobs", "readwrite");
    tx.objectStore("blobs").put(value, key);
    tx.oncomplete = function() { resolve(); };
    tx.onerror = function() { resolve(); };
  });
}

/* ── Credential helpers (localStorage) ── */
const _LS = "ics_";
const _loadCreds = () => { try { return JSON.parse(localStorage.getItem(_LS + "creds")); } catch { return null; } };
const _saveCreds = (c) => localStorage.setItem(_LS + "creds", JSON.stringify(c));
const _loadSettings = () => { try { return JSON.parse(localStorage.getItem(_LS + "settings")) || {}; } catch { return {}; } };
const _saveSettings = (s) => localStorage.setItem(_LS + "settings", JSON.stringify(s));

function _relativeTime(iso) {
  if (!iso) return "";
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const days = Math.floor(h / 24);
  if (days < 30) return days + "d ago";
  return new Date(iso).toLocaleDateString();
}

function _highlightSnippet(text, query, radius) {
  radius = radius || 60;
  if (!text || !query) return "";
  const plain = ICS.render.plainSnippet(text, 99999);
  const idx = plain.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return plain.slice(0, 120) + "...";
  const s = Math.max(0, idx - radius);
  const e = Math.min(plain.length, idx + query.length + radius);
  let snip = (s > 0 ? "..." : "") + plain.slice(s, e) + (e < plain.length ? "..." : "");
  const re = new RegExp("(" + query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
  return snip.replace(re, "<mark>$1</mark>");
}

/* ── Sharded loading helpers ── */
async function _loadShard(owner, repo, entry, password, token) {
  // Hit cache first; on miss download → decrypt → gunzip and store the
  // decompressed sqlite bytes (~4× compression ratio, well under IndexedDB
  // quota for typical class sizes).
  var cacheKey = "shard:" + entry.sha;
  var cached = await _idbGet(cacheKey);
  if (cached) return cached;

  var encBytes = await ICS.github.fetchBlobBytes(owner, repo, entry.sha, token);
  var gzipped = await ICS.crypto.decrypt(
    encBytes, password, ICS.crypto.NEW_ITERATIONS,
  );
  var dbBytes = await _gunzip(gzipped);
  await _idbPut(cacheKey, dbBytes);
  return dbBytes;
}

async function _loadFromShardManifest(manifest, owner, repo, password, token, progress) {
  // 1) Fetch + decrypt the index (small, never cached)
  var indexEnc = await ICS.github.fetchBlobBytes(
    owner, repo, manifest.index.sha, token,
  );
  var indexBytes = await ICS.crypto.decrypt(
    indexEnc, password, ICS.crypto.NEW_ITERATIONS,
  );
  var index = JSON.parse(new TextDecoder().decode(indexBytes));

  // 2) Pull every shard (cache hits short-circuit, so only changed shards
  //    actually download) and merge them into one in-memory DB.
  await ICS.db.initEmpty();
  var total = (index.shards || []).length;
  for (var i = 0; i < total; i++) {
    var shardMeta = index.shards[i];
    var entry = manifest.shards.find(function (s) { return s.name === shardMeta.name; });
    if (!entry) {
      console.warn("Shard listed in index but missing from tree:", shardMeta.name);
      continue;
    }
    if (progress) progress(i + 1, total, shardMeta.name);
    var shardBytes = await _loadShard(owner, repo, entry, password, token);
    await ICS.db.attachShard(shardBytes);
  }
}

async function _loadFromLegacyBlob(manifest, owner, repo, secrets, token) {
  // Single-file fallback for users still on the pre-shard data branch.
  var encBytes = await ICS.github.fetchBlobBytes(
    owner, repo, manifest.legacy.sha, token,
  );
  var fallback = await ICS.crypto.decryptWithFallback(encBytes, secrets);
  var bytes = fallback.data;
  if (manifest.legacy.compressed) {
    bytes = await _gunzip(bytes);
  }
  await ICS.db.initDB(bytes);
}

/* ── Alpine app ── */
document.addEventListener("alpine:init", () => {
  Alpine.data("app", () => ({
    view: "loading", error: null, loadingMsg: "",
    toast: null, toastType: "success",
    courses: [], lectures: [],
    currentCourse: null, currentLecture: null,
    searchQuery: "", searchResults: [],
    showTranscript: false,
    commitSha: null,
    setup: { token: "", stuid: "", uispsw: "", dashscope: "", smtp: "" },
    setupError: "", setupTesting: false,
    settingsForm: {}, showSecrets: {},
    exportDialogOpen: false, exportSelection: {}, exportingPdf: false,
    iterations: 100000, repoOwner: "", repoName: "", dataBranch: "data",
    _history: [],

    async init() {
      const detected = ICS.github.detectRepo();
      const s = _loadSettings();
      this.repoOwner = s.owner || (detected?.owner ?? "");
      this.repoName = s.repo || (detected?.repo ?? "");
      this.dataBranch = s.branch || "data";
      this.iterations = s.iterations || 100000;
      const creds = _loadCreds();
      if (!creds) { this.view = "setup"; return; }
      await this._loadDB(creds);
    },

    async _loadDB(creds) {
      this.view = "loading"; this.error = null;
      try {
        this.loadingMsg = "Checking for updates...";
        var manifest = await ICS.github.fetchShardManifest(
          this.repoOwner, this.repoName, this.dataBranch, creds.token,
        );
        this.commitSha = manifest.commitSha;

        if (manifest.format === "sharded") {
          var pw = await ICS.crypto.buildPasswordV2(creds);
          var self = this;
          await _loadFromShardManifest(
            manifest, this.repoOwner, this.repoName, pw, creds.token,
            function (i, n, name) {
              self.loadingMsg = "Loading shard " + i + "/" + n + " (" + name + ")...";
            },
          );
        } else {
          this.loadingMsg = "Loading legacy database...";
          await _loadFromLegacyBlob(
            manifest, this.repoOwner, this.repoName, creds, creds.token,
          );
        }

        this.courses = ICS.db.getCourses();
        this.view = "courses";
      } catch (e) {
        this.error = e.message;
        this.view = "error";
      }
    },

    navigate(view, params) {
      params = params || {};
      this._history.push({ view: this.view, courseId: this.currentCourse?.course_id, lectureId: this.currentLecture?.sub_id });
      this._go(view, params);
    },
    _go(view, params) {
      params = params || {};
      this.error = null;
      if (view === "courses") { this.courses = ICS.db.getCourses(); }
      else if (view === "lectures" && params.courseId) {
        this.currentCourse = this.courses.find(x => x.course_id === params.courseId) || { course_id: params.courseId, title: "...", teacher: "" };
        this.lectures = ICS.db.getLectures(params.courseId);
      }
      else if (view === "detail" && params.subId) { this.currentLecture = ICS.db.getLecture(params.subId); this.showTranscript = false; }
      this.view = view;
      if (view !== "lectures") this.exportDialogOpen = false;
    },
    goBack() {
      const p = this._history.pop();
      if (p) this._go(p.view, { courseId: p.courseId, subId: p.lectureId });
      else this._go("courses");
    },

    openCourse(id) { this.navigate("lectures", { courseId: id }); },
    openLecture(id) { this.navigate("detail", { subId: id }); },

    // Editing (manual summary edits) was retired when the data branch moved
    // to a sharded layout — the frontend can no longer push back a single
    // monolithic encrypted DB, and the workflow is the source of truth.
    // Stubs keep the existing buttons in the template from throwing until
    // subproject D removes them entirely.
    editText: "", editPreview: false, saving: false,
    startEdit() { this._toast("摘要编辑已下线，请等待新版前端", "error"); },
    cancelEdit() { this.goBack(); },
    saveEdit() { this._toast("摘要编辑已下线", "error"); },

    getExportableLectures() {
      return (this.lectures || []).filter((lec) => lec.summary && lec.summary.trim());
    },
    openExportDialog() {
      const list = this.getExportableLectures();
      if (!list.length) { this._toast("No summarized lectures to export", "error"); return; }
      this.exportSelection = {};
      list.forEach((lec) => { this.exportSelection[lec.sub_id] = true; });
      this.exportDialogOpen = true;
    },
    closeExportDialog() {
      if (this.exportingPdf) return;
      this.exportDialogOpen = false;
    },
    isLectureSelected(subId) { return !!this.exportSelection[subId]; },
    toggleLectureSelection(subId, checked) { this.exportSelection[subId] = !!checked; },
    setExportAll(checked) {
      this.getExportableLectures().forEach((lec) => { this.exportSelection[lec.sub_id] = !!checked; });
    },
    isExportAllSelected() {
      const list = this.getExportableLectures();
      return list.length > 0 && list.every((lec) => this.exportSelection[lec.sub_id]);
    },
    selectedExportCount() {
      return this.getExportableLectures().filter((lec) => this.exportSelection[lec.sub_id]).length;
    },
    async exportSelectedToPdf() {
      // Triggers .github/workflows/export.yml via workflow_dispatch.  The
      // workflow runs scripts/export_course.py (WeasyPrint) and emails the
      // PDF to RECEIVER_EMAIL — same output and same code path as a manual
      // run from the Actions UI.  We dropped the in-browser html2pdf.js
      // approach because the screenshot-based pipeline produced blank PDFs
      // unreliably; routing through Actions reuses the working tech stack.
      if (this.exportingPdf) return;
      const selected = this.getExportableLectures().filter(
        (lec) => this.exportSelection[lec.sub_id]
      );
      if (!selected.length) {
        this._toast("Please select at least one lecture", "error");
        return;
      }
      const creds = _loadCreds();
      if (!creds?.token) {
        this._toast("Not authenticated", "error");
        return;
      }
      this.exportingPdf = true;
      try {
        const subIds = selected.map((lec) => String(lec.sub_id)).join(",");
        // Workflow files live on the default branch (main).  Surfaced as a
        // hardcoded "main" for now; expose as a setting if users rename it.
        await ICS.github.triggerExportWorkflow(
          this.repoOwner, this.repoName, "main", creds.token,
          this.currentCourse.course_id, true, subIds
        );
        this.exportDialogOpen = false;
        this._toast(
          "已触发后台导出，PDF 将在 1-3 分钟内发送到 RECEIVER_EMAIL",
          "success"
        );
      } catch (e) {
        this._toast(e?.message || "Export failed", "error");
      } finally {
        this.exportingPdf = false;
      }
    },

    _searchTimeout: null,
    doSearch() {
      clearTimeout(this._searchTimeout);
      this._searchTimeout = setTimeout(() => {
        this.searchResults = this.searchQuery.trim() ? ICS.db.searchSummaries(this.searchQuery) : [];
      }, 300);
    },

    async refresh() {
      const c = _loadCreds();
      if (c) { await this._loadDB(c); this._toast("Refreshed", "success"); }
    },

    async testAndSave() {
      this.setupTesting = true; this.setupError = "";
      try {
        var manifest = await ICS.github.fetchShardManifest(
          this.repoOwner, this.repoName, this.dataBranch, this.setup.token,
        );
        if (manifest.format === "sharded") {
          // Probe the index decryption to validate creds before we save.
          var pw = await ICS.crypto.buildPasswordV2(this.setup);
          var indexEnc = await ICS.github.fetchBlobBytes(
            this.repoOwner, this.repoName, manifest.index.sha, this.setup.token,
          );
          await ICS.crypto.decrypt(indexEnc, pw, ICS.crypto.NEW_ITERATIONS);
        } else {
          var encBytes = await ICS.github.fetchBlobBytes(
            this.repoOwner, this.repoName, manifest.legacy.sha, this.setup.token,
          );
          await ICS.crypto.decryptWithFallback(encBytes, this.setup);
        }
        _saveCreds({ ...this.setup });
        _saveSettings({ owner: this.repoOwner, repo: this.repoName, branch: this.dataBranch, iterations: this.iterations });
        this.commitSha = manifest.commitSha;
        await this._loadDB({ ...this.setup });
      } catch (e) { this.setupError = e.message; }
      finally { this.setupTesting = false; }
    },

    openSettings() {
      this.settingsForm = { ...(_loadCreds() || {}) };
      this.showSecrets = {};
      this.navigate("settings");
    },
    async saveSettingsAndReload() {
      _saveCreds({ ...this.settingsForm });
      _saveSettings({ owner: this.repoOwner, repo: this.repoName, branch: this.dataBranch, iterations: this.iterations });
      this._toast("Saved. Reloading...", "success");
      const c = _loadCreds();
      if (c) await this._loadDB(c);
    },
    clearAllData() {
      if (!confirm("Clear all saved credentials?")) return;
      localStorage.removeItem(_LS + "creds");
      localStorage.removeItem(_LS + "settings");
      indexedDB.deleteDatabase(_idbName);
      this.view = "setup";
      this.setup = { token: "", stuid: "", uispsw: "", dashscope: "", smtp: "" };
    },

    _toast(msg, type) {
      this.toast = msg; this.toastType = type || "success";
      setTimeout(() => { this.toast = null; }, 3000);
    },

    // Template helpers
    renderMd(s) { return ICS.render.renderMarkdown(s); },
    activateKaTeX(el) { ICS.render.activateKaTeX(el); },
    snippet(s, n) { return ICS.render.plainSnippet(s, n); },
    highlight(text, q) { return _highlightSnippet(text, q); },
    relTime(s) { return _relativeTime(s); },
  }));
});
