#!/usr/bin/env python3
"""Merge local DB into remote DB (additive-only).

Used at deploy time to safely combine results from concurrent workflow runs.
For each lecture row, fields only progress forward (null -> non-null).
"""

import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.data.schema import (
    LECTURES_MIGRATION_COLUMNS,
    PPT_PAGES_MIGRATION_COLUMNS,
    SCHEMA_SQL,
)


def _ensure_schema(conn: sqlite3.Connection):
    """Create tables and migration columns if missing in remote DB."""
    conn.executescript(SCHEMA_SQL)
    existing_lectures = {r[1] for r in conn.execute("PRAGMA table_info(lectures)")}
    for col, typedef in LECTURES_MIGRATION_COLUMNS:
        if col not in existing_lectures:
            conn.execute(f"ALTER TABLE lectures ADD COLUMN {col} {typedef}")

    existing_ppt = {r[1] for r in conn.execute("PRAGMA table_info(ppt_pages)")}
    for col, typedef in PPT_PAGES_MIGRATION_COLUMNS:
        if col not in existing_ppt:
            conn.execute(f"ALTER TABLE ppt_pages ADD COLUMN {col} {typedef}")


def merge(local_path: str, remote_path: str):
    """Merge local changes into remote DB.  Only adds/progresses, never deletes."""
    conn = sqlite3.connect(remote_path)
    _ensure_schema(conn)
    conn.execute("ATTACH DATABASE ? AS local", (local_path,))

    try:
        with conn:
            # 1) Courses: upsert
            conn.execute("""
                INSERT OR REPLACE INTO main.courses (course_id, title, teacher)
                SELECT course_id, title, teacher FROM local.courses
            """)

            # 2) Lectures: insert rows that only exist in local
            conn.execute("""
                INSERT OR IGNORE INTO main.lectures
                    (sub_id, course_id, sub_title, date, transcript, summary,
                     processed_at, emailed_at, error_msg, error_count, error_stage,
                     summary_model, summary_format_version, old_summary)
                SELECT sub_id, course_id, sub_title, date, transcript, summary,
                       processed_at, emailed_at, error_msg, error_count, error_stage,
                       summary_model, summary_format_version, old_summary
                FROM local.lectures
            """)

            # 3) Lectures: merge existing rows (progress forward only)
            #    - Progress fields: COALESCE(local, remote) — prefer non-null
            #    - Error fields: clear if processed, otherwise keep the most info
            #    - summary_format_version: take MAX so v2 wins
            #    - old_summary: prefer the side that ALREADY captured the
            #      pre-v2 text; once written it should never change
            conn.execute("""
                UPDATE main.lectures SET
                    transcript    = COALESCE(l.transcript,    main.lectures.transcript),
                    summary       = COALESCE(l.summary,       main.lectures.summary),
                    summary_model = COALESCE(l.summary_model, main.lectures.summary_model),
                    summary_format_version = MAX(
                        COALESCE(l.summary_format_version, 0),
                        COALESCE(main.lectures.summary_format_version, 0)
                    ),
                    old_summary   = COALESCE(main.lectures.old_summary, l.old_summary),
                    processed_at  = COALESCE(l.processed_at,  main.lectures.processed_at),
                    emailed_at    = COALESCE(l.emailed_at,    main.lectures.emailed_at),
                    error_msg = CASE
                        WHEN COALESCE(l.processed_at, main.lectures.processed_at) IS NOT NULL
                        THEN NULL
                        ELSE COALESCE(l.error_msg, main.lectures.error_msg)
                    END,
                    error_count = CASE
                        WHEN COALESCE(l.processed_at, main.lectures.processed_at) IS NOT NULL
                        THEN 0
                        ELSE MAX(COALESCE(l.error_count, 0), COALESCE(main.lectures.error_count, 0))
                    END,
                    error_stage = CASE
                        WHEN COALESCE(l.processed_at, main.lectures.processed_at) IS NOT NULL
                        THEN NULL
                        ELSE COALESCE(l.error_stage, main.lectures.error_stage)
                    END
                FROM local.lectures l
                WHERE main.lectures.sub_id = l.sub_id
            """)

            # 4) PPT pages: insert local-only rows
            conn.execute("""
                INSERT OR IGNORE INTO main.ppt_pages
                    (sub_id, page_num, created_sec, pptimgurl, text, ocr_status, ocr_at)
                SELECT sub_id, page_num, created_sec, pptimgurl, text, ocr_status, ocr_at
                FROM local.ppt_pages
            """)

            # 5) PPT pages: merge existing rows.
            #    Status priority: 'done' > 'failed' > 'pending'.  Text wins if non-null
            #    on either side (a 'done' row's text is preferred, but COALESCE handles
            #    the rare case of done-without-text gracefully).
            conn.execute("""
                UPDATE main.ppt_pages SET
                    text = COALESCE(l.text, main.ppt_pages.text),
                    ocr_status = CASE
                        WHEN l.ocr_status = 'done' OR main.ppt_pages.ocr_status = 'done'
                            THEN 'done'
                        WHEN l.ocr_status = 'failed' OR main.ppt_pages.ocr_status = 'failed'
                            THEN 'failed'
                        ELSE 'pending'
                    END,
                    ocr_at = COALESCE(l.ocr_at, main.ppt_pages.ocr_at),
                    created_sec = COALESCE(l.created_sec, main.ppt_pages.created_sec),
                    pptimgurl = COALESCE(l.pptimgurl, main.ppt_pages.pptimgurl)
                FROM local.ppt_pages l
                WHERE main.ppt_pages.sub_id = l.sub_id
                  AND main.ppt_pages.page_num = l.page_num
            """)

            # 6) all_courses (catalog): upsert local rows into remote.  We take
            #    the side with the newer ``last_seen_at`` so a stale local crawl
            #    can't overwrite a fresher remote one.  We deliberately don't
            #    delete from remote — local's upsert_all_courses_for_term may
            #    have hard-deleted dropped courses for the term it crawled, but
            #    we can't tell here which terms were "intentionally crawled"
            #    vs. "stale snapshot".  Frontend filters on last_seen_at for
            #    freshness instead.
            #
            #    Guarded: workflows running against a pre-catalog local DB will
            #    lack the table entirely; in that case there's nothing to merge.
            has_all_courses = conn.execute(
                "SELECT 1 FROM local.sqlite_master "
                "WHERE type='table' AND name='all_courses'"
            ).fetchone()
            if has_all_courses:
                conn.execute("""
                    INSERT INTO main.all_courses
                        (course_id, term, title, teacher, dept, last_seen_at)
                    SELECT course_id, term, title, teacher, dept, last_seen_at
                    FROM local.all_courses
                    WHERE true
                    ON CONFLICT(course_id, term) DO UPDATE SET
                        title       = excluded.title,
                        teacher     = excluded.teacher,
                        dept        = excluded.dept,
                        last_seen_at = excluded.last_seen_at
                    WHERE excluded.last_seen_at > all_courses.last_seen_at
                """)

    finally:
        # DETACH explicitly so the local DB file handle is released —
        # without this, Windows holds the file open and unlink in tests
        # (or os.replace in CI) fails with PermissionError.
        try:
            conn.execute("DETACH DATABASE local")
        except sqlite3.Error:
            pass
        conn.close()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} LOCAL_DB REMOTE_DB")
        print("Merges LOCAL_DB into REMOTE_DB (additive-only).")
        sys.exit(1)
    merge(sys.argv[1], sys.argv[2])
    print("Merge complete.")
