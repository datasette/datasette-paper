"""Unit tests for datasette_paper/date_atom.py — the `date` inline atom's
markdown serialization, split out of markdown.py.

Three concerns are covered: the deterministic label render (`format_date_label`
/ `strftime_date`, the byte-identical twin of frontend/src/lib/dateFormat.ts),
the hand-rolled (regex-free) attr validation (`parse_ymd` / `parse_hm`), and
`render_date_atom`, which must never crash and never let an untrusted attr break
out of the `[label](paper:/date/<uri>)` link — a `date` node's attrs can be
planted by any client that can write a collab step.
"""

import pathlib

import pytest

from datasette_paper import date_atom
from datasette_paper.date_atom import (
    escape_date_label,
    format_date_label,
    parse_hm,
    parse_ymd,
    render_date_atom,
    strftime_date,
    valid_date,
    valid_time,
)


# ---------------------------------------------------------------------------
# format_date_label + strftime_date — deterministic label render.
# These fixtures are shared byte-for-byte with
# frontend/src/lib/__tests__/dateFormat.test.ts; keep the tables in sync when
# either label renderer changes.
# ---------------------------------------------------------------------------

# (attrs, expected label) — mirrored in dateFormat.test.ts
DATE_LABEL_FIXTURES = [
    ({"date": "2026-07-20", "time": None, "tz": None}, "Jul 20, 2026"),
    ({"date": "2026-01-05", "time": None, "tz": None}, "Jan 5, 2026"),
    ({"date": "2026-12-25", "time": None, "tz": None}, "Dec 25, 2026"),
    ({"date": "1999-11-02", "time": None, "tz": None}, "Nov 2, 1999"),
    (
        {"date": "2026-07-20", "time": "15:00", "tz": "America/Los_Angeles"},
        "Jul 20, 2026 3:00 PM",
    ),
    ({"date": "2026-07-20", "time": "00:00", "tz": "UTC"}, "Jul 20, 2026 12:00 AM"),
    ({"date": "2026-07-20", "time": "12:00", "tz": "UTC"}, "Jul 20, 2026 12:00 PM"),
    (
        {"date": "2026-07-20", "time": "09:05", "tz": "Europe/London"},
        "Jul 20, 2026 9:05 AM",
    ),
    (
        {"date": "2026-07-20", "time": "23:30", "tz": "Asia/Tokyo"},
        "Jul 20, 2026 11:30 PM",
    ),
]


@pytest.mark.parametrize("attrs,expected", DATE_LABEL_FIXTURES)
def test_format_date_label_matches_fixtures(attrs, expected):
    assert format_date_label(attrs) == expected


def test_format_date_label_uses_format_with_appended_time():
    # The format styles the DATE; a time still auto-appends in the stored zone.
    label = format_date_label(
        {"date": "2026-07-20", "time": "15:00", "tz": "UTC", "format": "%A, %B %o"}
    )
    assert label == "Monday, July 20th 3:00 PM"


# strftime_date fixtures — mirrored byte-for-byte in dateFormat.test.ts.
# 2026-07-20 is a Monday (matches the dateParse NOW=2026-07-14 Tuesday fixture).
STRFTIME_FIXTURES = [
    ("%Y-%m-%d", 2026, 7, 20, "2026-07-20"),
    ("%b %-d, %Y", 2026, 7, 20, "Jul 20, 2026"),
    ("%B %-d, %Y", 2026, 7, 5, "July 5, 2026"),
    ("%A, %B %o", 2026, 7, 20, "Monday, July 20th"),
    ("%a %b %-d", 2026, 7, 20, "Mon Jul 20"),
    ("%m/%d/%y", 2026, 7, 5, "07/05/26"),
    ("%o", 2026, 7, 1, "1st"),
    ("%o", 2026, 7, 2, "2nd"),
    ("%o", 2026, 7, 3, "3rd"),
    ("%o", 2026, 7, 11, "11th"),
    ("%o", 2026, 7, 21, "21st"),
    ("%o", 2026, 7, 22, "22nd"),
    ("%o", 2026, 7, 23, "23rd"),
    ("%o", 2026, 7, 13, "13th"),
    ("100%% sure on the %-d", 2026, 7, 4, "100% sure on the 4"),
    ("%Q", 2026, 7, 4, "%Q"),  # unknown directive passes through literally
    ("%", 2026, 7, 4, "%"),  # a trailing bare % is emitted literally
    ("%-", 2026, 7, 4, "%-"),  # a trailing dash-only directive too
    ("%-Q", 2026, 7, 4, "%-Q"),  # unknown dash directive keeps its dash
    ("just text", 2026, 7, 4, "just text"),  # no directives at all
]


@pytest.mark.parametrize("fmt,y,m,d,expected", STRFTIME_FIXTURES)
def test_strftime_date_matches_fixtures(fmt, y, m, d, expected):
    assert strftime_date(fmt, y, m, d) == expected


def test_strftime_weekday_is_monday_zero():
    # %A/%a index off datetime.date.weekday() (Monday=0). 2026-07-20 is a Monday.
    assert strftime_date("%A", 2026, 7, 20) == "Monday"
    assert strftime_date("%a", 2026, 7, 26) == "Sun"  # the following Sunday


@pytest.mark.parametrize(
    "month,full,abbr",
    [
        (1, "January", "Jan"),
        (2, "February", "Feb"),
        (3, "March", "Mar"),
        (4, "April", "Apr"),
        (5, "May", "May"),
        (6, "June", "Jun"),
        (7, "July", "Jul"),
        (8, "August", "Aug"),
        (9, "September", "Sep"),
        (10, "October", "Oct"),
        (11, "November", "Nov"),
        (12, "December", "Dec"),
    ],
)
def test_strftime_date_covers_every_month_name(month, full, abbr):
    assert strftime_date("%B|%b|%m|%-m", 2026, month, 1) == (
        f"{full}|{abbr}|{month:02d}|{month}"
    )


@pytest.mark.parametrize(
    "day,full,abbr",
    [
        (20, "Monday", "Mon"),
        (21, "Tuesday", "Tue"),
        (22, "Wednesday", "Wed"),
        (23, "Thursday", "Thu"),
        (24, "Friday", "Fri"),
        (25, "Saturday", "Sat"),
        (26, "Sunday", "Sun"),
    ],
)
def test_strftime_date_covers_every_weekday_name(day, full, abbr):
    assert strftime_date("%A|%a", 2026, 7, day) == f"{full}|{abbr}"


@pytest.mark.parametrize(
    "day,expected",
    [
        (1, "1st"),
        (2, "2nd"),
        (3, "3rd"),
        (4, "4th"),
        (5, "5th"),
        (6, "6th"),
        (7, "7th"),
        (8, "8th"),
        (9, "9th"),
        (10, "10th"),
        (11, "11th"),
        (12, "12th"),
        (13, "13th"),
        (14, "14th"),
        (15, "15th"),
        (16, "16th"),
        (17, "17th"),
        (18, "18th"),
        (19, "19th"),
        (20, "20th"),
        (21, "21st"),
        (22, "22nd"),
        (23, "23rd"),
        (24, "24th"),
        (25, "25th"),
        (26, "26th"),
        (27, "27th"),
        (28, "28th"),
        (29, "29th"),
        (30, "30th"),
        (31, "31st"),
    ],
)
def test_strftime_date_ordinal_for_every_possible_day(day, expected):
    # January accepts the full 1-31 range, including every suffix edge.
    assert strftime_date("%o", 2024, 1, day) == expected


@pytest.mark.parametrize(
    "fmt,expected",
    [
        ("", ""),
        ("%%", "%"),
        ("%%%%", "%%"),
        ("%%Y", "%Y"),
        ("%%%Y", "%2026"),
        ("x%Yy", "x2026y"),
        ("%Y%m%d", "20260705"),
        ("%-Y|%-y|%-B|%-b|%-o|%-A|%-a|%-%", "2026|26|July|Jul|5th|Sunday|Sun|%"),
        ("%--d", "%--d"),
        ("%_", "%_"),
        ("%💥", "%💥"),
        ("before %Q after %-Z end", "before %Q after %-Z end"),
    ],
)
def test_strftime_date_stresses_directive_scanner(fmt, expected):
    assert strftime_date(fmt, 2026, 7, 5) == expected


@pytest.mark.parametrize(
    "year,expected_y,expected_short",
    [
        (1, "1", "01"),
        (9, "9", "09"),
        (99, "99", "99"),
        (100, "100", "00"),
        (1999, "1999", "99"),
        (2000, "2000", "00"),
        (2026, "2026", "26"),
        (9999, "9999", "99"),
    ],
)
def test_strftime_date_year_boundaries(year, expected_y, expected_short):
    assert strftime_date("%Y|%y", year, 1, 1) == f"{expected_y}|{expected_short}"


@pytest.mark.parametrize(
    "year,month,day",
    [
        (2023, 2, 29),
        (2024, 2, 30),
        (2026, 0, 1),
        (2026, 13, 1),
        (2026, 1, 0),
        (2026, 1, 32),
    ],
)
def test_strftime_date_rejects_invalid_calendar_dates(year, month, day):
    # Weekday calculation validates inputs before any directive is scanned,
    # even for an empty or literal-only format.
    with pytest.raises(ValueError):
        strftime_date("literal only", year, month, day)


# ---------------------------------------------------------------------------
# parse_ymd — hand-rolled YYYY-MM-DD shape scan + datetime calendar check.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "date,expected",
    [
        ("2026-07-20", (2026, 7, 20)),
        ("2024-02-29", (2024, 2, 29)),  # leap day (datetime confirms)
        ("2000-02-29", (2000, 2, 29)),  # 2000 is a leap year (÷400)
        ("0001-01-01", (1, 1, 1)),  # datetime's minimum year
        ("9999-12-31", (9999, 12, 31)),  # datetime's maximum year
    ],
)
def test_parse_ymd_valid(date, expected):
    assert parse_ymd(date) == expected


@pytest.mark.parametrize(
    "date",
    [
        "2026-02-29",  # 2026 not a leap year
        "2026-02-30",  # never a valid Feb day
        "2026-13-01",  # month 13
        "2026-00-05",  # month 0
        "2026-07-00",  # day 0
        "2026-07-32",  # day 32
        "0000-01-01",  # year 0 — below datetime.MINYEAR
        "2026-7-20",  # month not zero-padded → wrong length
        "2026-07-2",  # day not zero-padded → wrong length
        "26-07-20",  # 2-digit year → wrong length
        "2026/07/20",  # wrong separators
        "2026-07-20 ",  # trailing space → wrong length
        " 2026-07-20",  # leading space → wrong length
        "2026-07-2x",  # non-digit
        "202a-07-20",  # non-digit in year
        "2026-07-20T12:00",  # a datetime, not a bare date
        "",  # empty
        "garbage",  # nonsense
        "----------",  # right length, all separators
    ],
)
def test_parse_ymd_invalid_returns_none(date):
    assert parse_ymd(date) is None


@pytest.mark.parametrize("date", [None, 20260720, 2026, True, ["2026-07-20"], {}, 1.5])
def test_parse_ymd_non_string_returns_none(date):
    assert parse_ymd(date) is None


def test_parse_ymd_rejects_unicode_digits():
    # str.isdigit() would accept these; int() would then choke. The ASCII-only
    # hand scan rejects them up front.
    assert parse_ymd("2026-07-²²") is None  # superscript twos
    assert parse_ymd("２026-07-20"[:10]) is None  # fullwidth digit


# ---------------------------------------------------------------------------
# parse_hm — hand-rolled HH:MM shape scan + datetime range check.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "time,expected",
    [
        ("00:00", (0, 0)),
        ("09:05", (9, 5)),
        ("15:30", (15, 30)),
        ("23:59", (23, 59)),
    ],
)
def test_parse_hm_valid(time, expected):
    assert parse_hm(time) == expected


@pytest.mark.parametrize(
    "time",
    [
        "24:00",  # hour 24
        "25:00",  # hour 25
        "12:60",  # minute 60
        "99:99",  # both out of range
        "1:00",  # hour not padded → wrong length
        "12:0",  # minute not padded → wrong length
        "12-00",  # wrong separator
        "12:00 ",  # trailing space → wrong length
        "12:0a",  # non-digit
        "noon",  # nonsense
        "",  # empty
        "12:00) evil",  # injection payload → wrong length anyway
    ],
)
def test_parse_hm_invalid_returns_none(time):
    assert parse_hm(time) is None


@pytest.mark.parametrize("time", [None, 1200, True, ["12:00"], {}])
def test_parse_hm_non_string_returns_none(time):
    assert parse_hm(time) is None


def test_valid_date_and_valid_time_are_bool_wrappers():
    assert valid_date("2026-07-20") is True
    assert valid_date("2026-02-30") is False
    assert valid_time("23:59") is True
    assert valid_time("24:00") is False


# ---------------------------------------------------------------------------
# escape_date_label — make a label inert markdown link text.
# ---------------------------------------------------------------------------


def test_escape_date_label_leaves_ordinary_text_untouched():
    assert escape_date_label("Jul 20, 2026 3:00 PM") == "Jul 20, 2026 3:00 PM"
    assert escape_date_label("Monday, July 20th") == "Monday, July 20th"


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("<img src=x>", "\\<img src=x\\>"),  # angle brackets → no raw HTML tag
        ("a[b]c", "a\\[b\\]c"),  # link brackets escaped
        ("*_`\\", "\\*\\_\\`\\\\"),  # inline-markup set escaped
        ("plain", "plain"),
    ],
)
def test_escape_date_label_escapes_metacharacters(raw, expected):
    assert escape_date_label(raw) == expected


def test_escape_date_label_collapses_newlines_to_single_space():
    # A blank line inside [...] would close the link and inject block markdown;
    # every run of newlines collapses to a single space.
    assert escape_date_label("x\n\n# PWNED\n\n") == "x # PWNED "
    assert escape_date_label("a\r\nb") == "a b"
    assert escape_date_label("a\n\n\n\nb") == "a b"
    assert "\n" not in escape_date_label("line1\nline2")


# ---------------------------------------------------------------------------
# render_date_atom — the serializer entry point markdown.py calls.
# ---------------------------------------------------------------------------


def test_render_date_only():
    assert (
        render_date_atom({"date": "2026-07-20"})
        == "[Jul 20, 2026](paper:/date/2026-07-20)"
    )


def test_render_timed_with_tz_query():
    assert render_date_atom(
        {"date": "2026-07-20", "time": "15:00", "tz": "America/Los_Angeles"}
    ) == (
        "[Jul 20, 2026 3:00 PM](paper:/date/2026-07-20T15:00?tz=America%2FLos_Angeles)"
    )


def test_render_timed_without_tz_omits_query():
    assert (
        render_date_atom({"date": "2026-07-20", "time": "09:05"})
        == "[Jul 20, 2026 9:05 AM](paper:/date/2026-07-20T09:05)"
    )


def test_render_date_only_drops_stray_tz():
    # tz is only meaningful with a time; a date-only atom never emits one.
    assert (
        render_date_atom({"date": "2026-07-20", "time": None, "tz": "UTC"})
        == "[Jul 20, 2026](paper:/date/2026-07-20)"
    )


def test_render_with_format_serializes_fmt_param():
    assert (
        render_date_atom({"date": "2026-07-20", "time": None, "format": "%Y-%m-%d"})
        == "[2026-07-20](paper:/date/2026-07-20?fmt=%25Y-%25m-%25d)"
    )


def test_render_with_tz_and_format_serializes_both_params():
    assert render_date_atom(
        {
            "date": "2026-07-20",
            "time": "15:00",
            "tz": "America/Los_Angeles",
            "format": "%b %-d",
        }
    ) == (
        "[Jul 20 3:00 PM]"
        "(paper:/date/2026-07-20T15:00?tz=America%2FLos_Angeles&fmt=%25b%20%25-d)"
    )


# --- robustness: untrusted attrs must never crash or inject ---


@pytest.mark.parametrize(
    "bad_date",
    [
        "garbage",
        "--",
        "2026-13-01",  # month 13
        "2026-00-05",  # month 0
        "2026-02-30",  # Feb 30
        "2026-07-20-99",  # too many parts
        "999999999999-01-01",  # out-of-shape huge year
        "2026-7-2",  # unpadded
        "2026-07-20) <script>alert(1)</script>",  # junk suffix / URL injection
        "",
    ],
)
def test_render_invalid_date_dropped(bad_date):
    assert render_date_atom({"date": bad_date}) is None


@pytest.mark.parametrize("bad_date", [None, 123, {"y": 2026}, ["2026-07-20"], True])
def test_render_non_string_date_dropped(bad_date):
    assert render_date_atom({"date": bad_date}) is None


def test_render_missing_date_dropped():
    assert render_date_atom({}) is None


@pytest.mark.parametrize(
    "bad_time", ["25:00", "12:60", "1:00", "12:00) evil", 1500, True]
)
def test_render_invalid_time_falls_back_to_date_only(bad_time):
    # A bad time can't form a valid T<HH:MM> path, so it is ignored and the
    # atom renders as a plain calendar date (never a broken URL / injected text).
    assert (
        render_date_atom({"date": "2026-07-20", "time": bad_time})
        == "[Jul 20, 2026](paper:/date/2026-07-20)"
    )


@pytest.mark.parametrize("bad_format", [123, True, {"kind": "x"}, ["%Y"], ""])
def test_render_non_string_or_empty_format_ignored(bad_format):
    assert (
        render_date_atom({"date": "2026-07-20", "format": bad_format})
        == "[Jul 20, 2026](paper:/date/2026-07-20)"
    )


@pytest.mark.parametrize("bad_tz", [123, True, ["UTC"], ""])
def test_render_non_string_or_empty_tz_dropped(bad_tz):
    assert (
        render_date_atom({"date": "2026-07-20", "time": "12:00", "tz": bad_tz})
        == "[Jul 20, 2026 12:00 PM](paper:/date/2026-07-20T12:00)"
    )


def test_render_format_html_is_escaped_in_label():
    md = render_date_atom(
        {"date": "2026-07-20", "format": "<img src=x onerror=alert(1)>"}
    )
    assert md.startswith("[\\<img src=x onerror=alert(1)\\>](paper:/date/")
    assert md.endswith(")")
    # No unescaped angle bracket a raw-HTML renderer would treat as a tag.
    assert md.count("<") == md.count("\\<")
    assert md.count(">") == md.count("\\>")


def test_render_format_newlines_flattened_in_label():
    md = render_date_atom({"date": "2026-07-20", "format": "x\n\n# PWNED\n\n"})
    # The whole atom is one line — no blank line closes the link, no heading.
    assert "\n" not in md
    assert md.startswith("[") and "](paper:/date/" in md


def test_render_format_bracket_does_not_break_link():
    md = render_date_atom({"date": "2026-07-20", "format": "a](javascript:alert(1))b"})
    # The `]` is escaped so the injected `(javascript:...)` stays inert label
    # text; the real destination is still the paper:/date/ ref.
    assert md.startswith("[a\\](javascript:alert(1))b](paper:/date/2026-07-20")
    assert "](javascript:" not in md.replace("\\]", "")


def test_render_tz_injection_is_percent_encoded():
    md = render_date_atom({"date": "2026-07-20", "time": "12:00", "tz": "a) <b> /Zone"})
    # tz rides as a quoted query param — no raw `)`, space, or `<` escapes into
    # the link, so it can't truncate the destination or inject markup.
    assert md == (
        "[Jul 20, 2026 12:00 PM]"
        "(paper:/date/2026-07-20T12:00?tz=a%29%20%3Cb%3E%20%2FZone)"
    )


def test_render_format_injection_is_percent_encoded_in_query():
    md = render_date_atom({"date": "2026-07-20", "format": "a) [x](y) <b>"})
    query = md.split("?", 1)[1].rstrip(")")
    # Every metacharacter in the fmt query param is percent-encoded.
    for ch in "() []<>":
        if ch == " ":
            assert " " not in query
        elif ch != "":
            assert ch not in query


# ---------------------------------------------------------------------------
# round-trip through the markdown parser (the URI is the source of truth).
# ---------------------------------------------------------------------------


def _doc_with_date(attrs):
    return {
        "type": "doc",
        "content": [
            {"type": "paragraph", "content": [{"type": "date", "attrs": attrs}]}
        ],
    }


def test_hostile_but_valid_attrs_roundtrip_losslessly():
    from datasette_paper.markdown import doc_to_markdown
    from datasette_paper.markdown_parser import markdown_to_doc

    attrs = {
        "date": "2026-07-20",
        "time": "15:00",
        "tz": "America/Los_Angeles",
        "format": "<b>%A</b> [x](y) *_`",
    }
    md1 = doc_to_markdown(_doc_with_date(attrs))
    back = markdown_to_doc(md1)
    assert back["content"][0]["content"][0]["attrs"] == attrs
    assert doc_to_markdown(back) == md1  # stable second pass


def test_default_label_roundtrips():
    from datasette_paper.markdown import doc_to_markdown
    from datasette_paper.markdown_parser import markdown_to_doc

    attrs = {"date": "2026-07-20", "time": None, "tz": None, "format": None}
    md1 = doc_to_markdown(_doc_with_date(attrs))
    assert doc_to_markdown(markdown_to_doc(md1)) == md1


# ---------------------------------------------------------------------------
# guardrail: the module stays regex-free (hand-rolled parsing, per the design).
# ---------------------------------------------------------------------------


def test_date_atom_module_uses_no_regex():
    src = pathlib.Path(date_atom.__file__).read_text()
    for needle in ("import re", "import regex", "re.compile(", "re.match(", "re.sub("):
        assert needle not in src, f"date_atom.py should be regex-free, found {needle!r}"
