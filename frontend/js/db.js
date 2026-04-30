/**
 * sql.js wrapper — load lecture data from sharded encrypted shards.
 *
 * In the sharded layout (current), each shard is a self-contained sqlite
 * file holding only the courses + lectures + ppt_pages rows for the courses
 * it owns. The page reassembles them in-memory by copying every shard's
 * rows into a single working SQL.Database. This avoids ATTACH'ing across
 * sql.js DB instances — sql.js doesn't support cross-file ATTACH cleanly,
 * and the row-count is small enough that copying is instantaneous.
 */

window.ICS = window.ICS || {};

const _SQL_CDN = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.12.0";
let _db = null;
let _SQL = null;

const _SCHEMA = `
CREATE TABLE IF NOT EXISTS courses (
    course_id TEXT PRIMARY KEY,
    title TEXT,
    teacher TEXT
);
CREATE TABLE IF NOT EXISTS lectures (
    sub_id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL,
    sub_title TEXT, date TEXT,
    transcript TEXT, summary TEXT,
    processed_at TEXT, emailed_at TEXT,
    error_msg TEXT, error_count INTEGER DEFAULT 0,
    error_stage TEXT, summary_model TEXT,
    summary_format_version INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ppt_pages (
    sub_id TEXT NOT NULL,
    page_num INTEGER NOT NULL,
    created_sec INTEGER NOT NULL,
    pptimgurl TEXT,
    text TEXT,
    ocr_status TEXT NOT NULL DEFAULT 'pending',
    ocr_at TEXT,
    PRIMARY KEY (sub_id, page_num)
);
`;

async function _ensureSqlJs() {
  if (_SQL) return _SQL;
  _SQL = await window.initSqlJs({
    locateFile: (file) => `${_SQL_CDN}/${file}`,
  });
  return _SQL;
}

async function _initFromBytes(dbBytes) {
  // Legacy path — accepts a single monolithic sqlite file.
  // Kept so older deployments (pre-shard data branch) still load.
  const SQL = await _ensureSqlJs();
  _db = dbBytes ? new SQL.Database(dbBytes) : new SQL.Database();
  if (!dbBytes) _db.exec(_SCHEMA);
}

async function _initEmpty() {
  const SQL = await _ensureSqlJs();
  _db = new SQL.Database();
  _db.exec(_SCHEMA);
}

function _copyRows(src, dst, table) {
  const result = src.exec(`SELECT * FROM ${table}`);
  if (!result.length || !result[0].values.length) return;
  const cols = result[0].columns;
  const placeholders = cols.map(() => "?").join(",");
  const stmt = dst.prepare(
    `INSERT OR IGNORE INTO ${table} (${cols.join(",")}) VALUES (${placeholders})`
  );
  for (const row of result[0].values) {
    stmt.bind(row);
    stmt.step();
    stmt.reset();
  }
  stmt.free();
}

async function _attachShard(shardBytes) {
  if (!_db) throw new Error("Database not initialized");
  const SQL = await _ensureSqlJs();
  const shard = new SQL.Database(shardBytes);
  try {
    _copyRows(shard, _db, "courses");
    _copyRows(shard, _db, "lectures");
    _copyRows(shard, _db, "ppt_pages");
  } finally {
    shard.close();
  }
}

function _deriveState(row) {
  if (row.error_stage) return "failed";
  if (row.summary && row.processed_at) return "ready";
  if (row.transcript && !row.summary) return "processing";
  return "waiting";
}

function _queryAll(sql, params) {
  if (!_db) return [];
  const stmt = _db.prepare(sql);
  if (params) stmt.bind(params);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function _getCourses() {
  return _queryAll(`
    SELECT c.course_id, c.title, c.teacher,
           COUNT(CASE WHEN l.summary IS NOT NULL THEN 1 END) AS summary_count,
           COUNT(l.sub_id) AS total_count,
           MAX(l.processed_at) AS last_updated
    FROM courses c
    LEFT JOIN lectures l ON c.course_id = l.course_id
    GROUP BY c.course_id
    ORDER BY last_updated DESC NULLS LAST
  `);
}

function _getLectures(courseId) {
  const rows = _queryAll(`
    SELECT sub_id, sub_title, date, summary, processed_at,
           error_stage, error_msg, summary_model, transcript
    FROM lectures WHERE course_id = ? ORDER BY sub_id ASC
  `, [courseId]);
  return rows.map((r) => {
    r.state = _deriveState(r);
    delete r.transcript;
    return r;
  });
}

function _getLecture(subId) {
  const rows = _queryAll(`
    SELECT l.*, c.title AS course_title, c.teacher
    FROM lectures l JOIN courses c ON l.course_id = c.course_id
    WHERE l.sub_id = ?
  `, [subId]);
  if (!rows.length) return null;
  rows[0].state = _deriveState(rows[0]);
  return rows[0];
}

function _getPptPages(subId) {
  // Only return done pages with non-empty text — keeps the PPT viewer
  // free of pending placeholders and dropped pages.
  return _queryAll(`
    SELECT page_num, created_sec, text
    FROM ppt_pages
    WHERE sub_id = ? AND ocr_status = 'done'
      AND text IS NOT NULL AND text != ''
    ORDER BY created_sec ASC
  `, [subId]);
}

function _searchSummaries(query) {
  if (!query?.trim()) return [];
  return _queryAll(`
    SELECT l.sub_id, l.sub_title, l.summary, l.course_id, c.title AS course_title
    FROM lectures l JOIN courses c ON l.course_id = c.course_id
    WHERE l.summary LIKE '%' || ? || '%' OR l.sub_title LIKE '%' || ? || '%'
    ORDER BY l.processed_at DESC LIMIT 50
  `, [query, query]);
}

window.ICS.db = {
  initDB: _initFromBytes,
  initEmpty: _initEmpty,
  attachShard: _attachShard,
  getCourses: _getCourses,
  getLectures: _getLectures,
  getLecture: _getLecture,
  getPptPages: _getPptPages,
  searchSummaries: _searchSummaries,
};
