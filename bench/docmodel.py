"""Flat ProseMirror doc model for the load benchmarker.

The bench never runs ProseMirror; it needs just enough of the document to
emit *valid* step JSON against the server's current version and to keep
its picture of the doc in sync as other clients' steps arrive over SSE.

Model: the doc is a list of paragraphs, each a plain string. Positions
follow ProseMirror's counting for a ``doc > paragraph* > text`` tree —
paragraph ``i`` occupies ``len(text) + 2`` positions (one open token, the
characters, one close token). Marks don't change positions, so they're
ignored for length purposes.

Steps are applied on a *token string*: paragraph ``"ab"`` is
``"\\x02ab\\x03"`` (one char per position, so the char at index ``i`` sits
between positions ``i`` and ``i+1``). A ``replace`` step is then
``region[from:to] = slice_tokens`` — string slicing, C speed — covering
every shape the bench generates (single-paragraph edits, multi-paragraph
pastes with open sides, cross-paragraph deletes, paragraph
insert/delete) plus anything else another client sends as long as the
doc stays paragraphs-of-text. Only the paragraphs touched by the edit are
tokenised; a cumulative-offset array (``bisect``) locates them, so a
keystroke on a 300 KB doc costs microseconds rather than a full-document
rebuild (which starved the bench's event loop at 20 users).

``addMark`` / ``removeMark`` are no-ops for the model. If a step or
bootstrap doc uses a node the model can't represent, the caller gets
``UnsupportedDoc`` and should re-bootstrap (the server is the source of
truth; the bench just resyncs).
"""

from __future__ import annotations

import random
from bisect import bisect_right
from itertools import accumulate

OPEN = "\x02"
CLOSE = "\x03"
ATOM = "￼"  # any leaf inline node (hard_break, mention, …): one position

MARKS = ("strong", "em", "code")

_WORDS = (
    "the quick brown fox jumps over the lazy dog while datasette paper keeps "
    "every step in an append only log and snapshots the document now and then "
    "so late joiners can catch up without replaying history from the start"
).split()
# One big word-salad string; lorem() slices it at a random offset instead of
# choosing words one at a time (which showed up in the bench profile).
_TEXT = " ".join(random.Random(0).choice(_WORDS) for _ in range(4000))


class UnsupportedDoc(Exception):
    """The doc (or a step) uses nodes the flat model can't represent."""


def lorem(nchars: int, rng: random.Random | None = None) -> str:
    """Roughly ``nchars`` of word salad (never empty)."""
    rng = rng or random
    n = max(nchars, 1)
    if n >= len(_TEXT):
        return (_TEXT * (n // len(_TEXT) + 1))[:n]
    start = rng.randrange(len(_TEXT) - n)
    return _TEXT[start : start + n]


def seed_markdown(target_bytes: int, rng: random.Random | None = None) -> str:
    """Markdown of plain paragraphs totalling ~``target_bytes``.

    Paragraphs are ~400 chars so a 300 KB doc has ~750 of them — a
    realistic long-document shape rather than one giant paragraph.
    """
    rng = rng or random
    paras: list[str] = []
    size = 0
    while size < target_bytes:
        p = lorem(rng.randint(200, 600), rng).strip() or "x"
        paras.append(p)
        size += len(p) + 2
    return "\n\n".join(paras) + "\n"


class FlatDoc:
    __slots__ = ("paragraphs", "_cum")

    def __init__(self, paragraphs: list[str] | None = None):
        self.paragraphs = list(paragraphs) if paragraphs else [""]
        self._reindex()

    def _reindex(self) -> None:
        # _cum[i] == position before paragraph i; _cum[-1] == doc size.
        self._cum = [0, *accumulate(len(p) + 2 for p in self.paragraphs)]

    # -- construction -----------------------------------------------------

    @classmethod
    def from_json(cls, doc_json: dict) -> "FlatDoc":
        if doc_json.get("type") != "doc":
            raise UnsupportedDoc(f"root is {doc_json.get('type')!r}")
        paras: list[str] = []
        for block in doc_json.get("content") or []:
            if block.get("type") != "paragraph":
                raise UnsupportedDoc(f"block {block.get('type')!r}")
            paras.append(_inline_text(block.get("content") or []))
        return cls(paras)

    # -- positions --------------------------------------------------------

    @property
    def size(self) -> int:
        return self._cum[-1]

    def para_before(self, i: int) -> int:
        """Position just before paragraph ``i``'s open token (``i == n`` → doc end)."""
        return self._cum[i]

    def para_start(self, i: int) -> int:
        """Position of the first character slot inside paragraph ``i``."""
        return self._cum[i] + 1

    # -- token round-trip -------------------------------------------------

    @staticmethod
    def tokens_of(paras: list[str]) -> str:
        return "".join(f"{OPEN}{p}{CLOSE}" for p in paras)

    @staticmethod
    def paras_of(toks: str) -> list[str]:
        """Parse a token string back to paragraphs; raise if malformed."""
        if not toks:
            return []
        pieces = toks.split(CLOSE)
        if pieces[-1] != "":
            raise UnsupportedDoc("unterminated paragraph")
        out: list[str] = []
        for piece in pieces[:-1]:
            if not piece.startswith(OPEN) or OPEN in piece[1:]:
                raise UnsupportedDoc("text outside paragraph / nested open")
            out.append(piece[1:])
        return out

    # -- applying steps ---------------------------------------------------

    def apply(self, step: dict) -> None:
        kind = step.get("stepType")
        if kind in ("addMark", "removeMark"):
            return
        if kind != "replace":
            raise UnsupportedDoc(f"step {kind!r}")
        frm, to = int(step["from"]), int(step["to"])
        cum = self._cum
        size = cum[-1]
        if not (0 <= frm <= to <= size):
            raise UnsupportedDoc(f"replace {frm}..{to} outside doc of {size}")
        ins = _slice_tokens(step.get("slice"))

        # Paragraph range [a, b) whose tokens intersect the edit: ``a``
        # holds token index ``from`` (n at doc end); ``b`` is one past the
        # paragraph holding token ``to - 1``; a pure insertion inside or
        # just before paragraph a still needs that paragraph in the region.
        n = len(self.paragraphs)
        a = bisect_right(cum, frm) - 1
        if to > frm:
            b = bisect_right(cum, to - 1)
        else:
            b = min(a + 1, n)
        start = cum[a]
        region = self.tokens_of(self.paragraphs[a:b])
        region = region[: frm - start] + ins + region[to - start :]
        self.paragraphs[a:b] = self.paras_of(region)
        if not self.paragraphs:
            self.paragraphs = [""]
        self._reindex()

    def apply_all(self, steps: list[dict]) -> None:
        for s in steps:
            self.apply(s)

    # -- step generators --------------------------------------------------
    # Each returns a list of steps valid against *this* doc; the caller
    # applies them locally only after the server accepts (mirrors
    # prosemirror-collab: unconfirmed steps aren't in our model, a 409
    # simply drops them and we regenerate).

    def _text_pos(self, rng: random.Random) -> tuple[int, int]:
        """A random (paragraph index, absolute position) inside text."""
        i = rng.randrange(len(self.paragraphs))
        off = rng.randint(0, len(self.paragraphs[i]))
        return i, self.para_start(i) + off

    def gen_typing(self, rng: random.Random, nchars: int) -> list[dict]:
        """``nchars`` single-character inserts at one caret, like a keystroke burst."""
        _, pos = self._text_pos(rng)
        text = lorem(nchars, rng)[:nchars]
        return [_insert(pos + k, ch) for k, ch in enumerate(text)]

    def gen_delete(self, rng: random.Random, max_chars: int = 40) -> list[dict]:
        """Delete a range; ~1 in 4 spans a paragraph boundary (joins them)."""
        i, pos = self._text_pos(rng)
        end_of_para = self.para_start(i) + len(self.paragraphs[i])
        if rng.random() < 0.25 and i + 1 < len(self.paragraphs):
            # pos in para i .. somewhere in para i+1 — crosses the boundary.
            j_start = self.para_start(i + 1)
            to = j_start + rng.randint(0, min(max_chars, len(self.paragraphs[i + 1])))
            return [_delete(pos, to)]
        to = min(end_of_para, pos + rng.randint(1, max_chars))
        if to <= pos:
            # Empty tail; delete backwards instead.
            frm = max(self.para_start(i), pos - rng.randint(1, max_chars))
            if frm == pos:
                return []
            return [_delete(frm, pos)]
        return [_delete(pos, to)]

    def gen_paste(self, rng: random.Random, nchars: int) -> list[dict]:
        """Paste ``nchars`` as 1-4 paragraphs at a text position (open 1/1 slice)."""
        _, pos = self._text_pos(rng)
        nparas = rng.randint(1, 4)
        chunk = max(nchars // nparas, 1)
        paras = [lorem(chunk, rng) for _ in range(nparas)]
        if nparas == 1:
            return [_insert(pos, paras[0])]
        content = [_para_json(p) for p in paras]
        return [
            {
                "stepType": "replace",
                "from": pos,
                "to": pos,
                "slice": {"content": content, "openStart": 1, "openEnd": 1},
            }
        ]

    def gen_new_paragraph(self, rng: random.Random, nchars: int) -> list[dict]:
        """Insert a whole paragraph between two existing ones."""
        i = rng.randint(0, len(self.paragraphs))
        pos = self.para_before(i)
        return [
            {
                "stepType": "replace",
                "from": pos,
                "to": pos,
                "slice": {"content": [_para_json(lorem(nchars, rng))]},
            }
        ]

    def gen_delete_paragraph(self, rng: random.Random) -> list[dict]:
        if len(self.paragraphs) < 2:
            return []
        i = rng.randrange(len(self.paragraphs))
        frm = self.para_before(i)
        return [_delete(frm, frm + len(self.paragraphs[i]) + 2)]

    def gen_mark(self, rng: random.Random, max_chars: int = 60) -> list[dict]:
        """Toggle a mark over a text range inside one paragraph."""
        i, pos = self._text_pos(rng)
        end_of_para = self.para_start(i) + len(self.paragraphs[i])
        to = min(end_of_para, pos + rng.randint(1, max_chars))
        if to <= pos:
            return []
        kind = "addMark" if rng.random() < 0.7 else "removeMark"
        return [
            {
                "stepType": kind,
                "from": pos,
                "to": to,
                "mark": {"type": rng.choice(MARKS)},
            }
        ]


# -- helpers ----------------------------------------------------------------


def _inline_text(content: list[dict]) -> str:
    out: list[str] = []
    for node in content:
        t = node.get("type")
        if t == "text":
            out.append(node.get("text", ""))
        elif node.get("content"):
            raise UnsupportedDoc(f"inline {t!r} with content")
        else:
            out.append(ATOM)
    return "".join(out)


def _slice_tokens(slc: dict | None) -> str:
    if not slc:
        return ""
    parts: list[str] = []
    for node in slc.get("content") or []:
        t = node.get("type")
        if t == "paragraph":
            parts.append(OPEN + _inline_text(node.get("content") or []) + CLOSE)
        elif t == "text":
            parts.append(node.get("text", ""))
        elif node.get("content"):
            raise UnsupportedDoc(f"slice node {t!r}")
        else:
            parts.append(ATOM)
    toks = "".join(parts)
    open_start = int(slc.get("openStart", 0))
    open_end = int(slc.get("openEnd", 0))
    if open_start > 1 or open_end > 1:
        raise UnsupportedDoc("slice open depth > 1")
    if open_start == 1:
        if not toks.startswith(OPEN):
            raise UnsupportedDoc("openStart=1 on non-paragraph slice")
        toks = toks[1:]
    if open_end == 1:
        if not toks.endswith(CLOSE):
            raise UnsupportedDoc("openEnd=1 on non-paragraph slice")
        toks = toks[:-1]
    return toks


def _para_json(text: str) -> dict:
    node: dict = {"type": "paragraph"}
    if text:
        node["content"] = [{"type": "text", "text": text}]
    return node


def _insert(pos: int, text: str) -> dict:
    return {
        "stepType": "replace",
        "from": pos,
        "to": pos,
        "slice": {"content": [{"type": "text", "text": text}]},
    }


def _delete(frm: int, to: int) -> dict:
    return {"stepType": "replace", "from": frm, "to": to}
