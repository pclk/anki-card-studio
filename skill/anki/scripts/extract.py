# /// script
# requires-python = ">=3.9"
# dependencies = ["pymupdf>=1.23", "python-pptx>=0.6.21", "python-docx>=1.0"]
# ///
"""
extract.py - turn lecture material into compact, page-marked text for batch Anki prompts.

  uv run extract.py FILES_OR_FOLDERS... -o extract.json [--outline] [--keep-builds]

Supports .pdf, .pptx, .docx, .txt, .md. For every file it keeps the text page by page and
shrinks it without losing substance:
  * drops headers/footers that repeat on many pages, and bare page numbers
  * drops slide "builds" (a page whose lines all reappear on the next page)
  * joins hyphenated line breaks and collapses whitespace
  * marks pages that carry pictures/diagrams with [figure] so card writers know a visual exists

Prints a summary (pages, kept pages, ~tokens per file). --outline also prints the first line of
every kept page, which is usually enough to plan a split WITHOUT reading the full text.
The JSON is the input for make_prompts.py.
"""
from __future__ import annotations

import argparse, json, re, sys
from collections import Counter
from pathlib import Path

EXTS = {".pdf", ".pptx", ".docx", ".txt", ".md"}


def clean_lines(text: str) -> list[str]:
    text = text.replace("­", "").replace("\xa0", " ")
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)                 # hyph-\nenation
    lines = [re.sub(r"[ \t]+", " ", l).strip() for l in text.splitlines()]
    out = []
    for l in lines:
        if not l:
            if out and out[-1] != "":
                out.append("")
            continue
        if re.fullmatch(r"(page\s*)?\d{1,4}(\s*(/|of)\s*\d{1,4})?", l, re.I):   # page numbers
            continue
        out.append(l)
    while out and out[-1] == "":
        out.pop()
    return out


def pdf_pages(path: Path) -> list[dict]:
    import pymupdf
    doc = pymupdf.open(path)
    pages = []
    for i, p in enumerate(doc, 1):
        W, H = p.rect.width, p.rect.height
        imgs = [b for b in p.get_image_info() if (b["bbox"][2] - b["bbox"][0]) > W * 0.12 and (b["bbox"][3] - b["bbox"][1]) > H * 0.08]
        try:
            drawings = len(p.get_drawings())
        except Exception:
            drawings = 0
        pages.append({"page": i, "lines": clean_lines(p.get_text("text", sort=True)), "figure": bool(imgs) or drawings > 40})
    return pages


def pptx_pages(path: Path) -> list[dict]:
    from pptx import Presentation
    from pptx.enum.shapes import MSO_SHAPE_TYPE
    from pptx.util import Emu
    prs = Presentation(str(path))
    pages = []

    def shape_text(sh, acc, fig):
        if sh.shape_type == MSO_SHAPE_TYPE.PICTURE:
            fig.append(sh.name)
        if getattr(sh, "has_table", False) and sh.has_table:
            for row in sh.table.rows:
                acc.append(" | ".join(c.text.strip() for c in row.cells))
        if getattr(sh, "has_text_frame", False) and sh.has_text_frame:
            for para in sh.text_frame.paragraphs:
                t = "".join(r.text for r in para.runs).strip()
                if t:
                    acc.append(("  " * para.level) + ("- " if para.level else "") + t)
        if getattr(sh, "has_chart", False) and sh.has_chart:
            fig.append("chart")
        for sub in getattr(sh, "shapes", []) or []:
            shape_text(sub, acc, fig)

    for i, slide in enumerate(prs.slides, 1):
        acc, fig = [], []
        shapes = sorted(slide.shapes, key=lambda s: ((s.top or 0) // Emu(200000), s.left or 0))
        for sh in shapes:
            shape_text(sh, acc, fig)
        if slide.has_notes_slide:
            notes = slide.notes_slide.notes_text_frame.text.strip() if slide.notes_slide.notes_text_frame else ""
            if notes:
                acc += ["", "Speaker notes: " + re.sub(r"\s+", " ", notes)]
        pages.append({"page": i, "lines": clean_lines("\n".join(acc)), "figure": bool(fig)})
    return pages


def docx_pages(path: Path) -> list[dict]:
    import docx
    d = docx.Document(str(path))
    sections, cur = [], []
    for para in d.paragraphs:
        style = (para.style.name or "").lower() if para.style is not None else ""
        if style.startswith("heading") and cur:
            sections.append(cur); cur = []
        if para.text.strip():
            cur.append(("# " if style.startswith("heading") else "") + para.text.strip())
    for t in d.tables:
        cur += [" | ".join(c.text.strip() for c in row.cells) for row in t.rows]
    if cur:
        sections.append(cur)
    return [{"page": i, "lines": clean_lines("\n".join(s)), "figure": False} for i, s in enumerate(sections, 1)]


def text_pages(path: Path, chunk: int = 3500) -> list[dict]:
    txt = path.read_text(encoding="utf-8", errors="replace")
    parts, buf = [], ""
    for para in re.split(r"\n\s*\n", txt):
        if len(buf) + len(para) > chunk and buf:
            parts.append(buf); buf = ""
        buf += para + "\n\n"
    if buf.strip():
        parts.append(buf)
    return [{"page": i, "lines": clean_lines(p), "figure": False} for i, p in enumerate(parts, 1)]


def strip_repeats(pages: list[dict]) -> int:
    """Remove short lines that repeat on >=40% of pages (headers, footers, course codes)."""
    if len(pages) < 3:
        return 0
    cnt = Counter(l for p in pages for l in set(p["lines"]) if l and len(l) < 80)
    rep = {l for l, n in cnt.items() if n >= max(3, 0.4 * len(pages))}
    removed = 0
    for p in pages:
        before = len(p["lines"])
        p["lines"] = [l for l in p["lines"] if l not in rep]
        removed += before - len(p["lines"])
    return removed


def drop_builds(pages: list[dict]) -> int:
    """Slide decks often repeat a slide with one more bullet each time: keep only the last build."""
    dropped = 0
    for a, b in zip(pages, pages[1:]):
        la = [l for l in a["lines"] if l]
        lb = set(l for l in b["lines"] if l)
        if la and len(la) >= 2 and all(l in lb for l in la):
            a["drop"] = True
            b["builds_from"] = a.get("builds_from", a["page"])
            b["figure"] = b["figure"] or a["figure"]
            dropped += 1
    return dropped


def extract(path: Path, keep_builds: bool) -> dict:
    ext = path.suffix.lower()
    pages = {".pdf": pdf_pages, ".pptx": pptx_pages, ".docx": docx_pages}.get(ext, text_pages)(path)
    builds = 0 if keep_builds or ext not in (".pdf", ".pptx") else drop_builds(pages)
    rep = strip_repeats([p for p in pages if not p.get("drop")])
    kept = []
    for p in pages:
        if p.get("drop"):
            continue
        text = "\n".join(p["lines"]).strip()
        if not text and not p["figure"]:
            continue
        e = {"page": p["page"], "text": text, "figure": p["figure"]}
        if p.get("builds_from"):
            e["builds_from"] = p["builds_from"]
        kept.append(e)
    chars = sum(len(k["text"]) for k in kept)
    return {"file": path.name, "path": str(path), "kind": ext.lstrip("."), "pages": len(pages), "kept": kept,
            "chars": chars, "removed_repeated_lines": rep, "dropped_builds": builds}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("-o", "--out", default="extract.json")
    ap.add_argument("--outline", action="store_true", help="print the first line of every kept page")
    ap.add_argument("--keep-builds", action="store_true", help="don't drop slide builds")
    a = ap.parse_args()

    files = []
    for x in a.inputs:
        p = Path(x)
        if p.is_dir():
            files += sorted(f for f in p.rglob("*") if f.suffix.lower() in EXTS)
        elif p.exists() and p.suffix.lower() in EXTS:
            files.append(p)
        else:
            print(f"skip: {x}", file=sys.stderr)
    if not files:
        sys.exit("no supported files (.pdf .pptx .docx .txt .md)")
    # natural sort so L2 comes before L10
    files.sort(key=lambda f: [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", f.name)])

    out = {"format": "anki-studio/extract-v1", "files": []}
    total = 0
    print(f"{'file':40} {'pages':>5} {'kept':>5} {'~tokens':>8}  first line")
    for f in files:
        try:
            r = extract(f, a.keep_builds)
        except Exception as e:
            print(f"ERROR {f.name}: {e}", file=sys.stderr); continue
        out["files"].append(r)
        tok = r["chars"] // 4; total += tok
        first = next((k["text"].split("\n")[0] for k in r["kept"] if k["text"]), "")[:50]
        print(f"{r['file'][:40]:40} {r['pages']:>5} {len(r['kept']):>5} {tok:>8}  {first}")
        if a.outline:
            for k in r["kept"]:
                head = k["text"].split("\n")[0][:90] if k["text"] else "(figure only)"
                print(f"    p.{k['page']:<4}{'[fig] ' if k['figure'] else ''}{head}")
    Path(a.out).write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"\n{len(out['files'])} files, ~{total} tokens of text -> {a.out}")


if __name__ == "__main__":
    main()
