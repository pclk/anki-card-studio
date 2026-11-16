#!/usr/bin/env python3
"""
anki_helper.py - toolkit for building highly descriptive, image-rich Anki cards
inside an AI chat (Claude's code-execution sandbox).

As a Claude skill (Claude Code / any machine with Python):

    import sys; sys.path.insert(0, "<skill_dir>/scripts")
    from anki_helper import *                          # then the same API as below
    # env vars (set before import): ANKI_OUT_DIR = where anki_bundle.json goes (default ./anki_out),
    #                               ANKI_MATERIAL_DIR = extra folder searched by find_upload()
    # deps: uv run --with pymupdf --with pillow --with matplotlib --with latex2mathml python build_deck.py

Quick start (inside the chat's code tool):

    exec(open(find_upload("anki_helper.py")).read())   # or: exec(open("/mnt/user-data/uploads/anki_helper.py").read())
    deck = Deck("Biology::Cell Biology")

    # images ----------------------------------------------------------------
    pdf  = find_upload("lecture")                      # fuzzy-find an uploaded file
    pdf_figures(pdf)                                   # list embedded figures + positions
    fig1 = deck.pdf_figure(pdf, page=3, index=0, name="mitochondrion")
    crop = deck.crop_pdf(pdf, page=4, box=(0.1, 0.3, 0.9, 0.7), name="etc_diagram")
    flow = deck.flowchart(["Glycolysis", "Krebs cycle", "ETC"], name="resp_flow")
    photo = deck.web_image("https://commons.wikimedia.org/wiki/Special:FilePath/Animal_mitochondrion_diagram_en.svg?width=800",
                           name="mito_photo", credit="Wikimedia Commons")
    todo = deck.material("cristae_em", hint="lecture.pdf p.5, electron micrograph top-right")

    # cards -----------------------------------------------------------------
    deck.add_basic(
        front="What is the main function of the mitochondrion?",
        back=answer("ATP production by oxidative phosphorylation")
             + box("why", "The inner membrane holds the electron transport chain ...")
             + img(fig1, "Mitochondrion structure"),
        extra=box("mnemonic", "'Mighty-chondria' - the powerhouse"),
        source="lecture.pdf p.3", tags=["organelles"])
    deck.add_cloze("The {{c1::Krebs cycle}} occurs in the {{c2::mitochondrial matrix}}.",
                   extra=img(flow), source="p.4")

    deck.validate()
    deck.save()          # -> anki_bundle.json (cards + images) for the Anki Card Studio website

Call help() for the full API.  Every field is HTML.  Use the filename RETURNED by an
image function (extensions may change during compression) when referencing images.
"""

import base64
import datetime
import hashlib
import html as _html
import io
import json
import os
import re
import sys
import textwrap
import warnings
import zipfile

FORMAT = "anki-studio/v1"

# styling of the Studio preview and the exported note type (kept in step with anki_card_studio.html)
CARD_CSS = r'''.card{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:19px;line-height:1.55;color:#1f2328;background:#fbfbfa;text-align:left;padding:18px 20px}
.aa-wrap{max-width:760px;margin:0 auto}
.aa-src-shot img{display:block;max-width:100%;margin-top:6px;border:1px solid rgba(127,127,127,.35);border-radius:6px}
.aa-src-excerpt{margin-top:6px;padding:6px 10px;border-left:3px solid #e0a000;background:rgba(224,160,0,.07);border-radius:0 6px 6px 0;font-size:.92em;white-space:pre-wrap;line-height:1.45}
.aa-src-excerpt mark{background:rgba(255,214,0,.55);color:inherit;border-radius:2px;padding:0 1px}
.nightMode .aa-src-excerpt mark{background:rgba(255,196,0,.35)}
.front{font-size:1.12em;font-weight:600;line-height:1.4}
hr#answer{border:none;border-top:2px solid #d0d7de;margin:16px 0}
.aa-answer{font-size:1.05em;font-weight:700;color:#0b4f9c;background:#e8f1fb;border-radius:8px;padding:8px 12px;margin:2px 0 10px}
.extra{margin-top:14px;padding-top:10px;border-top:1px dashed #d0d7de;font-size:.92em;color:#3d444d}
.source{margin-top:12px;font-size:.7em;color:#8b949e}
img{max-width:100%;max-height:440px;height:auto;display:block;margin:12px auto;border-radius:6px}
figure.aa-fig{margin:12px 0;text-align:center}
figure.aa-fig img{margin-bottom:4px}
figcaption{font-size:.78em;color:#59636e}
.aa-box{border-left:4px solid #8b949e;background:rgba(139,148,158,.10);border-radius:6px;padding:8px 12px;margin:10px 0;font-size:.94em}
.aa-box-title{font-size:.7em;font-weight:700;text-transform:uppercase;letter-spacing:.06em;opacity:.75;margin-bottom:2px}
.aa-key{border-color:#0969da;background:rgba(9,105,218,.08)}
.aa-why{border-color:#8250df;background:rgba(130,80,223,.08)}
.aa-example{border-color:#1a7f37;background:rgba(26,127,55,.08)}
.aa-mnemonic{border-color:#bf8700;background:rgba(191,135,0,.10)}
.aa-warning{border-color:#cf222e;background:rgba(207,34,46,.08)}
.aa-compare{border-color:#0598bc;background:rgba(5,152,188,.08)}
.aa-clinical{border-color:#bc4c00;background:rgba(188,76,0,.08)}
.aa-method{border-color:#1f6feb;background:rgba(31,111,235,.07)}
.aa-method ol,.aa-method ul{margin:4px 0;padding-left:1.3em}
.aa-check{border-color:#2da44e;background:rgba(45,164,78,.08)}
.aa-purpose{margin-top:14px;font-size:.85em;border-top:1px dashed #d0d7de;padding-top:6px;color:#424a53}
.aa-purpose summary{cursor:pointer;font-weight:600;color:#57606a}
.aa-purpose p{margin:.4em 0}
.nightMode .aa-purpose,.night_mode .aa-purpose{border-color:#3d444d;color:#c9d1d9}
.nightMode .aa-purpose summary,.night_mode .aa-purpose summary{color:#9198a1}
table{border-collapse:collapse;margin:10px auto;font-size:.88em}
/* narrow screens: nothing sticks out of the card. Long words wrap; wide tables, equations and code scroll sideways */
.card{overflow-wrap:break-word}
:not(pre)>code{overflow-wrap:anywhere}
table{display:block;width:fit-content;max-width:100%;overflow-x:auto}
math[display=block],.katex-display{display:block;max-width:100%;overflow-x:auto;overflow-y:hidden}
pre{max-width:100%}
td,th{border:1px solid #d0d7de;padding:4px 9px;vertical-align:top}
th{background:rgba(127,127,127,.12)}
ul,ol{margin:6px 0;padding-left:1.4em}
li{margin:2px 0}
.cloze{font-weight:700;color:#0969da}
.nightMode.card,.nightMode .card{color:#e6edf3;background:#1c1f24}
.nightMode .aa-answer{color:#9cc6ff;background:rgba(56,139,253,.15)}
.nightMode hr#answer,.nightMode .extra{border-color:#3d444d}
.nightMode .extra{color:#c9d1d9}
.nightMode figcaption{color:#9198a1}
.nightMode td,.nightMode th{border-color:#3d444d}
.nightMode .cloze{color:#6cb6ff}'''
HLJS_CSS = r'''pre{background:#f6f8fa;color:#1f2328;border:1px solid #d0d7de;border-radius:8px;padding:10px 12px;overflow-x:auto;font-size:.82em;line-height:1.45;text-align:left}
pre code,code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
:not(pre)>code{background:rgba(127,127,127,.15);border-radius:4px;padding:.1em .35em;font-size:.88em}
.hljs-keyword,.hljs-selector-tag,.hljs-type,.hljs-meta .hljs-keyword{color:#cf222e}.hljs-string,.hljs-regexp,.hljs-meta .hljs-string{color:#0a3069}
.hljs-number,.hljs-literal,.hljs-variable.language_,.hljs-attr,.hljs-attribute{color:#0550ae}.hljs-title,.hljs-title.function_,.hljs-title.class_{color:#8250df}
.hljs-comment,.hljs-quote{color:#6e7781;font-style:italic}.hljs-built_in,.hljs-symbol{color:#953800}.hljs-meta{color:#116329}.hljs-tag,.hljs-name{color:#116329}
.nightMode pre{background:#161b22;color:#e6edf3;border-color:#30363d}
.nightMode .hljs-keyword,.nightMode .hljs-selector-tag,.nightMode .hljs-type{color:#ff7b72}.nightMode .hljs-string,.nightMode .hljs-regexp{color:#a5d6ff}
.nightMode .hljs-number,.nightMode .hljs-literal,.nightMode .hljs-attr,.nightMode .hljs-attribute{color:#79c0ff}.nightMode .hljs-title,.nightMode .hljs-title.function_,.nightMode .hljs-title.class_{color:#d2a8ff}
.nightMode .hljs-comment,.nightMode .hljs-quote{color:#8b949e}.nightMode .hljs-built_in,.nightMode .hljs-symbol{color:#ffa657}.nightMode .hljs-meta,.nightMode .hljs-tag,.nightMode .hljs-name{color:#7ee787}'''
UPLOAD_DIRS = ([os.environ["ANKI_MATERIAL_DIR"]] if os.environ.get("ANKI_MATERIAL_DIR") else []) + \
              ["/mnt/user-data/uploads", "/mnt/data", "/mnt/user-data", os.getcwd()]
MAX_PX = 1400            # longest side of stored images
START = "<<<ANKI_CARDS"
END = "ANKI_CARDS>>>"


def _out_dir():
    if os.environ.get("ANKI_OUT_DIR"):
        os.makedirs(os.environ["ANKI_OUT_DIR"], exist_ok=True)
        return os.path.abspath(os.environ["ANKI_OUT_DIR"])
    for d in ("/mnt/user-data/outputs",):
        if os.path.isdir(d) and os.access(d, os.W_OK):
            return d
    d = os.path.join(os.getcwd(), "anki_out")
    os.makedirs(d, exist_ok=True)
    return d


OUT_DIR = _out_dir()


# --------------------------------------------------------------------------- deps
def _pil():
    try:
        from PIL import Image
        return Image
    except ImportError:
        raise RuntimeError("Pillow is required for images: pip install pillow")


def _plt():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    # per-glyph fallback (matplotlib >= 3.6): maths symbols, arrows, CJK where installed
    matplotlib.rcParams["font.family"] = ["DejaVu Sans", "STIXGeneral", "DejaVu Sans Mono", "Noto Sans CJK SC", "sans-serif"]
    matplotlib.rcParams["mathtext.fontset"] = "dejavusans"
    return plt


def _pymupdf():
    try:
        import pymupdf
        return pymupdf
    except ImportError:
        pass
    try:
        import fitz
        return fitz
    except ImportError:
        return None


# --------------------------------------------------------------------------- files
def list_uploads():
    """List files the user uploaded to the chat."""
    seen, out = set(), []
    for d in UPLOAD_DIRS:
        if not os.path.isdir(d):
            continue
        for root, dirs, files in os.walk(d):
            if root.count(os.sep) - d.count(os.sep) > 1:
                continue
            for f in files:
                p = os.path.join(root, f)
                if p not in seen and not p.startswith(OUT_DIR):
                    seen.add(p)
                    out.append(p)
    return sorted(out)


def find_upload(fragment):
    """Return the path of the first uploaded file whose name contains `fragment` (case-insensitive)."""
    if os.path.exists(fragment):
        return fragment
    frag = fragment.lower()
    hits = [p for p in list_uploads() if frag in os.path.basename(p).lower()]
    if not hits:
        raise FileNotFoundError(f"No uploaded file matching {fragment!r}. Uploads: {list_uploads()}")
    return hits[0]


# --------------------------------------------------------------------------- HTML helpers
def esc(s):
    """Escape plain text for use inside HTML fields."""
    return _html.escape(str(s), quote=False)


def img(name, caption=None, width=None):
    """<img> tag (optionally with caption) for an image registered on the deck."""
    style = f' style="max-width:{int(width)}px"' if width else ""
    tag = f'<img src="{name}"{style}>'
    if caption:
        return f'<figure class="aa-fig">{tag}<figcaption>{caption}</figcaption></figure>'
    return tag


BOX_TITLES = {"key": "Key point", "why": "Why / how", "example": "Example", "method": "Method", "check": "Check",
              "mnemonic": "Mnemonic", "warning": "Common pitfall", "note": "Note", "compare": "Compare", "clinical": "Application"}

# tags the note type is styled for; anything else is flagged by validate()
ALLOWED_TAGS = {"b", "strong", "i", "em", "u", "s", "sub", "sup", "br", "hr", "p", "div", "span", "ul", "ol", "li",
                "table", "thead", "tbody", "tr", "th", "td", "pre", "code", "img", "figure", "figcaption", "mark",
                "small", "h3", "h4", "a", "blockquote", "kbd"}


def box(kind, content, title=None):
    """Styled call-out box. kind: key | why | example | method | check | mnemonic | warning | note | compare | clinical.
    method = the worked steps of a technique, check = how to verify an answer."""
    if kind not in BOX_TITLES:
        raise ValueError(f"box kind {kind!r} is not one of: {', '.join(BOX_TITLES)}")
    t = BOX_TITLES[kind] if title is None else title
    head = f'<div class="aa-box-title">{t}</div>' if t else ""
    return f'<div class="aa-box aa-{kind}">{head}{content}</div>'


def rationale(tests, matters, mistake=None, connects=None, context=None):
    """The card's why= : an explanation of why the card exists, shown to the user while reviewing (and, if they choose,
    on the card). Write each part as 1-3 full sentences specific to THIS card - no generic filler.
      tests    what exactly the card checks, and what a complete answer must show
      matters  why it is worth remembering: where it comes up (later lectures, labs, exams, real code / practice) and
               what goes wrong if you don't know it
      mistake  the typical misconception or slip the card guards against
      connects prerequisites and related ideas (other cards, earlier/later topics)
      context  optional: where in the material it comes from, how the lecturer framed it, exam weighting…"""
    parts = [("Tests", tests), ("Why it matters", matters), ("Common mistake", mistake),
             ("Connects to", connects), ("Context", context)]
    return "".join(f"<p><b>{k}:</b> {v.strip()}</p>" for k, v in parts if v and str(v).strip())


def answer(text):
    """The one-line direct answer, shown prominently at the top of the back."""
    return f'<div class="aa-answer">{text}</div>'


def bullets(items, ordered=False):
    tag = "ol" if ordered else "ul"
    return f"<{tag}>" + "".join(f"<li>{i}</li>" for i in items) + f"</{tag}>"


def table(headers, rows):
    h = "".join(f"<th>{c}</th>" for c in headers)
    b = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
    return f'<table class="aa-table"><thead><tr>{h}</tr></thead><tbody>{b}</tbody></table>'


def cloze(text, n=1, hint=None):
    text = fix_math(str(text))
    if text.endswith("}"):
        text += " "          # "...}}}" would close the deletion one brace early
    return "{{c%d::%s%s}}" % (n, text, f"::{hint}" if hint else "")


def code(text, lang=None, inline=False):
    """Code on a card, escaped. Block: <pre><code class="language-java">; the Studio highlights it and
    bakes the colours into the export. Never style code blocks yourself (no background/colour)."""
    t = _html.escape(textwrap.dedent(str(text)).strip("\n"), quote=False)
    if inline:
        return f"<code>{t}</code>"
    return f'<pre><code class="language-{lang}">{t}</code></pre>' if lang else f"<pre><code>{t}</code></pre>"


def tex(expr, display=False):
    """Maths for Anki's MathJax: \\( … \\) inline, \\[ … \\] display. Write LaTeX, e.g. tex(r"\\frac{a}{b}").
    $…$ / $$…$$ in card text also works: the helper converts it to these delimiters."""
    expr = str(expr).replace("}}", "} }").replace("}}", "} }")
    return f"\\[{expr}\\]" if display else f"\\({expr}\\)"


# --------------------------------------------------------------------------- maths
_CODE_RE = re.compile(r"(<pre[\s\S]*?</pre>|<code[\s\S]*?</code>)", re.I)
_MATH_RE = re.compile(r"\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]")
_DD_RE = re.compile(r"(?<![\\$])\$\$([\s\S]+?)\$\$(?!\$)")
_D_RE = re.compile(r"(?<![\\$\w])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?![\w$])")


def _texlike(m):
    """$…$ that is maths, not money ("$5 and $10", "$5-$10")"""
    body = m.group(1)
    return not (re.match(r"\d", body) and not re.search(r"[\\^_{}=]", body))


def fix_math(html):
    """Normalise maths in card HTML (outside <pre>/<code>):
    $$…$$ → \\[…\\], $…$ → \\(…\\) (money like "$5" is left alone), and "}}" inside maths → "} }"
    so it can't end a {{c1::…}} cloze early. Idempotent. add_*/update/save apply it for you."""
    if not html:
        return html
    html = re.sub(r"(<img\b[^>]*?\bsrc=)'([^']*)'", r'\1"\2"', str(html))   # src='x' → src="x"
    if "$" not in html and "}}" not in html and "<" not in html:
        return html
    out = []
    for part in _CODE_RE.split(str(html)):
        if _CODE_RE.fullmatch(part or ""):
            out.append(part); continue
        part = _DD_RE.sub(lambda m: "\\[" + m.group(1).strip() + "\\]", part)
        part = _D_RE.sub(lambda m: "\\(" + m.group(1) + "\\)" if _texlike(m) else m.group(0), part)

        def _braces(m):
            t = m.group(0)
            t = t[:2] + _space_braces(t[2:-2]) + t[-2:]
            # a raw < or > in maths would be read as an HTML tag ("a<b") - escape it; the browser decodes it for MathJax
            parts = re.split(r"(</?(?:span|br|b|i|u|sub|sup)\b[^<>]*>)", t[2:-2])
            body = "".join(q if i % 2 else q.replace("<", "&lt;").replace(">", "&gt;") for i, q in enumerate(parts))
            return t[:2] + body + t[-2:]
        part = _MATH_RE.sub(_braces, part)
        out.append(part)
    return "".join(out)


def _space_braces(body):
    """Inside maths, keep LaTeX's closing braces from forming "}}" (Anki would end a cloze there) while leaving
    the real "}}" that closes a {{c1::…}} deletion alone: "\\sqrt{\\frac{a}{b}}" → "\\sqrt{\\frac{a}{b} }"."""
    out, stack, i = [], [], 0
    prev_brace = False                       # last thing emitted was a LaTeX "}"
    while i < len(body):
        m = re.match(r"\{\{c\d+::", body[i:])
        if m:
            out.append(m.group(0)); stack.append("cz"); i += len(m.group(0)); prev_brace = False; continue
        ch = body[i]
        if ch == "\\" and i + 1 < len(body):
            out.append(body[i:i + 2]); i += 2; prev_brace = False; continue
        if ch == "{":
            stack.append("{"); out.append(ch); prev_brace = False
        elif ch == "}":
            if stack and stack[-1] == "cz" and body[i + 1:i + 2] == "}":
                stack.pop()
                if prev_brace:
                    out.append(" ")
                out.append("}}"); i += 2; prev_brace = False; continue
            if stack and stack[-1] == "{":
                stack.pop()
            if prev_brace:
                out.append(" ")
            out.append(ch); prev_brace = True
        else:
            out.append(ch); prev_brace = False
        i += 1
    return "".join(out)


def _plain_lines(html):
    t = re.sub(r"<pre[\s\S]*?</pre>", " [code] ", str(html or ""), flags=re.I)
    t = re.sub(r"</?(br|p|div|li|tr|h\d)\b[^>]*>", "\n", t, flags=re.I)
    t = _html.unescape(re.sub(r"<[^>]+>", "", t))
    return [ln.strip() for ln in t.split("\n") if ln.strip()]


def _multi_question(c):
    """Signs that one card asks several questions (each should be its own card)."""
    probs = []
    q = c.get("text") if c.get("type") == "cloze" else c.get("front")
    a = "" if c.get("type") == "cloze" else c.get("back")
    raw_q = str(q or "")
    numbered_q = len(re.findall(r"<li\b", raw_q, re.I)) if re.search(r"<ol\b", raw_q, re.I) else 0
    numbered_q = max(numbered_q, sum(1 for ln in _plain_lines(raw_q) if re.match(r"^(\(?\d+[.):]|\(?[a-h]\)|[ivx]+[.)])\s", ln)))
    plain_a = " ".join(_plain_lines(a))
    mapped = len(re.findall(r"(?:^|[\s;,(])\(?\d+\)?\s*(?:→|->|=>|:)\s*\S", plain_a))
    qmarks = len(re.findall(r"\?(?=\s|$|<)", re.sub(r"<pre[\s\S]*?</pre>|<code[\s\S]*?</code>", "", raw_q)))
    if c.get("type") != "cloze" and numbered_q >= 2 and (mapped >= 2 or len(_plain_lines(a)) >= numbered_q):
        probs.append(("E", f"asks {numbered_q} questions at once (numbered items with one answer each) - make one card per item, "
                     "each restating the shared instructions; tag 'multi-ok' only if it is truly one question (e.g. put these in order)"))
    elif c.get("type") != "cloze" and qmarks >= 2:
        probs.append(("W", f"front has {qmarks} question marks - one question per card (split it, or tag 'multi-ok')"))
    elif c.get("type") != "cloze" and mapped >= 3:
        probs.append(("E", f"back answers {mapped} numbered items - one question per card (split it, or tag 'multi-ok')"))
    return probs


# phrases that point at something the person reviewing the card can't see (notes, slides, other cards)
_EXT_REF_STRONG = re.compile(
    r"\b(?:(?:previous|earlier|last|next|other|above|preceding|following) cards?|cards? (?:above|before|earlier)"
    r"|(?:the|this|that) (?:example|code|snippet|listing|program|figure|diagram|table|method|class|function|definition|output|scenario|setup) (?:above|earlier|before|from (?:the )?(?:lecture|notes|slides?|tutorial|lab|textbook|reading))"
    r"|(?:figure|fig\.|listing|slide|table|example|exercise|question) ?[1-9]\d*(?:\.\d+)?\b(?!\s*[-+×*/=<>])"
    r"|as (?:shown|seen|defined|discussed|described|introduced|covered) (?:above|earlier|before|in (?:the )?(?:lecture|notes|slides?|class|tutorial|lab|textbook|reading))"
    r"|(?:in|from) (?:the )?(?:lecture|lecture notes|slides?|notes|textbook|tutorial|recitation|reading|handout)s?\b(?! on\b)"
    r"|(?:in|from|of) (?:lecture|L) ?\d+)", re.I)
_CARD_REF = re.compile(r"\b(?:(?:previous|earlier|last|next|other|above|preceding|following) cards?|cards? (?:above|before|earlier)"
    r"|(?:the|this|that) (?:example|code|snippet|listing|program|figure|diagram) above|as (?:shown|seen|defined) above)", re.I)
# a call on a variable (p1.distanceTo(p2), acc.deposit(5)) - the method's code may be needed to answer
_VAR_CALL = re.compile(r"\b([a-z][A-Za-z0-9_]*)\.([a-z][A-Za-z0-9_]*)\s*\(")
_STD_METHODS = set("""add addAll get set put remove contains containsKey size isEmpty equals hashCode toString compareTo length charAt
substring indexOf append map filter reduce forEach collect stream of iterate limit sum count apply accept test andThen compose
next hasNext getClass clone push pop peek poll offer join start run call sort split strip trim format println print
keys values items append extend insert copy update lower upper""".split())


def _outside_refs(c):
    """Signs that a card leans on material the person reviewing it does not have (the notes, slides, another card,
    code that isn't shown). Every card must carry everything needed to answer it."""
    probs = []
    q = c.get("text") if c.get("type") == "cloze" else c.get("front")
    q = str(q or "")
    both = q + " " + ("" if c.get("type") == "cloze" else str(c.get("back") or "")) + " " + str(c.get("extra") or "")
    prose = lambda h: _html.unescape(re.sub(r"<[^>]+>", " ", re.sub(r"<pre[\s\S]*?</pre>", " ", h, flags=re.I)))
    # the question must not depend on outside material; the answer may mention where a fact comes from
    # ("in the notes' words"), but must not send the reader to another card or "the example above" either
    m = _EXT_REF_STRONG.search(prose(q)) or _CARD_REF.search(prose(both))
    if m and re.match(r"(?:question|exercise|example)\b", m.group(0), re.I):
        probs.append(("W", f"'{m.group(0)}' is a label from the source - fine if the whole problem is on the card; "
                           "otherwise copy in what it refers to"))
    elif m:
        probs.append(("E", f"refers to something the reviewer can't see ('{m.group(0)}') - put the code, figure or "
                           "definition on the card itself; the card must stand alone without notes, slides or other cards"))
    if "<pre" not in q.lower():
        code_txt = " ".join(re.findall(r"<code[^>]*>([\s\S]*?)</code>", q, re.I)) + " " + prose(q)
        calls = [(v, f) for v, f in _VAR_CALL.findall(_html.unescape(re.sub(r"<[^>]+>", "", code_txt)))
                 if f not in _STD_METHODS and v not in ("System", "Math", "Arrays", "List", "Stream", "Collections")]
        if calls:
            v, f = calls[0]
            probs.append(("W", f"asks about {v}.{f}(...) but the front doesn't show {f}'s code - if answering needs "
                               f"what {f} does (its parameters, body or fields), show it in a code block on the front"))
    return probs


def _layout_clashes(fig, tol=2.0):
    """Overlaps in a matplotlib figure, as short descriptions ([] if clean):
    two pieces of text on top of each other, text cutting across a box it isn't inside, rounded boxes on top of each
    other, and text running outside the figure. Measured from the rendered layout, so it works for any figure."""
    from matplotlib.text import Text
    from matplotlib.patches import FancyBboxPatch
    fig.canvas.draw()
    r = fig.canvas.get_renderer()
    W, H = fig.bbox.width, fig.bbox.height

    def short(t):
        t = re.sub(r"\s+", " ", t.get_text()).strip()
        return repr(t[:24] + ("…" if len(t) > 24 else ""))

    texts = []
    for t in fig.findobj(Text):
        if not t.get_visible() or not t.get_text().strip() or t.get_alpha() == 0:
            continue
        try:
            patch = t.get_bbox_patch()
            bb = (patch.get_window_extent(r) if patch is not None else t.get_window_extent(r))
        except Exception:  # noqa: BLE001
            continue
        if bb.width < 1 or bb.height < 1:
            continue
        texts.append((t, bb))
    boxes = []
    for p in fig.findobj(FancyBboxPatch):
        if not p.get_visible() or p.axes is None or any(p is t.get_bbox_patch() for t, _ in texts):
            continue
        boxes.append(p.get_window_extent(r))

    def inter(a, b):
        return min(a.x1, b.x1) - max(a.x0, b.x0) > tol and min(a.y1, b.y1) - max(a.y0, b.y0) > tol

    def inside(a, b):
        return a.x0 >= b.x0 - tol and a.x1 <= b.x1 + tol and a.y0 >= b.y0 - tol and a.y1 <= b.y1 + tol

    out = []
    for i in range(len(texts)):
        for j in range(i + 1, len(texts)):
            (t1, a), (t2, b) = texts[i], texts[j]
            if inter(a, b) and not inside(a, b) and not inside(b, a):
                out.append(f"text {short(t1)} overlaps {short(t2)}")
            elif inter(a, b) and t1.get_text().strip() != t2.get_text().strip():
                out.append(f"text {short(t1)} sits on {short(t2)}")
    for t, a in texts:
        for b in boxes:
            if inter(a, b) and not inside(a, b) and not inside(b, a):
                out.append(f"text {short(t)} cuts across a box")
                break
        if t.axes is not None and t.get_clip_on() is False and (a.x0 < -tol or a.y0 < -tol or a.x1 > W + tol or a.y1 > H + tol):
            pass  # bbox_inches='tight' keeps it in the picture
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            if inter(boxes[i], boxes[j]) and not inside(boxes[i], boxes[j]) and not inside(boxes[j], boxes[i]):
                out.append("two boxes overlap")
    seen, uniq = set(), []
    for o in out:
        if o not in seen:
            seen.add(o); uniq.append(o)
    return uniq


def math_spans(html):
    """[(latex, display)] for every \\( \\) / \\[ \\] span outside code."""
    txt = _CODE_RE.sub("", str(html or ""))
    return [((m.group(1) if m.group(1) is not None else m.group(2)), m.group(2) is not None) for m in _MATH_RE.finditer(txt)]


_L2M = None
def _latex2mathml():
    """latex2mathml (pure Python, from PyPI) renders maths offline as MathML, which Chromium draws natively."""
    global _L2M
    if _L2M is None:
        try:
            import latex2mathml.converter as conv
        except ImportError:
            try:
                import subprocess
                subprocess.run([sys.executable, "-m", "pip", "install", "-q", "latex2mathml", "--break-system-packages"],
                               capture_output=True, timeout=90)
                import latex2mathml.converter as conv
            except Exception:  # noqa: BLE001
                conv = False
        _L2M = conv
    return _L2M or None


def check_tex(expr):
    """Problems with one LaTeX expression ([] if fine): bad syntax, unbalanced braces, unknown commands."""
    probs = []
    expr = _html.unescape(re.sub(r"<[^>]+>", "", expr))
    expr = re.sub(r"\{\{c\d+::([\s\S]*?)(?:::[^{}]*?)?\}\}", r"{\1}", expr)   # a cloze inside the maths: check its answer
    e = re.sub(r"\\[{}]", "", expr)
    depth = 0
    for ch in e:
        depth += (ch == "{") - (ch == "}")
        if depth < 0:
            break
    if depth:
        probs.append("unbalanced { } braces")
    conv = _latex2mathml()
    if conv and not probs:
        try:
            ml = conv.convert(expr)
            unknown = sorted(set(re.findall(r"<m[io][^>]*>\\([A-Za-z]+)</m[io]>", ml)))
            if unknown:
                probs.append("unknown command(s) " + ", ".join("\\" + u for u in unknown) + " - MathJax would show them in red")
        except Exception as x:  # noqa: BLE001
            probs.append(f"LaTeX doesn't parse ({type(x).__name__}{': ' + str(x) if str(x) else ''})")
    return probs


def render_math_html(html):
    """Card HTML with every \\( \\) / \\[ \\] span replaced by MathML (offline). Spans that can't be converted are
    left as they are (the preview page then falls back to MathJax from the web, if it can load)."""
    conv = _latex2mathml()
    if not conv:
        return html
    out = []
    for part in _CODE_RE.split(str(html)):
        if _CODE_RE.fullmatch(part or ""):
            out.append(part); continue

        def _one(m):
            disp = m.group(2) is not None
            try:
                src = _html.unescape((m.group(2) if disp else m.group(1)).strip())
                ml = conv.convert(src, display="block" if disp else "inline")
                # Chromium adds no space after function names (\sin x → "sinx"); MathJax/Anki do
                return re.sub(r"(<mi>[A-Za-z]{2,}</mi>|<mo>(?:lim|max|min|sup|inf|det|gcd|log|ln|exp|rank)</mo>)(?!\s*<mo[^>]*>(?:\(|&#x00028;))", r'\1<mspace width="0.17em"/>', ml)
            except Exception:  # noqa: BLE001
                return m.group(0)
        out.append(_MATH_RE.sub(_one, part))
    return "".join(out)


# --------------------------------------------------------------------------- image utils
def _safe_stem(name):
    stem = os.path.splitext(os.path.basename(str(name)))[0]
    stem = re.sub(r"[^A-Za-z0-9_\-]+", "_", stem).strip("_").lower()
    return stem or "image"


def _is_photo(im):
    small = im.convert("RGB").resize((64, 64))
    return len(set(small.getdata())) > 1500


def _normalize_image(data, max_px=MAX_PX, prefer=None):
    """Downscale + recompress. Returns (bytes, ext, (w, h))."""
    Image = _pil()
    im = Image.open(io.BytesIO(data))
    im.load()
    if max(im.size) > max_px:
        im.thumbnail((max_px, max_px), Image.LANCZOS)
    alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
    buf = io.BytesIO()
    if prefer == "jpg" or (prefer is None and not alpha and _is_photo(im)):
        im.convert("RGB").save(buf, "JPEG", quality=85, optimize=True)
        ext = "jpg"
    else:
        if im.mode not in ("RGB", "RGBA", "L", "LA", "P"):
            im = im.convert("RGBA")
        im.save(buf, "PNG", optimize=True)
        ext = "png"
    return buf.getvalue(), ext, im.size


def _crop_frac(im, box):
    if not box:
        return im
    x0, y0, x1, y1 = box
    if max(box) > 1.0:            # pixel box given
        return im.crop((int(x0), int(y0), int(x1), int(y1)))
    w, h = im.size
    return im.crop((int(x0 * w), int(y0 * h), int(x1 * w), int(y1 * h)))


def _render_pdf_page(path, page, zoom=3.0):
    """Render 1-based `page` of a PDF to a PIL image."""
    Image = _pil()
    mu = _pymupdf()
    if mu:
        doc = mu.open(path)
        pix = doc[page - 1].get_pixmap(matrix=mu.Matrix(zoom, zoom), alpha=False)
        return Image.open(io.BytesIO(pix.tobytes("png")))
    try:
        import pypdfium2 as pdfium
        pdf = pdfium.PdfDocument(path)
        return pdf[page - 1].render(scale=zoom).to_pil()
    except ImportError:
        pass
    try:
        from pdf2image import convert_from_path
        return convert_from_path(path, dpi=int(72 * zoom), first_page=page, last_page=page)[0]
    except ImportError:
        raise RuntimeError("No PDF renderer found: pip install pymupdf  (or pypdfium2)")


def _need_pymupdf():
    mu = _pymupdf()
    if not mu:
        raise RuntimeError("This function needs PyMuPDF: pip install pymupdf")
    return mu


# --------------------------------------------------------------------------- PDF inspection
def pdf_info(path, chars=160):
    """Print page count and a text snippet + figure count for each page."""
    mu = _need_pymupdf()
    doc = mu.open(path)
    print(f"{os.path.basename(path)}: {len(doc)} pages")
    for i, p in enumerate(doc, 1):
        txt = " ".join(p.get_text().split())[:chars]
        print(f"  p{i:>3}  figs={len(p.get_image_info()):<2} {txt}")
    return len(doc)


def pdf_text(path, page):
    """Full text of a 1-based page."""
    return _need_pymupdf().open(path)[page - 1].get_text()


def pdf_find(path, text):
    """Find `text` in a PDF. Returns [(page, (x0, y0, x1, y1) as page fractions)]."""
    mu = _need_pymupdf()
    out = []
    for i, p in enumerate(mu.open(path), 1):
        W, H = p.rect.width, p.rect.height
        for r in p.search_for(text):
            out.append((i, (round(r.x0 / W, 3), round(r.y0 / H, 3), round(r.x1 / W, 3), round(r.y1 / H, 3))))
    return out


def pdf_figures(path, page=None, min_frac=0.04):
    """List embedded raster figures as dicts {page, index, box(fractions)}; prints a summary.
    Tiny images (logos, bullets) smaller than `min_frac` of the page width/height are skipped.
    Vector drawings are not listed - use crop_pdf with a box for those."""
    mu = _need_pymupdf()
    doc = mu.open(path)
    pages = [page] if page else range(1, len(doc) + 1)
    out = []
    for pn in pages:
        p = doc[pn - 1]
        W, H = p.rect.width, p.rect.height
        idx = 0
        for info in p.get_image_info():
            x0, y0, x1, y1 = info["bbox"]
            if (x1 - x0) / W < min_frac or (y1 - y0) / H < min_frac:
                continue
            fr = (round(max(x0, 0) / W, 3), round(max(y0, 0) / H, 3), round(min(x1, W) / W, 3), round(min(y1, H) / H, 3))
            out.append({"page": pn, "index": idx, "box": fr})
            idx += 1
    for f in out:
        print(f"  page {f['page']:>3}  index {f['index']}  box={f['box']}")
    if not out:
        print("  (no embedded raster figures found - diagrams may be vector; use crop_pdf with a box)")
    return out


def render_page_preview(path, page, zoom=1.5, name=None):
    """Save a PNG of the page with a labelled 10% grid to OUT_DIR - helps pick crop boxes."""
    Image = _pil()
    from PIL import ImageDraw
    im = _render_pdf_page(path, page, zoom).convert("RGB")
    d = ImageDraw.Draw(im)
    w, h = im.size
    for k in range(1, 10):
        x, y = w * k / 10, h * k / 10
        d.line([(x, 0), (x, h)], fill=(255, 0, 0), width=1)
        d.line([(0, y), (w, y)], fill=(255, 0, 0), width=1)
        d.text((x + 2, 2), f"{k / 10:.1f}", fill=(255, 0, 0))
        d.text((2, y + 2), f"{k / 10:.1f}", fill=(255, 0, 0))
    out = os.path.join(OUT_DIR, name or f"_preview_{_safe_stem(path)}_p{page}.png")
    im.save(out)
    print("preview saved:", out)
    return out


def office_images(path):
    """List images embedded in a .docx / .pptx / .xlsx file (they are zip archives)."""
    with zipfile.ZipFile(path) as z:
        names = [n for n in z.namelist() if re.search(r"/media/.+\.(png|jpe?g|gif|bmp|tiff?|webp|emf|wmf)$", n, re.I)]
    for i, n in enumerate(names):
        print(f"  [{i}] {n}")
    return names


# --------------------------------------------------------------------------- Deck
class Deck:
    """A deck of cards plus the images they reference."""

    def __init__(self, name="AI Generated Deck", tags=(), id_prefix="c"):
        self.name = name
        self.tags = list(tags)
        self.cards = []
        self.media = {}          # filename -> {origin, data(bytes)|None, url, hint, caption, credit}
        self._prefix = id_prefix
        self._n = 0
        self._dirty = set()
        self._deleted = set()
        self._new_media = set()
        self._reserved = set()
        self.feedback = {}       # id -> reviewer feedback (filled by Deck.load on a revision request)
        self.order = []          # anti-spoiler study order (card ids), see set_order()
        self.names = {}          # your names for cards -> ids  (add_basic(..., name="x"))
        self._meta = {}          # id -> {"group", "prereq"}  (used by suggest_order; not exported)
        self.source_pages = {}   # file name -> {page: text}   (load_source; lets validate() check ref quotes)
        self._glyph = {}         # image -> missing characters (matplotlib drew boxes)
        self._overlap = {}       # image -> overlapping / clipped elements found when it was drawn
        self._seen = set()       # images shown on a contact sheet / preview since they were made
        self.explanations = {}   # id -> markdown (explain(); "I don't understand this card")

    # ---------------------------------------------------------------- cards
    def _next_id(self):
        while True:
            self._n += 1
            cid = f"{self._prefix}{self._n:03d}"
            if not self.get(cid) and cid not in self._reserved:
                return cid

    def get(self, cid):
        cid = self.names.get(cid, cid)
        return next((c for c in self.cards if c["id"] == cid), None)

    def _rid(self, x):
        """card id from a name or an id"""
        return self.names.get(x, x)

    def _remember(self, cid, name, group, prereq):
        if name:
            if name in self.names and self.names[name] != cid:
                raise ValueError(f"card name {name!r} is already used by {self.names[name]}")
            self.names[name] = cid
        self._meta[cid] = {"group": group, "prereq": [p for p in (prereq or ())]}
        return cid

    def _put(self, card, after=None):
        if self.get(card["id"]):
            raise ValueError(f"Card id {card['id']} already exists - use update()")
        if after and self.get(after):
            i = self.cards.index(self.get(after))
            self.cards.insert(i + 1, card)
            card["after"] = after
        else:
            self.cards.append(card)
        self._dirty.add(card["id"])
        return card["id"]

    def _attach(self, card, images, field):
        for im in images or ():
            name, cap = (im if isinstance(im, (tuple, list)) else (im, None))
            if not any(f'src="{name}"' in str(v) for v in card.values()):
                card[field] = (card.get(field) or "") + img(name, cap)

    @staticmethod
    def _refs(ref):
        """ref: ("file.pdf", page, "verbatim quote") | {"file", "page", "quote", "box"} | a list of those."""
        if not ref:
            return []
        items = ref if isinstance(ref, list) else [ref]
        out = []
        for r in items:
            if isinstance(r, (tuple, list)):
                r = dict(zip(("file", "page", "quote", "box"), r))
            o = {"file": os.path.basename(str(r.get("file", ""))), "page": int(r.get("page") or 0)}
            if r.get("quote"):
                o["quote"] = " ".join(str(r["quote"]).split())[:300]
            if r.get("box"):
                o["box"] = [round(float(x), 4) for x in r["box"]]
            out.append(o)
        return out

    def add_basic(self, front, back, extra="", source="", tags=(), images=(), id=None, after=None, ref=None,
                  name=None, group=None, prereq=(), why=""):
        """Front/back card. `images` (filenames or (filename, caption)) are appended to the back
        unless already referenced in a field. `ref` = where it comes from (the Studio shows a picture of it):
        ("lecture.pdf", 12, "verbatim quote") or a list of those.
        name = your handle for the card (use it in set_order / prereq instead of positions);
        group = topic for suggest_order (default: first tag); prereq = names/ids that must be studied first.
        why = an extensive explanation of why this card exists - build it with rationale(tests=, matters=, mistake=,
        connects=): what it tests, why it matters, the mistake it guards against, how it connects (shown to the user
        while reviewing; they can choose to put it on the card).
        Returns the card id."""
        card = {"id": id or self._next_id(), "type": "basic", "front": fix_math(front), "back": fix_math(back),
                "extra": fix_math(extra), "source": source, "tags": list(tags)}
        if why:
            card["why"] = str(why).strip()
        if ref:
            card["refs"] = self._refs(ref)
        self._attach(card, images, "back")
        return self._remember(self._put(card, after), name, group, prereq)

    def add_cloze(self, text, extra="", source="", tags=(), images=(), id=None, after=None, ref=None,
                  name=None, group=None, prereq=(), why=""):
        """Cloze card - text must contain {{c1::...}}. `images` are appended to Extra. Other args as add_basic."""
        if not re.search(r"\{\{c\d+::", text):
            raise ValueError("Cloze text needs at least one {{c1::...}} deletion")
        card = {"id": id or self._next_id(), "type": "cloze", "text": fix_math(text), "extra": fix_math(extra),
                "source": source, "tags": list(tags)}
        if why:
            card["why"] = str(why).strip()
        if ref:
            card["refs"] = self._refs(ref)
        self._attach(card, images, "extra")
        return self._remember(self._put(card, after), name, group, prereq)

    def set_order(self, ids):
        """Anti-spoiler study order: every card once (ids or names), in the order they should be studied.
        Keep the cards themselves grouped by topic; this only changes the study order. See suggest_order()."""
        ids = [self._rid(i) for i in ids]
        unknown = [i for i in ids if not self.get(i)]
        if unknown:
            raise KeyError(f"set_order: unknown ids {unknown[:5]}")
        dup = {i for i in ids if ids.count(i) > 1}
        if dup:
            raise ValueError(f"set_order: duplicate ids {sorted(dup)[:5]}")
        self.order = ids
        return ids

    def update(self, cid, images=(), ref=None, **fields):
        """Change fields of an existing card (id or name), e.g. deck.update("c004", back="...")."""
        cid = self._rid(cid)
        c = self.get(cid)
        if not c:
            raise KeyError(cid)
        if ref:
            c["refs"] = self._refs(ref)
        c.update({k: fix_math(v) if k in ("front", "back", "extra", "text") else v for k, v in fields.items()})
        self._attach(c, images, "back" if c["type"] == "basic" else "extra")
        self._dirty.add(cid)
        return cid

    def delete(self, cid):
        cid = self._rid(cid)
        c = self.get(cid)
        if c:
            self.cards.remove(c)
        self._deleted.add(cid)
        self._dirty.discard(cid)

    # ---------------------------------------------------------------- media
    def _register(self, stem, data=None, ext="png", origin="generated", **meta):
        name = f"{_safe_stem(stem)}.{ext}"
        base, k = name, 2
        while name in self.media and self.media[name].get("data") != data:
            name = f"{os.path.splitext(base)[0]}_{k}.{ext}"
            k += 1
        entry = {"origin": origin, "data": data}
        entry.update({k2: v for k2, v in meta.items() if v})
        self.media[name] = entry
        self._new_media.add(name)
        return name

    def add_image_bytes(self, data, name, box=None, prefer=None, max_px=MAX_PX):
        """Register raw image bytes (optionally cropped with a fractional box). Returns filename."""
        if box:
            Image = _pil()
            im = _crop_frac(Image.open(io.BytesIO(data)), box)
            b = io.BytesIO()
            im.save(b, "PNG")
            data = b.getvalue()
        out, ext, _ = _normalize_image(data, max_px, prefer)
        return self._register(name, out, ext, origin="generated")

    def add_image_file(self, path, name=None, box=None, prefer=None):
        """Register an image file (e.g. an uploaded screenshot), optionally cropped.
        box = (x0, y0, x1, y1) as fractions of width/height (or pixels if > 1)."""
        with open(path, "rb") as f:
            return self.add_image_bytes(f.read(), name or path, box, prefer)

    def figure(self, fig, name, dpi=160, close=True):
        """Register a matplotlib figure you drew yourself. Returns filename.
        Characters the fonts can't draw (they come out as boxes) are recorded and fail validate()."""
        buf = io.BytesIO()
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            try:
                clashes = _layout_clashes(fig)
            except Exception:  # noqa: BLE001 - the check must never stop a figure being saved
                clashes = []
            fig.savefig(buf, format="png", dpi=dpi, bbox_inches="tight", facecolor="white")
        missing = sorted({chr(int(m.group(1))) for w in caught for m in [re.search(r"Glyph (\d+)", str(w.message))] if m})
        if close:
            _plt().close(fig)
        fname = self.add_image_bytes(buf.getvalue(), name, prefer="png")
        self._seen.discard(fname)
        self._overlap.pop(fname, None)
        if clashes:
            self._overlap[fname] = clashes
            print(f"  ! {fname}: elements overlap - " + "; ".join(clashes[:4]) + (" …" if len(clashes) > 4 else "")
                  + ". Look at it (contact_sheet) and fix the layout: more space, shorter labels, fewer elements.")
        if missing:
            self._glyph[fname] = missing
            print(f"  ! {fname}: the font can't draw {', '.join(missing)} - it shows as a box. Use plain text / mathtext (r'$\\perp$') instead.")
        return fname

    def crop_pdf(self, path, page, box=(0, 0, 1, 1), name=None, zoom=3.0):
        """Crop a region of a PDF page (1-based) - works for vector diagrams, tables, text.
        box = (x0, y0, x1, y1) as fractions of the page."""
        im = _crop_frac(_render_pdf_page(path, page, zoom), box)
        b = io.BytesIO()
        im.save(b, "PNG")
        return self.add_image_bytes(b.getvalue(), name or f"{_safe_stem(path)}_p{page}", prefer="png")

    def pdf_figure(self, path, page, index=0, name=None, pad=0.01, zoom=3.0):
        """Crop the `index`-th embedded figure on a page (see pdf_figures()), including any
        labels drawn on top of it. Returns filename."""
        figs = [f for f in pdf_figures(path, page) if f["index"] == index]
        if not figs:
            raise ValueError(f"No figure {index} on page {page}")
        x0, y0, x1, y1 = figs[0]["box"]
        box = (max(0, x0 - pad), max(0, y0 - pad), min(1, x1 + pad), min(1, y1 + pad))
        return self.crop_pdf(path, page, box, name or f"{_safe_stem(path)}_p{page}_fig{index}", zoom)

    def office_image(self, path, member, name=None, box=None):
        """Register an image embedded in a .docx/.pptx (member = index or name from office_images())."""
        names = office_images(path) if isinstance(member, int) else None
        with zipfile.ZipFile(path) as z:
            m = names[member] if names is not None else member
            return self.add_image_bytes(z.read(m), name or m, box)

    def web_image(self, url, name, caption=None, credit=None):
        """Reference a real image by URL (downloaded later by the website, not here).
        Prefer Wikimedia Commons: https://commons.wikimedia.org/wiki/Special:FilePath/<File>.jpg?width=800
        Returns the filename to use in img()."""
        ext = os.path.splitext(url.split("?")[0])[1].lower().lstrip(".")
        ext = {"jpeg": "jpg", "svg": "png"}.get(ext, ext) if ext in ("jpg", "jpeg", "png", "gif", "webp", "svg") else "jpg"
        if ext == "png" and url.split("?")[0].lower().endswith(".svg") and "width=" not in url:
            url += ("&" if "?" in url else "?") + "width=800"
        return self._register(name, None, ext, origin="url", url=url, caption=caption, credit=credit)

    def material(self, name, hint, ext="png"):
        """Placeholder for an image the USER will screenshot/crop from their material in the website.
        hint must say exactly where: file, page/slide, which figure."""
        return self._register(name, None, ext, origin="material", hint=hint)

    # ---------------------------------------------------------------- diagram makers (boxes sized to their text)
    PALETTE = ["#dbeafe", "#dcfce7", "#fef3c7", "#fce7f3", "#ede9fe", "#ffedd5", "#e0f2fe", "#f1f5f9"]

    @staticmethod
    def _text_size(text, size=11, bold=False):
        """(width, height) in points of possibly multi-line text."""
        _plt()
        from matplotlib.textpath import TextPath
        from matplotlib.font_manager import FontProperties
        fp = FontProperties(family=["DejaVu Sans"], weight="bold" if bold else "normal")
        lines = str(text).split("\n") or [""]
        for ln in lines:
            if ln.count("$") - ln.count("\\$") >= 2:
                from matplotlib.mathtext import MathTextParser
                for m in re.findall(r"\$[^$]+\$", ln):
                    try:
                        MathTextParser("path").parse(m, 72, fp)
                    except Exception as x:  # noqa: BLE001
                        raise ValueError(f"diagram label {m!r}: matplotlib mathtext can't draw this ({(str(x).strip().splitlines() or [type(x).__name__])[0][:120]}). "
                                         "Labels support a LaTeX subset: \\frac, ^ _, \\sqrt, Greek, \\sum, \\int, \\mathrm, \\mathbf ... "
                                         "but no environments (matrix, align) or \\text - simplify it or put the maths in the card text") from None
        w = 0
        for ln in lines:
            if ln.strip():
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    w = max(w, TextPath((0, 0), ln, size=size, prop=fp).get_extents().width)
        return w, len(lines) * size * 1.28 * Deck._ls(text) / 1.15

    @staticmethod
    def _ls(text):
        """line spacing for a label: tall maths (fractions, sums, roots…) needs more room between lines"""
        return 1.75 if "\n" in str(text) and re.search(r"\$[^$]*\\(?:d?frac|sum|int|prod|sqrt|over|binom|lim)[^$]*\$", str(text)) else 1.15

    @staticmethod
    def _wrap(text, width):
        """wrap a label; $…$ maths stays on one line (its length counts as its rough visible width)"""
        def one(p):
            maths = []
            def keep(m):
                maths.append(m.group(0)); return "\x00%d\x00" % (len(maths) - 1)
            q = re.sub(r"\$[^$]+\$", keep, p)
            vis = lambda t: len(re.sub(r"\x00(\d+)\x00", lambda m: "x" * max(1, len(re.sub(r"\\[A-Za-z]+|[{}^_$]", "", maths[int(m.group(1))]))), t))
            if vis(q) <= width:
                return p
            words, lines, cur = q.split(" "), [], ""
            for w in words:
                if cur and vis(cur + " " + w) > width:
                    lines.append(cur); cur = w
                else:
                    cur = (cur + " " + w) if cur else w
            lines.append(cur)
            return "\n".join(re.sub(r"\x00(\d+)\x00", lambda m: maths[int(m.group(1))], ln) for ln in lines)
        return "\n".join(one(p) for p in str(text).split("\n"))

    def _node(self, label, sub="", wrap=22, size=11):
        """measure a box: title (bold) + optional subtitle"""
        t = self._wrap(label, wrap)
        tw, th = self._text_size(t, size, True)
        s2 = self._wrap(sub, wrap + 6) if sub else ""
        sw, sh = self._text_size(s2, size - 2.5) if s2 else (0, 0)
        pad = 10
        return {"t": t, "s": s2, "w": max(tw, sw) + 2 * pad, "h": th + (sh + 4 if s2 else 0) + 2 * pad, "th": th, "size": size}

    def _draw_node(self, ax, n, x, y, fc, ec="#334155"):
        """n centred at (x, y) in points"""
        from matplotlib.patches import FancyBboxPatch
        ax.add_patch(FancyBboxPatch((x - n["w"] / 2, y - n["h"] / 2), n["w"], n["h"], boxstyle="round,pad=0,rounding_size=8",
                                    fc=fc, ec=ec, lw=1.3, zorder=2))
        if n["s"]:
            top = y + n["h"] / 2 - 10
            ax.text(x, top - n["th"] / 2, n["t"], ha="center", va="center", fontsize=n["size"], weight="bold", zorder=3, linespacing=self._ls(n["t"]))
            ax.text(x, top - n["th"] - 4 - (n["h"] - 20 - n["th"] - 4) / 2, n["s"], ha="center", va="center",
                    fontsize=n["size"] - 2.5, color="#334155", zorder=3, linespacing=self._ls(n["s"]))
        else:
            ax.text(x, y, n["t"], ha="center", va="center", fontsize=n["size"], weight="bold", zorder=3, linespacing=self._ls(n["t"]))

    @staticmethod
    def _edge_point(n, x, y, tx, ty):
        """where the line from a box centre towards (tx, ty) leaves the box"""
        dx, dy = tx - x, ty - y
        if dx == 0 and dy == 0:
            return x, y
        sx = (n["w"] / 2 + 2) / abs(dx) if dx else float("inf")
        sy = (n["h"] / 2 + 2) / abs(dy) if dy else float("inf")
        k = min(sx, sy)
        return x + dx * k, y + dy * k

    def _finish(self, fig, ax, xs, ys, name, title, margin=14):
        ax.set_xlim(min(xs) - margin, max(xs) + margin)
        ax.set_ylim(min(ys) - margin, max(ys) + margin + (22 if title else 0))
        ax.set_aspect("equal")
        ax.axis("off")
        w, h = (max(xs) - min(xs) + 2 * margin) / 72, (max(ys) - min(ys) + 2 * margin + (22 if title else 0)) / 72
        fig.set_size_inches(max(w, 1.5), max(h, 1.0))
        ax.set_position([0, 0, 1, 1])
        if title:
            ax.text((min(xs) + max(xs)) / 2, max(ys) + margin + 6, title, ha="center", va="center", fontsize=13, weight="bold")
        return self.figure(fig, name)

    def _arrow(self, ax, p, q, label=None, color="#334155", rad=0.0):
        from matplotlib.patches import FancyArrowPatch
        ax.add_patch(FancyArrowPatch(p, q, arrowstyle="-|>", mutation_scale=14, lw=1.6, color=color, zorder=1,
                                     connectionstyle=f"arc3,rad={rad}"))
        if label:
            ax.text((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, self._wrap(label, 18), ha="center", va="center", fontsize=8.5,
                    color="#1f2937", zorder=4, bbox=dict(boxstyle="round,pad=0.25", fc="white", ec="#cbd5e1", lw=0.8))

    def flowchart(self, steps, name="flowchart", direction="LR", title=None, wrap=22, colors=None, per_row=4):
        """Boxes joined by arrows, each box sized to its text. steps: str or (title, subtitle).
        direction LR (wraps into rows of per_row, snaking) or TB."""
        plt = _plt()
        pal = colors or self.PALETTE
        nodes = [self._node(*(s if isinstance(s, (tuple, list)) else (s, "")), wrap=wrap) for s in steps]
        fig, ax = plt.subplots()
        pos = []
        if direction.upper() == "TB":
            y = 0
            for n in nodes:
                pos.append((0, y - n["h"] / 2)); y -= n["h"] + 34
        else:
            colw = max(n["w"] for n in nodes); gap = 46
            rows = [nodes[i:i + per_row] for i in range(0, len(nodes), per_row)]
            y = 0
            for r, row in enumerate(rows):
                rh = max(n["h"] for n in row)
                for j in range(len(row)):
                    col = j if r % 2 == 0 else (per_row - 1 - j if len(rows) > 1 else j)
                    pos.append((col * (colw + gap) + colw / 2, y - rh / 2))
                y -= rh + 40
        for i, n in enumerate(nodes):
            self._draw_node(ax, n, *pos[i], pal[i % len(pal)])
            if i:
                a, b = nodes[i - 1], n
                p = self._edge_point(a, *pos[i - 1], *pos[i]); q = self._edge_point(b, *pos[i], *pos[i - 1])
                self._arrow(ax, p, q)
        xs = [x - n["w"] / 2 for (x, _), n in zip(pos, nodes)] + [x + n["w"] / 2 for (x, _), n in zip(pos, nodes)]
        ys = [y - n["h"] / 2 for (_, y), n in zip(pos, nodes)] + [y + n["h"] / 2 for (_, y), n in zip(pos, nodes)]
        return self._finish(fig, ax, xs, ys, name, title)

    def concept_map(self, center, branches, name="concept_map", title=None, wrap=20):
        """Radial mind-map, boxes sized to their text and spread until nothing overlaps.
        branches: str or (str, [children])."""
        import math
        plt = _plt()
        pal = ["#2563eb", "#16a34a", "#d97706", "#db2777", "#7c3aed", "#0891b2", "#dc2626", "#4d7c0f"]
        cn = self._node(center, wrap=16, size=12.5)
        bs = [(self._node(b if isinstance(b, str) else b[0], wrap=wrap), [self._node(k, wrap=wrap + 4, size=9.5) for k in ([] if isinstance(b, str) else b[1])]) for b in branches]
        n = max(1, len(bs))

        def layout(scale):
            boxes = [(0, 0, cn)]; lines = []
            for i, (bn, kids) in enumerate(bs):
                a = 2 * math.pi * i / n + math.pi / 2
                rx, ry = (cn["w"] / 2 + bn["w"] / 2 + 40) * scale, (cn["h"] / 2 + bn["h"] / 2 + 46) * scale
                bx, by = rx * math.cos(a), ry * math.sin(a)
                boxes.append((bx, by, bn)); lines.append(((0, 0), (bx, by), pal[i % len(pal)], 2.0))
                for j, kn in enumerate(kids):
                    spread = 0.9 / max(1, len(kids) - 1) if len(kids) > 1 else 0
                    ka = a + (j - (len(kids) - 1) / 2) * spread
                    kr = (bn["w"] / 2 + kn["w"] / 2 + 30) * scale
                    kx, ky = bx + kr * math.cos(ka), by + (bn["h"] / 2 + kn["h"] / 2 + 26) * scale * math.sin(ka) + (kr * 0.25 * math.sin(ka))
                    boxes.append((kx, ky, kn)); lines.append(((bx, by), (kx, ky), pal[i % len(pal)], 1.0))
            return boxes, lines

        def overlaps(boxes):
            for i in range(len(boxes)):
                for j in range(i + 1, len(boxes)):
                    (x1, y1, a), (x2, y2, b) = boxes[i], boxes[j]
                    if abs(x1 - x2) < (a["w"] + b["w"]) / 2 + 6 and abs(y1 - y2) < (a["h"] + b["h"]) / 2 + 6:
                        return True
            return False
        scale = 1.0
        boxes, lines = layout(scale)
        for _ in range(40):
            if not overlaps(boxes):
                break
            scale *= 1.12; boxes, lines = layout(scale)
        fig, ax = plt.subplots()
        for (p, q, col, lw) in lines:
            ax.plot([p[0], q[0]], [p[1], q[1]], color=col, lw=lw, zorder=1)
        for k, (x, y, nd) in enumerate(boxes):
            if k == 0:
                from matplotlib.patches import FancyBboxPatch
                ax.add_patch(FancyBboxPatch((x - nd["w"] / 2, y - nd["h"] / 2), nd["w"], nd["h"], boxstyle="round,pad=0,rounding_size=10", fc="#1e293b", ec="none", zorder=2))
                ax.text(x, y, nd["t"], ha="center", va="center", fontsize=nd["size"], weight="bold", color="white", zorder=3)
            else:
                col = next((lines[i][2] for i in range(len(lines)) if lines[i][1] == (x, y)), "#334155")
                self._draw_node(ax, nd, x, y, "white" if nd["size"] < 11 else "#f8fafc", ec=col)
        xs = [x - nd["w"] / 2 for x, y, nd in boxes] + [x + nd["w"] / 2 for x, y, nd in boxes]
        ys = [y - nd["h"] / 2 for x, y, nd in boxes] + [y + nd["h"] / 2 for x, y, nd in boxes]
        return self._finish(fig, ax, xs, ys, name, title)

    def graph(self, nodes, edges, name="graph", direction="TB", title=None, wrap=22):
        """Dependency / flow graph with automatic layered layout and labelled arrows.
        nodes: [label] or [(id, label)] or [(id, label, subtitle)]; edges: [(a, b)] or [(a, b, label)]
        (a, b are ids, or labels when nodes are plain strings). direction TB or LR."""
        plt = _plt()
        norm = [(n, n, "") if isinstance(n, str) else (n[0], n[1], n[2] if len(n) > 2 else "") for n in nodes]
        ids = [n[0] for n in norm]
        info = {i: self._node(lbl, sub, wrap=wrap) for i, lbl, sub in norm}
        E = [(e[0], e[1], e[2] if len(e) > 2 else None) for e in edges]
        for a, b, _ in E:
            if a not in info or b not in info:
                raise KeyError(f"graph edge {a!r} -> {b!r}: unknown node")
        # layers by longest path (ignoring back edges of cycles)
        out = {i: [b for a, b, _ in E if a == i] for i in ids}
        layer, state = {}, {}

        def visit(i, d, stack):
            if i in stack:
                return
            if layer.get(i, -1) >= d:
                return
            layer[i] = d
            for j in out[i]:
                visit(j, d + 1, stack | {i})
        roots = [i for i in ids if not any(b == i for _, b, _ in E)] or ids[:1]
        for r in roots:
            visit(r, 0, frozenset())
        for i in ids:
            layer.setdefault(i, 0)
        L = max(layer.values()) + 1
        # long edges get an invisible waypoint in every layer they cross, so the layout leaves them a lane
        chains, segs, k_d = [], [], 0
        for a, b, lbl in E:
            if layer[b] - layer[a] > 1:
                path = [a]
                for lv in range(layer[a] + 1, layer[b]):
                    d = f"__d{k_d}"; k_d += 1
                    info[d] = {"w": 14, "h": 14, "dummy": True}; layer[d] = lv; path.append(d)
                path.append(b); chains.append((path, lbl))
                segs += list(zip(path, path[1:]))
            else:
                chains.append(([a, b], lbl)); segs.append((a, b))
        allv = ids + [d for d in info if d.startswith("__d")]
        rows = [[i for i in allv if layer[i] == k] for k in range(L)]
        # reduce crossings: barycentre ordering, a few sweeps (over real + waypoint segments)
        def bary(v, other, up):
            ns = [other[x] for x, y in segs if (y == v and x in other)] if up else [other[y] for x, y in segs if (x == v and y in other)]
            return sum(ns) / len(ns) if ns else 1e9
        for _ in range(6):
            for k in range(1, L):
                prev = {v: x for x, v in enumerate(rows[k - 1])}
                rows[k].sort(key=lambda v: bary(v, prev, True))
            for k in range(L - 2, -1, -1):
                nxt = {v: x for x, v in enumerate(rows[k + 1])}
                rows[k].sort(key=lambda v: bary(v, nxt, False))
        tb = direction.upper() != "LR"
        pos, gap, lgap = {}, 30, 70 if any(e[2] for e in E) else 50
        offset = 0
        for k, row in enumerate(rows):
            span = sum((info[v]["w"] if tb else info[v]["h"]) for v in row) + gap * (len(row) - 1)
            cur = -span / 2
            thick = max((info[v]["h"] if tb else info[v]["w"]) for v in row)
            for v in row:
                size = info[v]["w"] if tb else info[v]["h"]
                c = cur + size / 2
                pos[v] = (c, -(offset + thick / 2)) if tb else (offset + thick / 2, -c)
                cur += size + gap
            offset += thick + lgap
        fig, ax = plt.subplots()
        for v in ids:
            self._draw_node(ax, info[v], *pos[v], self.PALETTE[layer[v] % len(self.PALETTE)])
        extra_pts = []
        lo_y = min(pos[v][1] - info[v]["h"] / 2 for v in ids); hi_x = max(pos[v][0] + info[v]["w"] / 2 for v in ids)
        n_back = 0
        for path, lbl in chains:
            a, b = path[0], path[-1]
            if len(path) == 2 and layer[b] <= layer[a]:
                # feedback edge: dashed, routed around the outside so it never cuts through boxes
                n_back += 1; off = 18 + 16 * n_back
                if tb:
                    xo = hi_x + off
                    pts = [(pos[a][0] + info[a]["w"] / 2, pos[a][1]), (xo, pos[a][1]), (xo, pos[b][1])]
                    end = (pos[b][0] + info[b]["w"] / 2 + 2, pos[b][1])
                else:
                    yo = lo_y - off
                    pts = [(pos[a][0], pos[a][1] - info[a]["h"] / 2), (pos[a][0], yo), (pos[b][0], yo)]
                    end = (pos[b][0], pos[b][1] - info[b]["h"] / 2 - 2)
                ax.plot([x for x, _ in pts], [y for _, y in pts], color="#64748b", lw=1.5, ls=(0, (5, 3)), zorder=1)
                from matplotlib.patches import FancyArrowPatch
                ax.add_patch(FancyArrowPatch(pts[-1], end, arrowstyle="-|>", mutation_scale=14, lw=1.5, color="#64748b", ls=(0, (5, 3)), zorder=1))
                if lbl:
                    mx, my = (pts[1][0] + pts[2][0]) / 2, (pts[1][1] + pts[2][1]) / 2
                    ax.text(mx, my, self._wrap(lbl, 18), ha="center", va="center", fontsize=8.5, zorder=4,
                            bbox=dict(boxstyle="round,pad=0.25", fc="white", ec="#cbd5e1", lw=0.8))
                extra_pts.extend(pts)
                continue
            if len(path) == 2:
                p = self._edge_point(info[a], *pos[a], *pos[b]); q = self._edge_point(info[b], *pos[b], *pos[a])
                self._arrow(ax, p, q, lbl)
                continue
            pts = [self._edge_point(info[a], *pos[a], *pos[path[1]])] + [pos[d] for d in path[1:-1]]
            last = self._edge_point(info[b], *pos[b], *pos[path[-2]])
            ax.plot([x for x, _ in pts], [y for _, y in pts], color="#334155", lw=1.6, zorder=1, solid_capstyle="round")
            self._arrow(ax, pts[-1], last, None)
            if lbl:
                ax.text((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2, self._wrap(lbl, 18), ha="center", va="center", fontsize=8.5,
                        zorder=4, bbox=dict(boxstyle="round,pad=0.25", fc="white", ec="#cbd5e1", lw=0.8))
        xs = [pos[v][0] + s * info[v]["w"] / 2 for v in ids for s in (-1, 1)] + [x for x, _ in extra_pts]
        ys = [pos[v][1] + s * info[v]["h"] / 2 for v in ids for s in (-1, 1)] + [y for _, y in extra_pts]
        return self._finish(fig, ax, xs, ys, name, title)

    def table_image(self, headers, rows, name="table", title=None, wrap=28, header_fill="#e2e8f0"):
        """A comparison / summary table as an image (cells wrap; columns size to their text).
        Prefer the HTML table() helper when the cells are short - it stays editable."""
        plt = _plt()
        from matplotlib.patches import Rectangle
        cells = [[self._wrap(str(x), wrap) for x in headers]] + [[self._wrap(str(x), wrap) for x in r] for r in rows]
        ncol = max(len(r) for r in cells)
        cells = [r + [""] * (ncol - len(r)) for r in cells]
        pad = 7
        size = [[self._text_size(t, 10, i == 0) for t in r] for i, r in enumerate(cells)]
        cw = [max(size[i][j][0] for i in range(len(cells))) + 2 * pad for j in range(ncol)]
        rh = [max(size[i][j][1] for j in range(ncol)) + 2 * pad for i in range(len(cells))]
        fig, ax = plt.subplots()
        y = 0
        for i, r in enumerate(cells):
            x = 0
            for j, t in enumerate(r):
                ax.add_patch(Rectangle((x, y - rh[i]), cw[j], rh[i], fc=header_fill if i == 0 else ("#ffffff" if i % 2 else "#f8fafc"), ec="#94a3b8", lw=0.8))
                ax.text(x + pad, y - rh[i] / 2, t, ha="left", va="center", fontsize=10, weight="bold" if i == 0 else "normal", linespacing=1.2)
                x += cw[j]
            y -= rh[i]
        return self._finish(fig, ax, [0, sum(cw)], [y, 0], name, title, margin=4)

    def timeline(self, events, name="timeline", title=None):
        """Horizontal timeline. events: list of (when, text)."""
        plt = _plt()
        n = len(events)
        fig, ax = plt.subplots(figsize=(max(7, 2.1 * n), 3))
        ax.axhline(0, color="#334155", lw=2)
        for i, (when, text) in enumerate(events):
            up = 1 if i % 2 == 0 else -1
            ax.plot([i, i], [0, 0.5 * up], color="#64748b", lw=1)
            ax.plot(i, 0, "o", color="#2563eb", ms=9, zorder=3)
            ax.text(i, 0.58 * up, f"{when}\n" + "\n".join(textwrap.wrap(str(text), 18)) if up > 0 else
                    "\n".join(textwrap.wrap(str(text), 18)) + f"\n{when}",
                    ha="center", va="bottom" if up > 0 else "top", fontsize=9.5)
        ax.set_xlim(-0.8, n - 0.2)
        ax.set_ylim(-1.6, 1.6)
        ax.axis("off")
        if title:
            ax.set_title(title, fontsize=13, weight="bold")
        return self.figure(fig, name)

    def labeled_image(self, base, labels, name=None, numbered=False, fontsize=11):
        """Draw labels with leader lines onto an image (registered filename or file path).
        labels: [(x, y, "text")] with x, y as fractions of the image. numbered=True draws only
        numbers (for 'identify the structure' cards) and returns (filename, key_html)."""
        Image = _pil()
        plt = _plt()
        data = self.media[base]["data"] if base in self.media else open(base, "rb").read()
        im = Image.open(io.BytesIO(data)).convert("RGBA")
        w, h = im.size
        fig, ax = plt.subplots(figsize=(11, 11 * h / w * 0.8 + 0.5))
        ax.imshow(im, extent=[0, w, h, 0])
        left = sorted([l for l in labels if l[0] < 0.5], key=lambda l: l[1])
        right = sorted([l for l in labels if l[0] >= 0.5], key=lambda l: l[1])
        order = {id(l): i for i, l in enumerate(sorted(labels, key=lambda l: (l[1], l[0])))}
        for side, group in ((-1, left), (1, right)):
            for k, l in enumerate(group):
                x, y, text = l
                ty = h * (k + 1) / (len(group) + 1)
                tx = -0.04 * w if side < 0 else 1.04 * w
                lab = str(order[id(l)] + 1) if numbered else text
                ax.annotate(lab, xy=(x * w, y * h), xytext=(tx, ty), ha="right" if side < 0 else "left", va="center",
                            fontsize=fontsize, weight="bold",
                            bbox=dict(boxstyle="round,pad=0.25", fc="white", ec="#1e293b", lw=1),
                            arrowprops=dict(arrowstyle="-", color="#dc2626", lw=1.4, shrinkA=0, shrinkB=0))
                ax.plot(x * w, y * h, "o", color="#dc2626", ms=5)
        ax.set_xlim(-0.45 * w, 1.45 * w)
        ax.set_ylim(h * 1.02, -h * 0.02)
        ax.axis("off")
        fname = self.figure(fig, name or f"{_safe_stem(base)}_labeled")
        if numbered:
            key = bullets([t for _, _, t in sorted(labels, key=lambda l: (l[1], l[0]))], ordered=True)
            return fname, key
        return fname

    # ---------------------------------------------------------------- see the cards the way the user will
    def _media_src(self, n):
        m = self.media.get(n)
        if not m:
            return None
        if m.get("data"):
            ext = n.rsplit(".", 1)[-1].lower()
            mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp", "svg": "image/svg+xml"}.get(ext, "image/png")
            return f"data:{mime};base64,{base64.b64encode(m['data']).decode()}"
        if m.get("origin") == "url":
            return m.get("url")
        hint = _html.escape((m.get("hint") or "image to provide")[:90])
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="420" height="120"><rect width="100%" height="100%" rx="10" fill="#fff7e6" stroke="#d97706" stroke-dasharray="6 4"/>'
               f'<text x="16" y="34" font-family="sans-serif" font-size="15" font-weight="bold" fill="#92400e">Snip needed: {_html.escape(n)}</text>'
               f'<text x="16" y="62" font-family="sans-serif" font-size="12" fill="#92400e">{hint}</text></svg>')
        return "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()

    def _render_side(self, c, back, n=None):
        def imgs(h):
            return re.sub(r'(<img\b[^>]*src=")([^"]+)(")', lambda m: m.group(1) + (self._media_src(m.group(2)) or m.group(2)) + m.group(3), h or "")

        def cz(t):
            def rep(m):
                num, ans, hint = int(m.group(1)), m.group(2), m.group(3)
                if n is not None and num != n:
                    return ans
                return f'<span class="cloze">{ans if back else "[" + (hint or "...") + "]"}</span>'

            def rep_math(m):          # a deletion inside \( \): Anki shows it inside the formula, in colour
                num, ans, hint = int(m.group(1)), m.group(2), m.group(3)
                if n is not None and num != n:
                    return ans
                return "{\\color{#3b82f6}" + (ans if back else "\\text{[" + re.sub(r"[{}\\]", "", hint or "...") + "]}") + "}"
            cre = r"\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}"
            t = _MATH_RE.sub(lambda mm: re.sub(cre, rep_math, mm.group(0), flags=re.S), t or "")
            return re.sub(cre, rep, t, flags=re.S)
        src = f'<div class="source">Source: {imgs(c.get("source"))}</div>' if c.get("source") else ""
        ext = f'<div class="extra">{imgs(c.get("extra"))}</div>' if c.get("extra") else ""
        if c["type"] == "basic":
            body = f'<div class="front">{imgs(c.get("front"))}</div>'
            if back:
                body += f'<hr id="answer"><div class="back">{imgs(c.get("back"))}</div>{ext}{src}'
        else:
            body = f'<div class="cloze-text">{imgs(cz(c.get("text")))}</div>' + (f"{ext}{src}" if back else "")
        return f'<div class="aa-wrap">{body}</div>'

    def preview_html(self, filename="anki_preview.html", ids=None, night=False):
        """One HTML file showing each card's front and back with the same styling as the Studio / exported
        note type (cloze: one row per deletion). Open it, or preview_png() it, to see what the user will see."""
        cards = [self.get(i) for i in ids] if ids else self.cards
        rows = []
        for c in cards:
            if not c:
                continue
            sides = [(None, False), (None, True)] if c["type"] == "basic" else [(k, b) for k in sorted({int(x) for x in re.findall(r"\{\{c(\d+)::", c.get("text", ""))}) or [1] for b in (False, True)]
            cells = "".join(f'<div class="cell"><div class="lab">{"c" + str(k) + " " if k else ""}{"back" if b else "front"}</div>'
                            f'<div class="card{" nightMode" if night else ""}">{render_math_html(fix_math(self._render_side(c, b, k)))}</div></div>' for k, b in sides)
            rows.append(f'<section><h2>{_html.escape(c["id"])} <small>{c["type"]}{" · " + _html.escape(", ".join(c.get("tags") or [])) if c.get("tags") else ""}</small></h2><div class="grid">{cells}</div></section>')
        page = (f'<!doctype html><html><head><meta charset="utf-8"><title>{_html.escape(self.name)} - preview</title>'
                + ('' if _latex2mathml() else '<script>window.MathJax={tex:{inlineMath:[["\\\\(","\\\\)"]],displayMath:[["\\\\[","\\\\]"]]}};</scr' 'ipt>'
                   '<script async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js"></scr' 'ipt>') +
                f'<style>math{{font-size:1.1em}}math[display=block]{{margin:.5em 0}}body{{margin:0;padding:16px;background:#e5e7eb;font-family:sans-serif}}section{{margin:0 0 22px}}h2{{font-size:15px;margin:0 0 6px}}h2 small{{color:#666;font-weight:normal}}'
                f'.grid{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}}.cell .lab{{font-size:11px;color:#555;margin:0 0 3px}}.card{{border-radius:10px;min-height:60px}}'
                f'{CARD_CSS}{HLJS_CSS}</style></head><body><h1 style="font-size:18px">{_html.escape(self.name)} - {len(rows)} card(s)</h1>{"".join(rows)}</body></html>')
        path = os.path.join(OUT_DIR, filename)
        open(path, "w", encoding="utf-8").write(page)
        print(f"Preview: {os.path.abspath(path)}")
        return path

    def preview_png(self, filename="anki_preview.png", ids=None, night=False, width=1100):
        """Screenshot of preview_html() (needs Playwright + Chromium, or a Chrome/Chromium binary). Returns the
        path, or None when no browser is available here - then look at preview_html() / contact_sheet() instead."""
        html_path = os.path.abspath(self.preview_html("_preview_tmp.html", ids, night))
        out = os.path.abspath(os.path.join(OUT_DIR, filename))
        shown = {m for c in self.cards if ids is None or c["id"] in [self._rid(i) for i in ids]
                 for m in re.findall(r'src="([^"]+)"', json.dumps(c, ensure_ascii=False).replace('\\"', '"'))}
        try:
            from playwright.sync_api import sync_playwright
            with sync_playwright() as p:
                b = p.chromium.launch(args=["--no-sandbox"])
                pg = b.new_page(viewport={"width": width, "height": 900})
                pg.goto("file://" + html_path); pg.wait_for_timeout(800)
                pg.screenshot(path=out, full_page=True); b.close()
            print(f"Preview image: {out}  <- open it with your image viewer now")
            self._seen.update(shown)
            return out
        except Exception as e:  # noqa: BLE001
            import shutil, subprocess
            exe = next((shutil.which(x) for x in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable") if shutil.which(x)), None)
            if exe:
                try:
                    subprocess.run([exe, "--headless", "--no-sandbox", "--disable-gpu", f"--window-size={width},4000", f"--screenshot={out}", "file://" + html_path],
                                   capture_output=True, timeout=60)
                    if os.path.exists(out):
                        print(f"Preview image: {out}  <- open it with your image viewer now")
                        self._seen.update(shown)
                        return out
                except Exception:  # noqa: BLE001
                    pass
            print(f"preview_png: no headless browser here ({str(e)[:80]}). Open {html_path} or use contact_sheet().")
            return None

    def contact_sheet(self, filename="anki_images.png", cols=3, thumb=360, per_sheet=12):
        """Tile every image with its file name (and what still needs providing) into PNG sheet(s), so all
        figures can be checked at once. Returns the list of paths."""
        Image = _pil()
        from PIL import ImageDraw
        names = list(self.media)
        if not names:
            print("no images"); return []
        paths = []
        for s0 in range(0, len(names), per_sheet):
            chunk = names[s0:s0 + per_sheet]
            rows = (len(chunk) + cols - 1) // cols
            cell_h = thumb + 34
            sheet = Image.new("RGB", (cols * (thumb + 16) + 16, rows * (cell_h + 16) + 16), "#e5e7eb")
            d = ImageDraw.Draw(sheet)
            for k, n in enumerate(chunk):
                x, y = 16 + (k % cols) * (thumb + 16), 16 + (k // cols) * (cell_h + 16)
                d.rectangle([x, y, x + thumb, y + thumb], fill="white", outline="#9ca3af")
                m = self.media[n]
                if m.get("data"):
                    try:
                        im = Image.open(io.BytesIO(m["data"])).convert("RGB"); im.thumbnail((thumb - 8, thumb - 8))
                        sheet.paste(im, (x + (thumb - im.width) // 2, y + (thumb - im.height) // 2))
                    except Exception as e:  # noqa: BLE001
                        d.text((x + 8, y + 8), f"UNREADABLE: {e}"[:60], fill="#b91c1c")
                else:
                    msg = f"{m.get('origin')}: " + (m.get("url") or m.get("hint") or "")
                    d.text((x + 8, y + 8), "\n".join(textwrap.wrap(msg, 48))[:400], fill="#92400e")
                used = [c["id"] for c in self.cards if f'src="{n}"' in json.dumps(c, ensure_ascii=False).replace('\\"', '"')]
                d.text((x, y + thumb + 4), n[:52], fill="#111827")
                d.text((x, y + thumb + 18), ("used by " + ", ".join(used[:4]) + ("…" if len(used) > 4 else "")) if used else "NOT USED", fill="#374151" if used else "#b91c1c")
            path = os.path.join(OUT_DIR, filename if s0 == 0 else filename.replace(".png", f"_{s0 // per_sheet + 1}.png"))
            sheet.save(path); paths.append(os.path.abspath(path))
            self._seen.update(chunk)
        print("Contact sheet(s): " + ", ".join(paths) + "  <- open each one with your image viewer now and check every image")
        bad = [n for n in self._overlap if n in self.media]
        if bad:
            print("  ! drawn with overlapping elements: " + ", ".join(bad))
        return paths

    # ---------------------------------------------------------------- study order: interleave without spoilers
    _STOP = set("the a an of and or to in on at for by with from is are was were be as that this these those it its into than then "
                "which what when where who how why does do not no can may also each per via".split())

    def _answers(self, c):
        """answer terms a card asks for"""
        t = []
        if c["type"] == "cloze":
            t = [a for a in re.findall(r"\{\{c\d+::(.*?)(?:::.*?)?\}\}", c.get("text", ""), re.S)]
        else:
            m = re.search(r'class="aa-answer">(.*?)</div>', c.get("back", ""), re.S)
            t = [m.group(1)] if m else [re.split(r"<br|</p>|\n", c.get("back", ""))[0]]
        return [self._norm(x) for x in t if self._norm(x)]

    def _shown(self, c):
        """everything a card reveals once answered"""
        return self._norm(" ".join(c.get(k, "") for k in ("front", "back", "text", "extra")).replace("{{", " ").replace("}}", " "))

    def _images(self, c):
        return set(re.findall(r'src="([^"]+)"', " ".join(str(v) for v in c.values())))

    def _spoils(self, a, b):
        """does studying card a (just before) give away card b's answer? -> reason or None"""
        shown = self._shown(a)
        for ans in self._answers(b):
            words = [w for w in re.findall(r"[a-z0-9][a-z0-9+\-.]*", ans) if w not in self._STOP]
            if not words:
                continue
            if len(ans) >= 3 and re.search(r"(?<![a-z0-9])" + re.escape(ans) + r"(?![a-z0-9])", shown):
                return f"its answer {ans[:40]!r} is shown by {a['id']}"
            nums = [w for w in words if re.fullmatch(r"\d[\d.]*", w) and len(w) >= 2]
            if nums and all(n in shown for n in nums):
                return f"its number(s) {', '.join(nums)} appear on {a['id']}"
        shared = self._images(a) & self._images(b)
        if shared:
            return f"same image {sorted(shared)[0]} as {a['id']}"
        return None

    def check_order(self, ids=None, window=3, quiet=False):
        """Warn where a card, studied up to `window` places earlier, gives away a later card's answer
        (answer terms, numbers, the same image). Returns the warnings."""
        order = [self._rid(i) for i in (ids or self.order or [c["id"] for c in self.cards])]
        out = []
        for j, bid in enumerate(order):
            b = self.get(bid)
            for i in range(max(0, j - window), j):
                a = self.get(order[i])
                why = a and b and self._spoils(a, b)
                if why:
                    out.append(f"order: {bid} (#{j + 1}) comes {j - i} after {a['id']} (#{i + 1}) - {why}")
                    break
        if not quiet:
            print("\n".join("  ! " + w for w in out) if out else "  no spoilers found in the order")
        return out

    def suggest_order(self, window=3):
        """A study order that interleaves topics (group= on add_*, else the first tag, else the order you wrote
        them in blocks), keeps prereq= cards first, and avoids spoilers within `window` places.
        Review it, then deck.set_order(deck.suggest_order())."""
        def group(c):
            g = (self._meta.get(c["id"]) or {}).get("group") or ((c.get("tags") or [None])[0])
            return g or f"block{self.cards.index(c) // 4}"
        queues = {}
        for c in self.cards:
            queues.setdefault(group(c), []).append(c["id"])
        pre = {cid: {self._rid(p) for p in (m or {}).get("prereq", [])} for cid, m in self._meta.items()}
        placed, out, last_g = set(), [], None
        while len(out) < len(self.cards):
            cands = []
            for g, q in queues.items():
                nxt = next((x for x in q if x not in placed and pre.get(x, set()) <= placed), None)
                if nxt:
                    cands.append((g, nxt))
            if not cands:   # prerequisites can't be satisfied (cycle) - take the next unplaced card
                rest = [c["id"] for c in self.cards if c["id"] not in placed]
                cands = [(group(self.get(rest[0])), rest[0])]
            recent = [self.get(x) for x in out[-window:]]
            def score(gc):
                g, cid = gc
                spoil = sum(1 for a in recent if self._spoils(a, self.get(cid)))
                return (spoil, g == last_g, -len([x for x in queues[g] if x not in placed]))
            g, cid = min(cands, key=score)
            out.append(cid); placed.add(cid); last_g = g
        return out

    # ---------------------------------------------------------------- source text (for checking ref quotes)
    def load_source(self, src, file=None):
        """Give validate() the text each ref points into, so it can check every quote is really there.
        src: a PDF / text / markdown path, extract.json (from extract.py), or the raw text of a batch prompt
        with [file p.N] markers (paste the whole SOURCE block). Returns {file: number of pages}."""
        text = None
        if isinstance(src, str) and os.path.exists(src):
            if src.lower().endswith(".pdf"):
                mu = _need_pymupdf()
                doc = mu.open(src)
                self.source_pages[file or os.path.basename(src)] = {i: p.get_text() for i, p in enumerate(doc, 1)}
                return {file or os.path.basename(src): len(doc)}
            if src.lower().endswith(".json"):
                d = json.load(open(src, encoding="utf-8"))
                for f in d.get("files", []):
                    self.source_pages[f["file"]] = {k["page"]: k["text"] for k in f.get("kept", [])}
                for it in d.get("items", []):           # anki_prompts.json
                    if it.get("content"):
                        self.load_source(it["content"])
                return {k: len(v) for k, v in self.source_pages.items()}
            text = open(src, encoding="utf-8", errors="replace").read()
            if not re.search(r"^\[[^\]\n]+ p\.\d+\]", text, re.M):
                self.source_pages[file or os.path.basename(src)] = {1: text}
                return {file or os.path.basename(src): 1}
        text = text if text is not None else str(src)
        parts = re.split(r"^\[([^\]\n]+?) (?:p|§)\.(\d+)\][^\n]*$", text, flags=re.M)
        if len(parts) < 3:
            self.source_pages[file or "source"] = {1: text}
        for i in range(1, len(parts) - 2, 3):
            self.source_pages.setdefault(parts[i].strip(), {})[int(parts[i + 1])] = parts[i + 2]
        return {k: len(v) for k, v in self.source_pages.items()}

    @staticmethod
    def _norm(t):
        t = _html.unescape(re.sub(r"<[^>]+>", " ", str(t)))
        t = t.replace("\u2019", "'").replace("\u2018", "'").replace("\u201c", '"').replace("\u201d", '"').replace("\u2013", "-").replace("\u2014", "-")
        return re.sub(r"\s+", " ", t).strip().lower()

    def _source_for(self, name):
        if not self.source_pages or not name:
            return None
        n = os.path.basename(str(name)).lower()
        stem = re.sub(r"\.[a-z0-9]+$", "", n)
        for k, v in self.source_pages.items():
            if k.lower() == n or re.sub(r"\.[a-z0-9]+$", "", k.lower()) == stem:
                return k, v
        return None

    # ---------------------------------------------------------------- explanations ("I don't understand this card")
    def explain(self, cid, markdown):
        """Record a step-by-step explanation of why a card says what it says (for 'I don't understand' feedback).
        save_explanations() writes them all to one markdown file."""
        cid = self._rid(cid)
        if not self.get(cid):
            raise KeyError(cid)
        self.explanations[cid] = textwrap.dedent(markdown).strip()

    def save_explanations(self, filename="anki_explanations.md"):
        """Write every explain() to a markdown file (one section per card, with the card's text). Returns the path."""
        strip = lambda t: _html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", t or ""))).strip()
        out = [f"# Explanations - {self.name}", ""]
        for cid, md in self.explanations.items():
            c = self.get(cid)
            q = strip(c.get("front") or c.get("text"))
            out += [f"## {cid}: {q[:120]}", ""]
            if c["type"] == "basic":
                out += [f"> **Q:** {q}", ">", f"> **A:** {strip(c.get('back'))[:400]}", ""]
            else:
                out += [f"> {q}", ""]
            out += [md, ""]
        path = os.path.join(OUT_DIR, filename)
        open(path, "w", encoding="utf-8").write("\n".join(out))
        print(f"Saved {os.path.abspath(path)} ({len(self.explanations)} explanation(s))")
        return path

    # ---------------------------------------------------------------- the final reply
    def summary(self, issues=None):
        """The exact text to send back after creating a deck - and nothing else."""
        b = sum(1 for c in self.cards if c["type"] == "basic")
        cz = sum(1 for c in self.cards if c["type"] == "cloze")
        iss = issues if isinstance(issues, str) else "; ".join(issues) if issues else "None"
        return (f"Deck generated: {self.name}\nTotal cards: {len(self.cards)}\nNumber of Basic cards: {b}\n"
                f"Number of Cloze cards: {cz}\nNumber of Images: {len(self.media)}\nUnexpected and unresolvable issues: {iss}")

    # ---------------------------------------------------------------- checks + output
    def validate(self, verbose=True, window=3):
        """Check the deck. Returns a list of problems ("ERROR ..." must be fixed; "warn ..." usually should be).
        Covers: card structure, every image link and image file, captions/escaping, allowed tags, inline colours,
        code blocks, maths delimiters, box kinds, ref quotes against load_source() text, missing glyphs in figures,
        the study order and spoilers between nearby cards in it."""
        errs, warns = [], []
        E, W = errs.append, warns.append
        ids = [c["id"] for c in self.cards]
        for d in sorted({i for i in ids if ids.count(i) > 1}):
            E(f"duplicate id {d}")
        used = set()
        prose = lambda h: re.sub(r"\\\(.*?\\\)|\\\[.*?\\\]", "", re.sub(r"<pre[\s\S]*?</pre>|<code[\s\S]*?</code>", "", h or ""), flags=re.S)
        self._fix_math_all()
        for c in self.cards:
            cid = c["id"]
            if not str(c.get("why") or "").strip():
                W(f"{cid}: no why= - explain why the card exists with why=rationale(tests=..., matters=..., mistake=..., connects=...)")
            else:
                wn = len(re.sub(r"<[^>]+>", " ", c["why"]).split())
                if wn < 45:
                    W(f"{cid}: why= is only {wn} words - make it extensive: what it tests, why it matters, the common "
                      "mistake, what it connects to (rationale() builds it)")
            if "multi-ok" not in (c.get("tags") or []):
                for level, prob in _multi_question(c):
                    (E if level == "E" else W)(f"{cid}: {prob}")
            if "refs-ok" not in (c.get("tags") or []):
                for level, prob in _outside_refs(c):
                    (E if level == "E" else W)(f"{cid}: {prob}")
            fields = {k: v for k, v in c.items() if k in ("front", "back", "text", "extra", "source") and isinstance(v, str)}
            if c["type"] == "basic":
                if not re.sub(r"<[^>]+>", "", c.get("front", "")).strip() and "<img" not in c.get("front", ""):
                    E(f"{cid}: empty front")
                if not c.get("back", "").strip():
                    E(f"{cid}: empty back")
                if len(re.sub(r"<[^>]+>", "", prose(c.get("front", "")))) > 300:
                    W(f"{cid}: front has >300 characters of prose - does it test one idea?")
            elif c["type"] == "cloze":
                t = c.get("text", "")
                if not re.search(r"\{\{c\d+::", t):
                    E(f"{cid}: cloze without {{{{c1::...}}}}")
                if re.search(r"\{\{c\d+::(?:(?!\}\}).)*\{\{c\d+::", t, re.S):
                    E(f"{cid}: nested cloze")
                if t.count("{{") != t.count("}}"):
                    E(f"{cid}: unbalanced {{{{ }}}} in the cloze text")
                for ans in re.findall(r"\{\{c\d+::(.*?)(?:::.*?)?\}\}", t, re.S):
                    if not re.sub(r"<[^>]+>|\s", "", ans):
                        E(f"{cid}: empty cloze deletion")
            else:
                E(f"{cid}: unknown type {c['type']}")
            for k, v in fields.items():
                where = f"{cid}.{k}"
                # images: every <img> must point at a registered file, by file name only
                for tag in re.findall(r"<img\b[^>]*>", v):
                    m = re.search(r'src\s*=\s*"([^"]*)"', tag) or re.search(r"src\s*=\s*'([^']*)'", tag)
                    if not m or not m.group(1).strip():
                        E(f"{where}: <img> without src"); continue
                    src = m.group(1)
                    used.add(src)
                    if src.startswith("data:"):
                        W(f"{where}: inline data: image - register it with add_image_bytes() instead")
                    elif src.startswith(("http://", "https://")):
                        E(f"{where}: <img> points at a URL ({src[:60]}) - use web_image() and its returned file name")
                    elif "/" in src or "\\" in src:
                        E(f"{where}: image src must be a bare file name, not a path ({src})")
                    elif src not in self.media:
                        close = [n for n in self.media if n.split(".")[0] == src.split(".")[0]]
                        E(f"{where}: image {src} is not registered on the deck" + (f" - did you mean {close[0]}? (use the name the image function returned)" if close else ""))
                # escaping: raw '<' that doesn't start a tag, raw '&' that isn't an entity
                text_only = re.sub(r"<pre[\s\S]*?</pre>", lambda mm: re.sub(r"<[^>]+>", "", mm.group(0)), _MATH_RE.sub("", v))
                for mm in re.finditer(r"<(?![a-zA-Z/!])", text_only):
                    E(f"{where}: raw '<' in text near {text_only[max(0, mm.start() - 15):mm.start() + 15]!r} - escape it with esc() / code(), or write &lt;"); break
                for mm in re.finditer(r"&(?!#?\w+;)", _MATH_RE.sub("", v)):
                    W(f"{where}: raw '&' near {v[max(0, mm.start() - 15):mm.start() + 15]!r} - write &amp;"); break
                for cap in re.findall(r"<figcaption>([\s\S]*?)</figcaption>", v):
                    if re.search(r"<(?![a-zA-Z/])|>", re.sub(r"<[^>]+>", "", cap)):
                        E(f"{where}: unescaped < or > in a caption ({cap[:50]!r})")
                # tags the note type knows; balanced
                for t2 in sorted({t.lower() for t in re.findall(r"</?([a-zA-Z][a-zA-Z0-9]*)", v)} - ALLOWED_TAGS):
                    E(f"{where}: <{t2}> is not supported on cards (allowed: {', '.join(sorted(ALLOWED_TAGS))})")
                for tag in ("div", "span", "b", "i", "ul", "ol", "table", "figure", "pre", "code", "p", "mark"):
                    if len(re.findall(f"<{tag}[ >]", v)) != len(re.findall(f"</{tag}>", v)):
                        E(f"{where}: unbalanced <{tag}>")
                # colours: the note type handles light/dark; inline colours break night mode
                for st in re.findall(r'style\s*=\s*"([^"]*)"', v):
                    if re.search(r"(^|;)\s*(background(-color)?|color)\s*:", st, re.I):
                        E(f"{where}: inline colour/background ({st[:60]!r}) - remove it. Cards are shown in light AND night mode; "
                          "a white/light background makes text unreadable in night mode. Use code() for code and box() for call-outs.")
                if re.search(r"<pre(?![^>]*>\s*<code)", v) or re.search(r"<pre[^>]*>\s*<code(?![^>]*language-)", v):
                    W(f"{where}: code block without a language - use code(text, 'java'|'python'|...) so it gets highlighted")
                # boxes
                for kind in re.findall(r'class="aa-box aa-([\w-]+)"', v):
                    if kind not in BOX_TITLES:
                        E(f"{where}: unknown box kind {kind!r} (valid: {', '.join(BOX_TITLES)})")
                # maths for Anki's MathJax
                if v.count("\\(") != v.count("\\)") or v.count("\\[") != v.count("\\]"):
                    E(f"{where}: unbalanced maths delimiters \\( \\) / \\[ \\]")
                for expr, disp in math_spans(v):
                    for prob in check_tex(expr):
                        o_, c_ = ("\\[", "\\]") if disp else ("\\(", "\\)")
                        E(f"{where}: maths {o_}{expr[:40]}{c_}: {prob}")
                if "}}}" in _CODE_RE.sub("", v) and k == "text":
                    W(f"{where}: '}}}}}}' - Anki ends the cloze at the first '}}}}'; put a space before the closing '}}}}'")
            # refs: present, findable, and really on that page
            for r in c.get("refs") or []:
                if not r.get("file"):
                    E(f"{cid}: ref needs a file / source name ({r})"); continue
                if not r.get("page") and not str(r["file"]).startswith(("http://", "https://")):
                    W(f"{cid}: ref has no page - fine for a web page / note, otherwise give the page ({r['file']})")
                q = r.get("quote") or ""
                if q and len(self._norm(q)) < 25:
                    W(f"{cid}: ref quote is short ({len(self._norm(q))} chars) - quote at least ~25 characters so it can be found")
                src = self._source_for(r["file"])
                if q and src:
                    fname, pages = src
                    nq = self._norm(q)
                    on = [p for p, txt in pages.items() if nq in self._norm(txt)]
                    if r.get("page") and r["page"] in pages and r["page"] not in on:
                        E(f"{cid}: ref quote not found on {fname} p.{r['page']}" + (f" - it is on p.{on[0]}" if on else " (or anywhere in that file) - copy it verbatim from the source text"))
                    elif not on:
                        E(f"{cid}: ref quote not found in {fname} - copy it verbatim from the source text")
        for m, meta in self.media.items():
            o = meta.get("origin")
            if m not in used:
                W(f"image {m} is registered but not used by any card")
            if o == "generated":
                if not meta.get("data"):
                    E(f"image {m}: no image data")
                else:
                    try:
                        Image = _pil(); im = Image.open(io.BytesIO(meta["data"])); im.verify()
                    except Exception as e:  # noqa: BLE001
                        E(f"image {m}: file is not a readable image ({e})")
            elif o == "url":
                u = meta.get("url") or ""
                if not re.match(r"^https?://", u):
                    E(f"image {m}: web_image URL is missing or not http(s)")
                elif "wikimedia.org" in u or "wikipedia.org" in u:
                    if not re.search(r"Special:FilePath/[^/?#]+\.(jpe?g|png|gif|svg|webp|tiff?)(\?|$)|upload\.wikimedia\.org/.+\.(jpe?g|png|gif|svg|webp)", u, re.I):
                        E(f"image {m}: Wikimedia link must be .../Special:FilePath/<Exact_File_Name.ext>?width=800 (got {u[:80]})")
                if not meta.get("verified"):
                    W(f"image {m}: web image not verified - only use file names you confirmed exist (search/fetch), or deck.check_web_images()")
            elif o == "material":
                h = meta.get("hint") or ""
                if not re.search(r"\d", h):
                    W(f"image {m}: material hint should name the file and page/slide ({h[:60]!r})")
        for fname, chars in self._glyph.items():
            E(f"image {fname}: the font drew boxes for {', '.join(chars)} - redraw it with plain text or mathtext")
        for fname, cl in self._overlap.items():
            if fname in self.media:
                E(f"image {fname}: elements overlap ({'; '.join(cl[:3])}{' …' if len(cl) > 3 else ''}) - redraw it with more room / shorter labels")
        unseen = sorted(n for n in self._new_media if n in self.media and self.media[n].get("data") and n not in self._seen)
        if unseen:
            E(f"{len(unseen)} new image(s) not looked at yet ({', '.join(unseen[:4])}{' …' if len(unseen) > 4 else ''}) - "
              "run deck.contact_sheet(), OPEN the sheet with your image viewer and check every image for overlapping or "
              "cut-off elements, unreadable text and wrong content before finishing")
        if self.order:
            missing = [c["id"] for c in self.cards if c["id"] not in self.order]
            stale = [i for i in self.order if not self.get(i)]
            if missing:
                E(f"order: {len(missing)} card(s) not in set_order(): {missing[:5]}")
            if stale:
                E(f"order: unknown/deleted ids {stale[:5]}")
            if not missing and not stale:
                warns += [f"warn {w}" for w in self.check_order(window=window, quiet=True)]
        probs = [f"ERROR {e}" for e in errs] + [w if w.startswith("warn ") else f"warn {w}" for w in warns]
        if verbose:
            n_img = sum(1 for c in self.cards if "<img" in json.dumps(c))
            print(f"{len(self.cards)} cards ({n_img} with images), {len(self.media)} images: {len(errs)} error(s), {len(warns)} warning(s)")
            print("\n".join("  ! " + p for p in probs) if probs else "  no problems found")
        return probs

    def check_web_images(self, timeout=8):
        """Try to fetch every web_image URL; marks the reachable ones verified. Often impossible in a sandbox
        without internet - then confirm file names with web search/fetch instead."""
        import urllib.request
        ok = bad = skipped = 0
        for n, m in self.media.items():
            if m.get("origin") != "url":
                continue
            try:
                req = urllib.request.Request(m["url"], method="GET", headers={"User-Agent": "anki-helper/1 (card images)", "Range": "bytes=0-1023"})
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    if r.status < 400 and "image" in (r.headers.get("Content-Type") or ""):
                        m["verified"] = True; ok += 1
                    else:
                        m["error"] = f"HTTP {r.status} {r.headers.get('Content-Type')}"; bad += 1
            except Exception as e:  # noqa: BLE001
                msg = str(e)
                if re.search(r"Name or service|getaddrinfo|timed out|Tunnel|403 Forbidden|proxy", msg, re.I) and "404" not in msg:
                    skipped += 1
                else:
                    m["error"] = msg[:120]; bad += 1
        print(f"web images: {ok} ok, {bad} broken, {skipped} could not be checked from here")
        return bad == 0

    def _media_entries(self, names, with_data):
        out = []
        for n in names:
            m = self.media[n]
            e = {"filename": n, **{k: v for k, v in m.items() if k != "data"}}
            if with_data and m.get("data"):
                e["data"] = base64.b64encode(m["data"]).decode()
            out.append(e)
        return out

    def to_dict(self, with_data=True, revision=False):
        cards = [c for c in self.cards if c["id"] in self._dirty] if revision else list(self.cards)
        cards += [{"id": d, "delete": True} for d in sorted(self._deleted)] if revision else []
        if revision:
            refs = {r for c in cards for v in c.values() if isinstance(v, str) for r in re.findall(r'src="([^"]+)"', v)}
            names = [n for n in self.media if n in refs or n in self._new_media]
        else:
            names = list(self.media)
        d = {"format": FORMAT, "deck": self.name, "tags": self.tags, "revision": revision,
             "created": datetime.datetime.now().isoformat(timespec="seconds"),
             "cards": cards, "media": self._media_entries(names, with_data)}
        if self.order:
            d["order"] = [i for i in self.order if self.get(i)]
        return d

    def _fix_math_all(self):
        """$…$ → \\( \\) etc. on every card (also catches fields set directly); marks changed cards dirty"""
        for c in self.cards:
            for k in ("front", "back", "extra", "text"):
                v = c.get(k)
                if isinstance(v, str):
                    nv = fix_math(v)
                    if nv != v:
                        c[k] = nv
                        self._dirty.add(c["id"])

    def save(self, filename=None, revision=False, print_block=False):
        """Write the bundle (cards + embedded images) to OUT_DIR and print its full path.
        revision=True only includes cards added/updated/deleted since Deck.load().
        print_block=True also prints the <<<ANKI_CARDS block (only for chats that can't hand over files)."""
        filename = filename or ("anki_revision.json" if revision else "anki_bundle.json")
        self._fix_math_all()
        path = os.path.join(OUT_DIR, filename)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(True, revision), f, ensure_ascii=False)
        size = os.path.getsize(path) / 1024
        d = self.to_dict(False, revision)
        print(f"Saved {os.path.abspath(path)} ({size:.0f} KB): {len(d['cards'])} cards, {len(d['media'])} images")
        if os.path.abspath(path).startswith("/mnt/user-data/outputs"):
            print("  (claude.ai: files in /mnt/user-data/outputs are what you hand to the user)")
        if print_block:
            print("\n" + START)
            print(json.dumps(d, ensure_ascii=False, indent=1))
            print(END)
        return path

    @classmethod
    def load(cls, src):
        """Resume from a bundle file path, a JSON string, or pasted text with <<<ANKI_CARDS markers."""
        if isinstance(src, dict):
            d = src
        else:
            text = open(src, encoding="utf-8").read() if os.path.exists(str(src)) else str(src)
            blocks = [json.loads(b) for b in re.findall(r"<<<(?:ANKI|REVISE)_CARDS(.*?)(?:ANKI|REVISE)_CARDS>>>", text, re.S)
                      if '"cards"' in b]
            d = blocks[0] if blocks else json.loads(text)
            for extra in blocks[1:]:          # several blocks (long decks) are merged
                d["cards"] = d.get("cards", []) + extra.get("cards", [])
                d["media"] = d.get("media", []) + extra.get("media", [])
        deck = cls(d.get("deck", "AI Generated Deck"), d.get("tags", []))
        deck.order = list(d.get("order") or [])
        deck.explanations = {}
        deck.cards = [c for c in d.get("cards", []) if not c.get("delete")]
        deck.feedback = {c["id"]: c.pop("feedback") for c in deck.cards if c.get("feedback")}
        for m in d.get("media", []):
            e = {k: v for k, v in m.items() if k not in ("filename", "data")}
            e["data"] = base64.b64decode(m["data"]) if m.get("data") else None
            deck.media[m["filename"]] = e
        deck._reserved = set(d.get("existing_ids", []))      # ids used elsewhere in the full deck
        nums = [int(x) for i in [c["id"] for c in deck.cards] + list(deck._reserved) for x in re.findall(r"^\D*(\d+)$", i)]
        deck._n = max(nums or [0])
        deck._dirty, deck._deleted, deck._new_media = set(), set(), set()
        print(f"Loaded '{deck.name}': {len(deck.cards)} cards, {len(deck.media)} images")
        return deck

    def show(self, cid=None):
        """Print cards (or one card) as readable text."""
        for c in ([self.get(cid)] if cid else self.cards):
            strip = lambda s: re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s or "")).strip()
            print(f"[{c['id']}] ({c['type']}) tags={c.get('tags')}")
            if c["id"] in self.feedback:
                print("  FEEDBACK:", self.feedback[c["id"]])
            if c["type"] == "basic":
                print("  Q:", strip(c["front"]))
                print("  A:", strip(c["back"])[:300])
            else:
                print("  T:", strip(c["text"])[:300])
            imgs = [r for v in c.values() if isinstance(v, str) for r in re.findall(r'src="([^"]+)"', v)]
            if imgs:
                print("  images:", ", ".join(imgs))


# --------------------------------------------------------------------------- help
def help():
    print(textwrap.dedent(f"""
    anki_helper - API summary     (output dir: {os.path.abspath(OUT_DIR)})
    ───────────────────────────────────────────────────────────────────────────
    FILES      list_uploads(), find_upload("part_of_name")
    PDF        pdf_info(p), pdf_text(p, page), pdf_find(p, "Figure 3"),
               pdf_figures(p, page=None), render_page_preview(p, page)
    OFFICE     office_images(p)    (.docx/.pptx embedded images)

    deck = Deck("Parent::Child", tags=["topic"], id_prefix="c")   # batch: id_prefix="L01-c"
    deck = Deck.load(path_or_pasted_text)    # resume a bundle / revision request; deck.feedback = {{id: text}}
    deck.load_source(pdf_or_text)            # the material refs point into -> validate() checks every quote
    IMAGES (each returns the filename to reference)
      deck.pdf_figure(p, page, index=0, name)          embedded figure incl. overlaid labels
      deck.crop_pdf(p, page, box=(x0,y0,x1,y1), name)   any region; box = page fractions
      deck.add_image_file(p, name, box=None)           uploaded screenshot/photo (+crop)
      deck.office_image(p, index_or_member, name)
      deck.figure(matplotlib_fig, name)                your own chart (missing glyphs are caught)
      deck.flowchart(steps, name, direction="LR"|"TB", per_row=4)   boxes sized to their text
      deck.concept_map(center, [(branch, [children]), ...], name)
      deck.graph(nodes, edges, name, direction="TB"|"LR")           layered graph, labelled arrows
      deck.table_image(headers, rows, name)            table as an image (prefer HTML table() if short)
      deck.timeline([(when, text), ...], name)
      deck.labeled_image(base, [(x, y, "label"), ...], name, numbered=False)
      deck.web_image(url, name, caption, credit)       real photo; only CONFIRMED Wikimedia file names
      deck.material(name, hint)                        user snips it later ("file p.N - which figure")
    CARDS (fields are HTML; returns id)
      deck.add_basic(front, back, extra="", source="", tags=[], images=[], ref=("f.pdf", 12, "verbatim quote"),
                     name="handle", group="topic", prereq=["other handle"], after=None,
                     why=rationale(tests="…", matters="…", mistake="…", connects="…"))   ONE question per card
      deck.add_cloze(text, extra="", source="", tags=[], images=[], ref=..., name=..., group=..., prereq=..., why=...)
      deck.update(id_or_name, **fields), deck.delete(id_or_name), deck.show(id=None)
    HTML       answer(t), box(kind, html, title=None), img(name, caption), bullets(list), table(headers, rows),
               code(text, "java"), code(text, inline=True), tex(r"\\frac{{a}}{{b}}"), cloze(text, n, hint), esc(text)
               box kinds: {", ".join(BOX_TITLES)}
    ORDER      deck.suggest_order() -> ids;  deck.set_order(ids_or_names);  deck.check_order()
    CHECK      deck.validate()   ERROR = must fix, warn = should look      deck.check_web_images()
               deck.contact_sheet() -> PNG paths: OPEN every one and look at every image (overlaps, clipping, content)
    SEE        deck.preview_html() / deck.preview_png()   deck.contact_sheet()
    OUTPUT     deck.save()  -> anki_bundle.json (prints its full path)     print(deck.summary(issues))
               deck.save(revision=True)  (after Deck.load)  -> anki_revision.json
               deck.explain(id, markdown); deck.save_explanations()  -> anki_explanations.md
    """))


if __name__ == "__main__" and os.path.basename(sys.argv[0] if sys.argv else "") == "anki_helper.py":
    help()
else:
    print(f"anki_helper loaded - outputs go to {OUT_DIR}. Call help() for the API.")
