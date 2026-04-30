#!/usr/bin/env python3
"""Bidirectional DB shard CLI used by GitHub Actions workflows.

Usage:
    python scripts/db_shard.py shard      <db_path>    <output_dir>
    python scripts/db_shard.py reassemble <input_dir>  <db_path>

Reads the v2 password from STUID + UISPSW env vars. Both subcommands
operate on the layout produced by `src.sharder`:
    <dir>/icourse-index.enc
    <dir>/shards/shard-NNNN.db.gz.enc
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.crypto_box import derive_new_password
from src.sharder import (
    INDEX_FILENAME,
    SHARDS_DIR,
    load_index,
    reassemble_database,
    shard_database,
)


def _password() -> str:
    stuid = os.environ.get("STUID") or os.environ.get("StuId", "")
    uispsw = os.environ.get("UISPSW") or os.environ.get("UISPsw", "")
    if not stuid or not uispsw:
        print("error: STUID and UISPSW env vars required", file=sys.stderr)
        sys.exit(2)
    return derive_new_password(stuid, uispsw)


def _cmd_shard(db_path: str, output_dir: str):
    if not os.path.isfile(db_path):
        print(f"error: not a file: {db_path}", file=sys.stderr)
        sys.exit(1)
    os.makedirs(output_dir, exist_ok=True)
    index = shard_database(db_path, output_dir, _password())
    n = len(index["shards"])
    print(f"sharded → {n} shard(s) under {output_dir}/")


def _cmd_reassemble(input_dir: str, db_path: str):
    index_path = os.path.join(input_dir, INDEX_FILENAME)
    if not os.path.isfile(index_path):
        print(f"error: index not found at {index_path}", file=sys.stderr)
        sys.exit(1)
    pw = _password()
    index = load_index(index_path, pw)
    shards_dir = os.path.join(input_dir, SHARDS_DIR)
    reassemble_database(index, shards_dir, db_path, pw)
    n = len(index["shards"])
    print(f"reassembled {n} shard(s) → {db_path}")


def main():
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    cmd, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
    if cmd == "shard":
        _cmd_shard(a, b)
    elif cmd == "reassemble":
        _cmd_reassemble(a, b)
    else:
        print(__doc__, file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
