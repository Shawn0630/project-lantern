"""Gemini translation for subtitle lines.

Numbered-lines protocol (same as the manager's llm.js): the prompt numbers
every input line, the model must return the same number of lines in the
same order, and the count is verified before the result is accepted.
Transient API errors are retried with backoff (max 3 attempts).
"""
import os
import re
import time

import requests

DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
# Override for tests/probes: point at a local stub instead of Google.
GEMINI_URL = "{base}/models/{model}:generateContent"
MAX_ATTEMPTS = 3
TRANSIENT_STATUS = {429, 500, 502, 503, 504}

_NUMBERED_RE = re.compile(r"^(\d+)[.)]\s*(.*)$")


def build_translate_prompt(lines, source_lang: str, target_lang: str) -> str:
    numbered = "\n".join(f"{i + 1}. {t}" for i, t in enumerate(lines))
    return "\n".join([
        f"Translate the following {source_lang} subtitle lines to {target_lang}.",
        "Rules:",
        "- Return EXACTLY the same number of lines as the input, in the same order.",
        '- Keep the "N. " numbering on every line.',
        "- Translate naturally for subtitles; keep it concise.",
        "- Do not add explanations, headers, or extra lines.",
        "",
        numbered,
    ])


def parse_numbered_lines(text: str, expected_count: int):
    """Parse a numbered-lines response; raises ValueError on count mismatch."""
    parsed = {}
    fallback = []
    for raw in str(text).split("\n"):
        line = raw.strip()
        if not line:
            continue
        m = _NUMBERED_RE.match(line)
        if m:
            parsed[int(m.group(1)) - 1] = m.group(2).strip()
        else:
            fallback.append(line)
    if parsed:
        out = [parsed.get(i) for i in range(expected_count)]
        if any(v is None for v in out) or len(parsed) != expected_count:
            raise ValueError(f"line count mismatch: expected {expected_count} numbered lines, got {len(parsed)}")
        return out
    if len(fallback) != expected_count:
        raise ValueError(f"line count mismatch: expected {expected_count}, got {len(fallback)}")
    return fallback


def translate_lines(lines, source_lang, target_lang, api_key, model, session=None, sleep=time.sleep):
    """Translate `lines` via Gemini. Returns a list of translated strings.

    Raises RuntimeError on persistent API failure and ValueError on a
    line-count mismatch after all retries.
    """
    if not api_key:
        raise RuntimeError("no LLM API key provided for translation")
    session = session or requests
    prompt = build_translate_prompt(lines, source_lang, target_lang)
    base = os.environ.get("GEMINI_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
    url = GEMINI_URL.format(base=base, model=model)
    last_error = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            resp = session.post(
                url,
                params={"key": api_key},
                json={"contents": [{"parts": [{"text": prompt}]}]},
                timeout=120,
            )
        except requests.RequestException as e:
            last_error = RuntimeError(f"Gemini request failed: {e}")
            if attempt < MAX_ATTEMPTS:
                sleep(2 ** attempt)
                continue
            raise last_error
        if resp.status_code in TRANSIENT_STATUS:
            last_error = RuntimeError(f"Gemini HTTP {resp.status_code}: {resp.text[:300]}")
            if attempt < MAX_ATTEMPTS:
                sleep(2 ** attempt)
                continue
            raise last_error
        if resp.status_code != 200:
            raise RuntimeError(f"Gemini HTTP {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
        parts = (data.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
        text = "".join(p.get("text", "") for p in parts)
        if not text.strip():
            raise RuntimeError("Gemini returned empty text")
        try:
            return parse_numbered_lines(text, len(lines))
        except ValueError as e:
            last_error = e
            if attempt < MAX_ATTEMPTS:
                sleep(2 ** attempt)
                continue
            raise
    raise last_error or RuntimeError("translation failed")
