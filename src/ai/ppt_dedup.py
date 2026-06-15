"""PPT page filters: garbage-catalog matching + perceptual-hash dedup.

All configurable rules live in ``ppt_dedup_config.py`` — edit that file to
tune patterns without touching this logic code.

Pipeline (pre-OCR stages):
  1. ``match_garbage`` — compares each page's dhash against a pre-computed
     garbage catalog; matches are dropped before OCR (no text needed).
  2. ``dedup_dhash`` — full pairwise dedup on survivors, with auto-escalating
     threshold capped at ``DHASH_MAX_SURVIVORS``.

Post-OCR stages:
  3. ``is_invalid_page`` — text-based noise detection.
  4. ``clean_ppt_text`` — per-line UI chrome stripping.
  5. ``dedup_text_subset`` — text n-gram subset dedup for animation reveals.
"""

from __future__ import annotations

import io
import re
from typing import Iterable

import imagehash
from PIL import Image

from src.ai.ppt_dedup_config import (
    DHASH_THRESHOLD,
    DHASH_MAX_SURVIVORS,
    GARBAGE_CATALOG,
    GARBAGE_THRESHOLD,
    INVALID_PAGE_PATTERNS,
    PPT_UI_STOPWORDS,
    SUBSET_CONFIG,
    UI_NOISE_LINE_PATTERNS,
)

# ── Compile regexes from config once at import time ─────────────────────────
_UI_NOISE_LINE_RES: list[re.Pattern] = [
    re.compile(p) for p in UI_NOISE_LINE_PATTERNS
]

_NORMALIZE_RE = re.compile(r"[\W_]+", re.UNICODE)
_NORMALIZE_UI_RE = re.compile(r"[\s　]+")


# ══════════════════════════════════════════════════════════════════════════════
# Stage 1 — Garbage-catalog matching  (pre-OCR)
# ══════════════════════════════════════════════════════════════════════════════

# Pre-convert catalog hex strings to ints at import time.
_GARBAGE_INTS: list[int] = [int(h, 16) for h in GARBAGE_CATALOG]


def compute_dhash(image_bytes: bytes) -> str | None:
    """Perceptual hash for an image. Returns 16-hex string or None on error."""
    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            return str(imagehash.dhash(img))
    except Exception:
        return None


def match_garbage(
    items: list[str | None],
    threshold: int | None = None,
) -> list[int]:
    """Match each page against the garbage catalog.  Returns sorted list of
    indices that matched (i.e. should be dropped as known garbage).

    ``items`` may contain ``None`` (compute_dhash failure) — those are
    passed through (never matched).
    """
    if threshold is None:
        threshold = GARBAGE_THRESHOLD
    matched: list[int] = []
    for i, h in enumerate(items):
        if h is None:
            continue
        dh = int(h, 16)
        for ref in _GARBAGE_INTS:
            if (dh ^ ref).bit_count() <= threshold:
                matched.append(i)
                break
    return matched


def _dedup_full(
    items: list[str | None],
    threshold: int,
) -> set[int]:
    """Full pairwise dedup. Anchor-based: for each surviving page i, drop
    all later pages j whose dhash is within ``threshold`` Hamming bits of i.
    Already-dropped pages never become anchors."""
    n = len(items)
    dropped: set[int] = set()
    # Pre-convert to int for fast XOR
    int_items: list[int | None] = []
    for h in items:
        int_items.append(int(h, 16) if h else None)
    for i in range(n):
        if i in dropped:
            continue
        a = int_items[i]
        if a is None:
            continue
        for j in range(i + 1, n):
            if j in dropped:
                continue
            b = int_items[j]
            if b is None:
                continue
            if (a ^ b).bit_count() <= threshold:
                dropped.add(j)
    return dropped


def dedup_dhash(
    items: list[str | None],
    window: int = 0,
    threshold: int | None = None,
    max_survivors: int | None = None,
) -> list[int]:
    """Full pairwise dedup with auto-escalating threshold (Step 2).

    Runs after ``match_garbage``.  Starts at ``DHASH_THRESHOLD`` (3),
    drops near-duplicate pages via full pairwise anchor-based comparison,
    then auto-raises the threshold in steps of 4 until survivors ≤
    ``DHASH_MAX_SURVIVORS`` (150).

    Returns sorted list of dropped indices (within the ``items`` list).
    """
    if threshold is None:
        threshold = DHASH_THRESHOLD
    if max_survivors is None:
        max_survivors = DHASH_MAX_SURVIVORS
    del window  # deprecated, kept for signature compatibility

    n = len(items)
    dropped = _dedup_full(items, threshold)
    survivors = n - len(dropped)

    while survivors > max_survivors and threshold < 50:
        threshold += 4
        dropped = _dedup_full(items, threshold)
        survivors = n - len(dropped)

    return sorted(dropped)


# ══════════════════════════════════════════════════════════════════════════════
# Stage 2 — Full-page invalidation  (post-OCR)
# ══════════════════════════════════════════════════════════════════════════════


def _normalize_for_match(text: str) -> str:
    """Lowercase + strip whitespace and punctuation. CJK chars are kept."""
    if not text:
        return ""
    return _NORMALIZE_RE.sub("", text).lower()


def is_invalid_page(text: str) -> bool:
    """True if any feature string matches the (normalized) OCR'd text."""
    norm = _normalize_for_match(text)
    if not norm:
        return False
    return any(p in norm for p in INVALID_PAGE_PATTERNS)


def normalize_for_match(text: str) -> str:  # noqa: D401
    """Public alias for tests / debugging."""
    return _normalize_for_match(text)


# ══════════════════════════════════════════════════════════════════════════════
# Stage 3 — Per-line UI chrome stripping  (post-invalidation)
# ══════════════════════════════════════════════════════════════════════════════


def clean_ppt_text(text: str) -> str:
    """Remove window-chrome noise from OCR'd slide text.

    Operates per-line so a slide mixing real content and UI labels keeps the
    former while stripping the latter.  Returns the cleaned text (may be empty
    for a fully-noise page).
    """
    if not text:
        return ""
    kept: list[str] = []
    for line in text.split("\n"):
        s = line.strip()
        if not s:
            continue
        # ≤2 char lines are virtually always UI chrome (ribbon icons, IME
        # indicators, single letters from Alt-key shortcuts, etc.).
        if len(s) <= 1:
            continue
        # Normalise away the full-width ideographic space (U+3000) that
        # PowerPoint uses in its ribbon layout, and repeated spaces.
        norm = _NORMALIZE_UI_RE.sub("", s).strip()
        if not norm:
            continue
        # Exact stopword match (case-insensitive for ASCII labels).
        if norm in PPT_UI_STOPWORDS:
            continue
        if norm.lower() in PPT_UI_STOPWORDS:
            continue
        # Regex patterns — match against the normalised form.
        if any(p.fullmatch(norm) for p in _UI_NOISE_LINE_RES):
            continue
        kept.append(s)
    return "\n".join(kept)


# ══════════════════════════════════════════════════════════════════════════════
# Stage 4 — Text subset dedup  (post-cleaning, pre-prompt)
# ══════════════════════════════════════════════════════════════════════════════


def _normalize_subset(s: str) -> str:
    """Light normalisation: lowercase, fullwidth→halfwidth, collapse space."""
    s = s.lower()
    s = s.replace("　", " ").replace("�", "").replace("\xa0", " ")
    return " ".join(s.split())


def _ngrams(t: str, n: int = 3) -> set[str]:
    return {t[i:i+n] for i in range(max(1, len(t)-n+1))}


def dedup_text_subset(pages: list[dict]) -> list[dict]:
    """Sliding-window text subset dedup for PPT OCR pages.

    Uses directional 3-gram containment to detect pages whose text is a
    near-subset of a nearby page (common with PPT animation reveals).
    No line-level heuristics — OCR line breaks are unreliable.

    ``pages``: list of dicts, each with at least a ``text`` key.
    Returns filtered list with near-subset pages removed.
    """
    cfg = SUBSET_CONFIG

    texts = [_normalize_subset(p.get("text") or "") for p in pages]
    ng_sets = [_ngrams(t, cfg["ngram_n"]) for t in texts]
    lengths = [len(t) for t in texts]

    keep = [True] * len(pages)

    for idx in range(1, len(pages)):
        window_start = max(0, idx - cfg["window"])

        for old_idx in range(window_start, idx):
            if not keep[old_idx]:
                continue

            if lengths[idx] < lengths[old_idx]:
                short, long = idx, old_idx
            else:
                short, long = old_idx, idx

            effective_threshold = cfg["containment_threshold"]
            if lengths[short] < cfg["protect_min_chars"]:
                effective_threshold = 0.95

            if not ng_sets[short]:
                continue
            containment = len(ng_sets[short] & ng_sets[long]) / len(ng_sets[short])
            length_ratio = lengths[long] / max(lengths[short], 1)

            if containment < effective_threshold or length_ratio < cfg["min_length_ratio"]:
                continue

            if short == idx:
                keep[idx] = False
            else:
                keep[old_idx] = False
            break

    return [p for p, k in zip(pages, keep) if k]
