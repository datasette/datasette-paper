"""Serialization for the `date` inline atom, split out of ``markdown.py``.

``markdown.py`` should hold markdown machinery; the date atom's rules are their
own concern, so they live here. This module owns three things:

- the deterministic markdown label render (:func:`format_date_label` /
  :func:`strftime_date`) — the byte-identical twin of
  ``frontend/src/lib/dateFormat.ts`` (shared fixtures keep the two in step);
- validation of the atom's *untrusted* attrs — the schema's
  ``date``/``time``/``tz``/``format`` attrs are untyped, so a collab step (or
  any doc JSON a client can write) can plant arbitrary values;
- :func:`render_date_atom`, which the markdown serializer calls to turn a
  ``date`` node into a ``[label](paper:/date/<uri>)`` link, or ``None`` to drop
  a structurally-invalid atom rather than crash.

Deliberately regex-free: the validators hand-scan the ``YYYY-MM-DD`` / ``HH:MM``
*shape* character by character (replacing what used to be a regex), then hand
the digits to ``datetime`` for the actual calendar check — month/day ranges and
leap years. The shape parsing is ours; the arithmetic is the stdlib's.
"""

import datetime
from typing import List, Optional, Tuple
from urllib.parse import quote

_DATE_MONTHS = (
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
)
_DATE_MONTHS_FULL = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)
# Indexed by Monday=0 (matches datetime.date.weekday()).
_DATE_WEEKDAYS = (
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
)
_DATE_WEEKDAYS_ABBR = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

# Chars backslash-escaped in a date label so it stays inert markdown link text
# (inline markup + the HTML-open angle brackets + the link brackets).
_LABEL_ESCAPE = frozenset("\\`*_[]<>")


def _date_ordinal(d: int) -> str:
    """1 → "1st", 2 → "2nd", 11 → "11th", 21 → "21st"."""
    if 11 <= d % 100 <= 13:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(d % 10, "th")
    return f"{d}{suffix}"


def strftime_date(fmt: str, y: int, m: int, d: int) -> str:
    """Render a calendar date through a small, fixed strftime subset.

    Deliberately NOT ``datetime.strftime`` — that is locale- and
    platform-dependent (`%-d` is a GNU extension, `%A` follows the process
    locale). This hand-rolled subset hardcodes English names and a fixed
    directive set so it is byte-identical with the TS twin ``strftimeDate`` in
    frontend/src/lib/dateFormat.ts. Directives (a leading `-` drops zero-pad):
    ``%Y %y %m %-m %B %b %d %-d %o %A %a %%``. ``%o`` is a paper extension —
    the ordinal day (20th). Unknown directives pass through literally.
    """
    weekday = datetime.date(y, m, d).weekday()  # Monday=0
    out: List[str] = []
    i, n = 0, len(fmt)
    while i < n:
        ch = fmt[i]
        if ch != "%":
            out.append(ch)
            i += 1
            continue
        i += 1
        if i >= n:
            out.append("%")
            break
        dash = fmt[i] == "-"
        if dash:
            i += 1
            if i >= n:
                out.append("%-")
                break
        spec = fmt[i]
        i += 1
        if spec == "Y":
            out.append(str(y))
        elif spec == "y":
            out.append(f"{y % 100:02d}")
        elif spec == "m":
            out.append(str(m) if dash else f"{m:02d}")
        elif spec == "B":
            out.append(_DATE_MONTHS_FULL[m - 1])
        elif spec == "b":
            out.append(_DATE_MONTHS[m - 1])
        elif spec == "d":
            out.append(str(d) if dash else f"{d:02d}")
        elif spec == "o":
            out.append(_date_ordinal(d))
        elif spec == "A":
            out.append(_DATE_WEEKDAYS[weekday])
        elif spec == "a":
            out.append(_DATE_WEEKDAYS_ABBR[weekday])
        elif spec == "%":
            out.append("%")
        else:
            out.append(("%-" if dash else "%") + spec)  # unknown → literal
    return "".join(out)


def format_date_label(attrs: dict) -> str:
    """Deterministic label for a `date` atom — the markdown link text.

    The date portion is either a custom ``format`` (a strftime pattern rendered
    by :func:`strftime_date`) or, absent one, the default "Jul 20, 2026" which
    always includes the year (so serialization never depends on when it runs;
    the chip's "omit current year" nicety stays client-side). A timed atom
    appends the wall time in the *stored* zone as 12-hour "3:00 PM"
    regardless of ``format`` — ``attrs.time`` already carries the author's wall
    clock, so no zone conversion happens here. Keep byte-identical with the TS
    twin ``formatDateLabel`` in frontend/src/lib/dateFormat.ts (shared
    fixtures).

    Assumes the attrs are already valid (see :func:`parse_ymd` / :func:`parse_hm`)
    — :func:`render_date_atom` validates before calling.
    """
    # @feat date: deterministic markdown-label render (twin of dateFormat.ts)
    year_s, month_s, day_s = (attrs.get("date") or "").split("-")
    y, m, d = int(year_s), int(month_s), int(day_s)
    fmt = attrs.get("format")
    label = strftime_date(fmt, y, m, d) if fmt else f"{_DATE_MONTHS[m - 1]} {d}, {y}"
    time = attrs.get("time")
    if time:
        hh, mm = time.split(":")
        hour = int(hh)
        h12 = hour % 12 or 12
        ampm = "AM" if hour < 12 else "PM"
        label += f" {h12}:{mm} {ampm}"
    return label


def _ascii_digits(s: str) -> bool:
    """True iff ``s`` is non-empty and every char is an ASCII ``0``-``9``.

    Not ``str.isdigit`` — that accepts superscripts and other unicode numerals
    that ``int()`` would then choke on. Hand-rolled so the accepted set is
    exactly the ten ASCII digits.
    """
    if not s:
        return False
    for ch in s:
        if ch < "0" or ch > "9":
            return False
    return True


def parse_ymd(date: object) -> Optional[Tuple[int, int, int]]:
    """Parse a strict ``YYYY-MM-DD`` string into ``(y, m, d)``, else ``None``.

    We hand-scan the *shape* — exactly ``DDDD-DD-DD`` (four ASCII digits, dash,
    two digits, dash, two digits) — so no regex is involved, then let
    ``datetime.date`` do the calendar arithmetic (month 1-12, day valid for the
    month, leap years, year in ``datetime``'s 1-9999 range). ``None`` for
    anything else, so the caller drops an attacker-planted value rather than
    trusting it. ``datetime.date``'s ≥ year-1 floor also means the weekday
    lookup in :func:`strftime_date` can never raise on a value that got here.
    """
    if not isinstance(date, str) or len(date) != 10:
        return None
    if date[4] != "-" or date[7] != "-":
        return None
    year_s, month_s, day_s = date[0:4], date[5:7], date[8:10]
    if not (_ascii_digits(year_s) and _ascii_digits(month_s) and _ascii_digits(day_s)):
        return None
    try:
        d = datetime.date(int(year_s), int(month_s), int(day_s))
    except ValueError:
        return None
    return d.year, d.month, d.day


def parse_hm(time: object) -> Optional[Tuple[int, int]]:
    """Parse a strict 24-hour ``HH:MM`` string into ``(h, m)``, else ``None``.

    Twin of :func:`parse_ymd`: hand-scan the exact ``DD:DD`` shape, then let
    ``datetime.time`` range-check the hour (0-23) and minute (0-59).
    """
    if not isinstance(time, str) or len(time) != 5:
        return None
    if time[2] != ":":
        return None
    hour_s, minute_s = time[0:2], time[3:5]
    if not (_ascii_digits(hour_s) and _ascii_digits(minute_s)):
        return None
    try:
        t = datetime.time(int(hour_s), int(minute_s))
    except ValueError:
        return None
    return t.hour, t.minute


def escape_date_label(label: str) -> str:
    """Neutralize a date atom's label as inert markdown link text.

    The label embeds the author-supplied ``format`` string verbatim (unknown
    directives and literals pass through :func:`strftime_date`), so it is the
    one link label carrying free-form user input. A single character scan does
    two jobs: (a) collapse any run of newlines to one space — a blank line
    inside ``[...]`` closes the link and would let ``format`` inject
    block-level markdown (a heading, a second link); (b) backslash-escape the
    inline-markup set, the link brackets, and ``<``/``>`` so the label can't
    reopen emphasis/a link or smuggle a raw HTML tag.
    """
    out: List[str] = []
    prev_space_from_newline = False
    for ch in label:
        if ch in "\r\n":
            if not prev_space_from_newline:
                out.append(" ")
                prev_space_from_newline = True
            continue
        prev_space_from_newline = False
        if ch in _LABEL_ESCAPE:
            out.append("\\")
        out.append(ch)
    return "".join(out)


def render_date_atom(attrs: dict) -> Optional[str]:
    """Serialize a `date` atom to ``[label](paper:/date/<uri>)``, or ``None``.

    The schema's ``date``/``time``/``tz``/``format`` attrs are untyped
    (``{"date": {}}`` accepts any value), so a collab step — or any doc JSON a
    client can write — can plant arbitrary values here. Every field is
    validated *before* it reaches the label or the URI, rather than trusted the
    way the parser (``markdown_parser._date_ref_to_node``) can trust its own
    checked output:

    - ``date`` must be a real ``YYYY-MM-DD`` calendar date; otherwise the atom
      is dropped (there is no valid ref to emit, and no meaningful label).
    - ``time`` must be a real ``HH:MM``; anything else is treated as date-only.
    - ``tz`` / ``format`` must be non-empty strings; otherwise ignored.

    A valid ``date``/``time`` contains only ``[0-9:T-]`` — none of which can
    break a markdown link — so the path is emitted without percent-encoding to
    stay byte-identical with the parser's plain-``str`` match. ``tz`` and
    ``format`` are free-form, so they ride as ``quote``-encoded query params,
    and the label is escaped by :func:`escape_date_label`. The atom never has a
    resolver URL, so the bare ``[label](canonical)`` form is emitted directly.
    """
    # @feat date: validate untrusted atom attrs before they reach label / URI
    date = attrs.get("date")
    if parse_ymd(date) is None:
        return None
    time = attrs.get("time")
    if parse_hm(time) is None:
        time = None
    tz = attrs.get("tz")
    if not (isinstance(tz, str) and tz):
        tz = None
    fmt = attrs.get("format")
    if not (isinstance(fmt, str) and fmt):
        fmt = None

    path = f"{date}T{time}" if time else date
    params = []
    # tz is only meaningful with a time (a calendar date is the same for
    # everyone); a stray tz on a date-only atom is dropped.
    if time and tz:
        params.append(f"tz={quote(tz, safe='')}")
    if fmt:
        params.append(f"fmt={quote(fmt, safe='')}")
    canonical = f"paper:/date/{path}"
    if params:
        canonical += "?" + "&".join(params)

    label = escape_date_label(
        format_date_label({"date": date, "time": time, "tz": tz, "format": fmt})
    )
    return f"[{label}]({canonical})"
