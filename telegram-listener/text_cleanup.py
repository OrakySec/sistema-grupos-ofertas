"""
Removes unwanted words from a message before it is sent on.

Typical use: source channels started signing every post with their own
hashtag (#nomedogrupo). The operator lists those terms in Configurações and
they are stripped from the text/caption on the way through.

Rules, so the cleanup never damages the offer:
- Links are never touched — a term like "ofertas" must not corrupt
  ofertas.ykaromarques.com/s/xxxxxx.
- Matching is case-insensitive and on whole words: "grupo" does not cut
  "agrupamento".
- A term written with a leading "#" or "@" matches the hashtag / mention
  itself. A plain word does NOT match inside a hashtag ("ofertas" leaves
  "#ofertas" alone — list "#ofertas" to remove that).
- "*" is a wildcard for the rest of the word: "#ofertas*" also removes
  "#ofertasbr"; a bare "#*" removes every hashtag.
- Several words separated by spaces are matched as a phrase.
- A line that becomes empty (or only emoji/punctuation) because of the
  removal is dropped, and the gap the removed term left is tidied up.
"""

import re

# Splitting with a capture group keeps the URLs at the odd indexes.
_URL_SPLIT_RE = re.compile(r"(https?://\S+)", re.IGNORECASE)


def parse_terms(raw: str) -> list:
    """One term per line (blank lines and surrounding spaces ignored)."""
    return [line.strip() for line in (raw or "").splitlines() if line.strip()]


def _term_regex(term: str):
    term = term.strip()
    if not term:
        return None

    # "#*" / "@*": every hashtag / every mention (at least one character after it)
    if term in ("#*", "@*"):
        return re.compile(r"(?<!\w)" + re.escape(term[0]) + r"\w+", re.IGNORECASE)

    words = [re.escape(w).replace(r"\*", r"\w*") for w in term.split()]
    body = r"\s+".join(words)

    # A plain word must not match inside "#word" / "@word"; a term that itself
    # starts with a symbol (#, @) only needs to not be glued to a previous word.
    first = term[0]
    if first.isalnum() or first in ("_", "*"):
        before = r"(?<![\w#@])"
    else:
        before = r"(?<!\w)"
    return re.compile(before + body + r"(?!\w)", re.IGNORECASE)


def _tidy_line(line: str) -> str:
    """Closes the gap a removed term leaves in the line it was removed from."""
    line = re.sub(r"[ \t]{2,}", " ", line)
    line = re.sub(r"\s+([,.;:!?])", r"\1", line)
    # dangling separator left at the end: "Oferta | #grupo" -> "Oferta"
    line = re.sub(r"[\s\-–—|•·/,;:]+$", "", line)
    return line.strip()


def strip_terms(text, terms):
    """
    Returns (clean_text, removed) where removed maps each term to how many
    times it was cut. The text is returned untouched when nothing matched.
    """
    if not text or not terms:
        return text, {}

    patterns = []
    for term in terms:
        rx = _term_regex(term)
        if rx is not None:
            patterns.append((term, rx))
    if not patterns:
        return text, {}

    removed = {}
    out_lines = []
    for line in text.split("\n"):
        pieces = _URL_SPLIT_RE.split(line)
        changed = False
        for i in range(0, len(pieces), 2):  # even indexes are the non-URL text
            segment = pieces[i]
            for term, rx in patterns:
                segment, count = rx.subn("", segment)
                if count:
                    removed[term] = removed.get(term, 0) + count
                    changed = True
            pieces[i] = segment

        new_line = "".join(pieces)
        if changed:
            new_line = _tidy_line(new_line)
            if not re.search(r"\w", new_line):
                continue  # only emoji / punctuation left → the whole line goes
        out_lines.append(new_line)

    if not removed:
        return text, {}

    result = re.sub(r"\n{3,}", "\n\n", "\n".join(out_lines)).strip()
    return result, removed
