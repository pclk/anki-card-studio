# /// script
# requires-python = ">=3.9"
# ///
"""
make_prompts.py - assemble anki_prompts.json (for Anki Card Studio's batch queue) from
extract.json plus a small plan, so the lecture text never has to pass through the AI's output.

  # one prompt per file (no plan needed); long files are split into parts of --max-pages
  uv run make_prompts.py extract.json --per-file --deck-root "CS2030S" [--max-pages 30] -o anki_prompts.json

  # your own split
  uv run make_prompts.py extract.json --plan plan.json -o anki_prompts.json

plan.json (the only thing the planning AI writes):
  {"deck_root": "CS2030S",
   "items": [{"id": "L01", "title": "Intro to Java", "focus": "1-3 sentences", "count": 25,
              "sources": [{"file": "L01.pdf", "pages": "1-18"}, {"file": "L02.pdf", "pages": "1-3"}]}]}
  "deck" is optional (default "<deck_root>::<id> <title>"), "pages" is optional (default: all),
  ranges look like "1-12,15,20-22". Files can be named by file name or stem.

Checks coverage: prints pages that no prompt includes, so nothing is silently left out.
"""
from __future__ import annotations

import argparse, json, re, sys
from pathlib import Path

FORMAT = "anki-studio/prompts-v1"
BIG = 60_000  # ~tokens; above this a single chat may struggle


def parse_pages(spec, available: list[int]) -> list[int]:
    if spec in (None, "", "all", "*"):
        return list(available)
    want = set()
    for part in str(spec).replace(" ", "").split(","):
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            want.update(range(int(a), int(b or max(available or [0])) + 1))
        else:
            want.add(int(part))
    return [p for p in available if p in want]


def find_file(files: list[dict], name: str) -> dict | None:
    n = name.lower()
    stem = re.sub(r"\.(pdf|pptx?|docx|txt|md)$", "", n)
    for f in files:
        fn = f["file"].lower()
        if fn == n or re.sub(r"\.(pdf|pptx?|docx|txt|md)$", "", fn) == stem:
            return f
    hits = [f for f in files if stem in f["file"].lower()]
    return hits[0] if len(hits) == 1 else None


def content_for(f: dict, pages: list[int]) -> str:
    by = {k["page"]: k for k in f["kept"]}
    out = []
    for p in pages:
        k = by[p]
        mark = f"[{f['file']} p.{p}]" + (f" (slide builds from p.{k['builds_from']})" if k.get("builds_from") else "")
        body = k["text"]
        if k.get("figure"):
            body = (body + "\n" if body else "") + "[figure on this page]"
        out.append(f"{mark}\n{body}")
    return "\n\n".join(out)


def short_id(stem: str, used: set) -> str:
    m = re.search(r"(?:^|[^A-Za-z])(L|lec|lecture|week|w|ch|chapter|unit|t|tut|tutorial)?[ _-]?0*(\d{1,3})(?!\d)", stem, re.I)
    base = (f"{(m.group(1) or 'L')[:1].upper()}{int(m.group(2)):02d}" if m else re.sub(r"[^A-Za-z0-9]+", "", stem)[:10]) or "P"
    i, cand = 2, base
    while cand in used:
        cand = f"{base}_{i}"; i += 1
    used.add(cand)
    return cand


def per_file_plan(ex: dict, root: str, max_pages: int) -> dict:
    items, used = [], set()
    for f in ex["files"]:
        stem = Path(f["file"]).stem
        pid = short_id(stem, used)
        first = next((k["text"].split("\n")[0] for k in f["kept"] if k["text"]), stem)
        title = re.sub(r"\s+", " ", first)[:70] or stem
        pages = [k["page"] for k in f["kept"]]
        chunks = [pages[i:i + max_pages] for i in range(0, len(pages), max_pages)] if max_pages and len(pages) > max_pages else [pages]
        for j, ch in enumerate(chunks):
            sid = pid if len(chunks) == 1 else f"{pid}{'abcdefghijklmnopqrstuvwxyz'[j]}"
            items.append({"id": sid, "title": title + (f" (part {j + 1}/{len(chunks)})" if len(chunks) > 1 else ""),
                          "sources": [{"file": f["file"], "pages": f"{ch[0]}-{ch[-1]}"}]})
    return {"deck_root": root, "items": items}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("extract")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--plan")
    g.add_argument("--per-file", action="store_true")
    ap.add_argument("--deck-root", default=None)
    ap.add_argument("--max-pages", type=int, default=0, help="--per-file: split files longer than this")
    ap.add_argument("-o", "--out", default="anki_prompts.json")
    a = ap.parse_args()

    ex = json.loads(Path(a.extract).read_text(encoding="utf-8"))
    if a.per_file:
        plan = per_file_plan(ex, a.deck_root or "AI Generated Deck", a.max_pages)
    else:
        plan = json.loads(Path(a.plan).read_text(encoding="utf-8"))
    root = a.deck_root or plan.get("deck_root") or "AI Generated Deck"

    items, problems, covered = [], [], {f["file"]: set() for f in ex["files"]}
    for i, it in enumerate(plan.get("items", [])):
        pid = str(it.get("id") or f"P{i + 1:02d}")
        parts, srcs = [], []
        for s in it.get("sources") or [{"file": f["file"]} for f in ex["files"]]:
            f = find_file(ex["files"], str(s.get("file", "")))
            if not f:
                problems.append(f"{pid}: file not found in extract: {s.get('file')}"); continue
            pages = parse_pages(s.get("pages"), [k["page"] for k in f["kept"]])
            if not pages:
                problems.append(f"{pid}: no kept pages for {f['file']} {s.get('pages')}"); continue
            covered[f["file"]].update(pages)
            parts.append(content_for(f, pages))
            srcs.append({"file": f["file"], "pages": f"{pages[0]}-{pages[-1]}" if len(pages) > 1 else str(pages[0])})
        title = str(it.get("title") or pid)
        item = {"id": pid, "title": title, "deck": it.get("deck") or f"{root}::{pid} {title.replace('::', ' -')}",
                "focus": it.get("focus", ""), "sources": srcs, "content": "\n\n".join(parts)}
        if it.get("count"):
            item["count"] = it["count"]
        items.append(item)

    out = {"format": FORMAT, "deck_root": root, "items": items}
    Path(a.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"{len(items)} prompts -> {a.out}")
    for it in items:
        tok = len(it["content"]) // 4
        print(f"  {it['id']:<8} ~{tok:>6} tok  {it['title'][:60]}" + ("   <- large, consider splitting" if tok > BIG else ""))
    for f, pages in covered.items():
        kept = [k["page"] for fx in ex["files"] if fx["file"] == f for k in fx["kept"]]
        miss = [p for p in kept if p not in pages]
        if miss:
            problems.append(f"not covered by any prompt: {f} pages {compress(miss)}")
    for p in problems:
        print("  ! " + p)
    if problems:
        sys.exit(1 if any("not found" in p for p in problems) else 0)


def compress(nums: list[int]) -> str:
    out, start, prev = [], None, None
    for n in nums + [None]:
        if start is None:
            start = prev = n
        elif n is not None and n == prev + 1:
            prev = n
        else:
            out.append(str(start) if start == prev else f"{start}-{prev}")
            start = prev = n
    return ",".join(out)


if __name__ == "__main__":
    main()
