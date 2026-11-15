#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# ///
"""
acs.py - local companion server for Anki Card Studio (ACS).

  uv run acs.py            (or: python3 acs.py)   then open http://127.0.0.1:8765
  options: --port 8765  --data <folder>  --no-browser

What it does
  * keeps ALL Studio data in one real folder, shared by every copy/version of the .html:
        macOS    ~/Library/Application Support/AnkiCardStudio
        Linux    $XDG_DATA_HOME/AnkiCardStudio   (~/.local/share/AnkiCardStudio)
        Windows  %APPDATA%\\AnkiCardStudio
    layout:
        settings.json            keys, menu options, preferences
        projects.json            project list
        projects/<id>/project.json   cards, tree, prompt queue ...  (+ history/ backups)
        projects/<id>/media/         card images
        projects/<id>/sources/       imported source files + extracted text
        apps/                        put Studio .html versions here (served at /apps/...)
        trash/                       deleted projects (never hard-deleted)
  * serves the Studio: / opens the .html next to this script or in apps/ (a list when there are several)
  * open the Studio through the server (http://127.0.0.1:8765/...) so it can reach the data folder.
    An .html double-clicked from disk (file://) is only allowed with --allow-file-pages, because
    websites can fake that kind of origin too.
  * "Open folder" (Finder / Explorer / file manager)
  * fetches web pages as readable text for the Sources step (browsers can't, because of CORS)

Only listens on 127.0.0.1 and only answers this server's own pages (and file:// pages when
--allow-file-pages is given), never other websites.
"""
from __future__ import annotations

import argparse, datetime, html, json, mimetypes, os, re, shutil, subprocess, sys, threading, time, urllib.parse, urllib.request, webbrowser
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "2"
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._()+,=@#&'\-\[\]]{0,180}$")   # media/source file names
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_BODY = 512 * 1024 * 1024


def default_data_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "AnkiCardStudio"
    if os.name == "nt":
        return Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "AnkiCardStudio"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "AnkiCardStudio"


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def backup(path: Path, keep: int = 30, every_s: int = 600) -> None:
    """Keep a rolling history of project.json (at most one copy per 10 minutes)."""
    if not path.exists():
        return
    hist = path.parent / "history"
    hist.mkdir(exist_ok=True)
    old = sorted(hist.glob("project-*.json"))
    if old and time.time() - old[-1].stat().st_mtime < every_s:
        return
    shutil.copy2(path, hist / f"project-{datetime.datetime.now():%Y%m%d-%H%M%S}.json")
    for f in old[: max(0, len(old) + 1 - keep)]:
        f.unlink(missing_ok=True)


class TextOf(HTMLParser):
    """Very small readability: keep headings, paragraphs, lists, code, tables; drop chrome."""
    SKIP = {"script", "style", "noscript", "svg", "nav", "footer", "header", "aside", "form", "iframe", "button"}
    BLOCK = {"p", "div", "section", "article", "li", "tr", "br", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "table", "ul", "ol", "dd", "dt", "figcaption"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.skip, self.title, self.in_title, self.pre = [], 0, "", False, 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        if tag == "title":
            self.in_title = True
        if self.skip:
            return
        if tag == "pre":
            self.pre += 1
            self.out.append("\n```\n")
        elif tag in ("h1", "h2", "h3", "h4"):
            self.out.append("\n\n" + "#" * int(tag[1]) + " ")
        elif tag == "li":
            self.out.append("\n- ")
        elif tag in ("td", "th"):
            self.out.append(" | ")
        elif tag == "img":
            alt = dict(attrs).get("alt")
            if alt:
                self.out.append(f" [image: {alt}] ")
        elif tag in self.BLOCK:
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
        if tag == "title":
            self.in_title = False
        if self.skip:
            return
        if tag == "pre":
            self.pre = max(0, self.pre - 1)
            self.out.append("\n```\n")
        elif tag in self.BLOCK:
            self.out.append("\n")

    def handle_data(self, data):
        if self.in_title:
            self.title += data
        if self.skip:
            return
        self.out.append(data if self.pre else re.sub(r"\s+", " ", data))

    def text(self):
        t = "".join(self.out)
        t = re.sub(r"[ \t]+\n", "\n", t)
        t = re.sub(r"\n{3,}", "\n\n", t)
        return t.strip()


def fetch_readable(url: str) -> dict:
    if not re.match(r"^https?://", url, re.I):
        raise ValueError("only http(s) URLs")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (ACS source import)", "Accept": "text/html,text/plain,*/*"})
    with urllib.request.urlopen(req, timeout=25) as r:
        ctype = r.headers.get("Content-Type", "")
        raw = r.read(25 * 1024 * 1024)
        final = r.geturl()
    if "pdf" in ctype or final.lower().endswith(".pdf"):
        return {"url": final, "kind": "pdf", "title": Path(urllib.parse.urlparse(final).path).name or "download.pdf", "binary": True, "bytes": raw}
    charset = (re.search(r"charset=([\w-]+)", ctype) or [None, "utf-8"])[1]
    text = raw.decode(charset, errors="replace")
    if "html" not in ctype and not re.search(r"<html|<body|<p[ >]", text[:5000], re.I):
        return {"url": final, "kind": "text", "title": final, "text": text}
    # prefer <main>/<article> when present
    m = re.search(r"<(main|article)\b[\s\S]*?</\1>", text, re.I)
    p = TextOf()
    p.feed(m.group(0) if m and len(m.group(0)) > 2000 else text)
    title = html.unescape(re.search(r"<title[^>]*>([\s\S]*?)</title>", text, re.I).group(1).strip()) if re.search(r"<title", text, re.I) else final
    return {"url": final, "kind": "web", "title": re.sub(r"\s+", " ", title)[:200], "text": p.text()}


def open_in_file_manager(path: Path) -> None:
    if sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    elif os.name == "nt":
        os.startfile(str(path))  # type: ignore[attr-defined]
    else:
        subprocess.Popen(["xdg-open", str(path)])


class App:
    def __init__(self, data: Path, port: int, script_dir: Path, allow_file: bool = False):
        self.data, self.port, self.script_dir, self.allow_file = data, port, script_dir, allow_file
        for d in ("projects", "apps", "trash"):
            (data / d).mkdir(parents=True, exist_ok=True)
        readme = data / "README.txt"
        if not readme.exists():
            readme.write_text("Anki Card Studio data folder.\nManaged by acs.py - see the docstring at the top of acs.py for the layout.\n"
                              "Put Studio .html versions into apps/ to open them at http://127.0.0.1:%d/\n" % port)
        self.lock = threading.Lock()

    @staticmethod
    def rev_of(f: Path) -> dict:
        try:
            j = json.loads(f.read_bytes())
            return {"rev": int(j.get("rev") or 0), "savedAt": j.get("savedAt"), "savedBy": j.get("savedBy")}
        except Exception:  # noqa: BLE001
            return {"rev": 0, "savedAt": None, "savedBy": None}

    def deleted(self) -> set:
        f = self.data / "trash" / "deleted.json"
        try:
            return set(json.loads(f.read_bytes()))
        except Exception:  # noqa: BLE001
            return set()

    def mark_deleted(self, pid: str) -> None:
        ids = self.deleted() | {pid}
        atomic_write(self.data / "trash" / "deleted.json", json.dumps(sorted(ids)).encode())
        f = self.data / "projects.json"
        if f.exists():
            cur = [e for e in json.loads(f.read_bytes()) or [] if e.get("id") != pid]
            atomic_write(f, json.dumps(cur, ensure_ascii=False).encode())

    def project_dir(self, pid: str) -> Path:
        if not ID_RE.match(pid):
            raise PermissionError("bad project id")
        return self.data / "projects" / pid

    def html_files(self):
        seen, out = set(), []
        for d in (self.data / "apps", self.script_dir):
            for f in sorted(d.glob("*.html"), key=lambda p: p.stat().st_mtime, reverse=True):
                if f.name not in seen:
                    seen.add(f.name)
                    out.append(f)
        return out


def make_handler(app: App):
    allowed_origins = {f"http://127.0.0.1:{app.port}", f"http://localhost:{app.port}"} | ({"null", "file://"} if app.allow_file else set())

    class H(BaseHTTPRequestHandler):
        server_version = "ACS/" + VERSION

        def log_message(self, fmt, *args):
            if os.environ.get("ACS_DEBUG"):
                super().log_message(fmt, *args)

        # ---------------------------------------------------------------- helpers
        def origin_ok(self) -> bool:
            o = self.headers.get("Origin")
            return o is None or o in allowed_origins

        def cors(self):
            o = self.headers.get("Origin")
            if o in allowed_origins:
                self.send_header("Access-Control-Allow-Origin", o)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Private-Network", "true")

        def send(self, code, body=b"", ctype="application/json", extra=None):
            if isinstance(body, (dict, list)):
                body = json.dumps(body, ensure_ascii=False).encode()
            elif isinstance(body, str):
                body = body.encode()
            self.send_response(code)
            self.cors()
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def err(self, code, msg):
            self.send(code, {"ok": False, "error": msg})

        def body(self) -> bytes:
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                raise ValueError("body too large")
            return self.rfile.read(n) if n else b""

        def parts(self):
            u = urllib.parse.urlparse(self.path)
            return [urllib.parse.unquote(p) for p in u.path.split("/") if p], urllib.parse.parse_qs(u.query)

        # ---------------------------------------------------------------- verbs
        def do_OPTIONS(self):
            self.send_response(204)
            self.cors()
            self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-ACS-Base-Rev")
            self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            self.route("GET")

        def do_PUT(self):
            self.route("PUT")

        def do_POST(self):
            self.route("POST")

        def do_DELETE(self):
            self.route("DELETE")

        def route(self, method):
            try:
                p, q = self.parts()
                if not p or p[0] != "api":
                    return self.static(p) if method == "GET" else self.err(405, "method")
                if not self.origin_ok():
                    return self.err(403, "origin not allowed")
                return self.api(method, p[1:], q)
            except PermissionError as e:
                self.err(403, str(e))
            except FileNotFoundError:
                self.err(404, "not found")
            except Exception as e:  # noqa: BLE001
                self.err(500, f"{type(e).__name__}: {e}")

        # ---------------------------------------------------------------- static
        def static(self, p):
            files = app.html_files()
            if not p:
                if len(files) == 1:
                    return self.send(302, b"", extra={"Location": f"/apps/{urllib.parse.quote(files[0].name)}"})
                rows = "".join(f'<li><a href="/apps/{urllib.parse.quote(f.name)}">{html.escape(f.name)}</a> '
                               f'<small>{datetime.datetime.fromtimestamp(f.stat().st_mtime):%Y-%m-%d %H:%M}</small></li>' for f in files)
                page = (f"<!doctype html><meta charset=utf-8><title>ACS</title><body style='font:15px system-ui;max-width:640px;margin:40px auto'>"
                        f"<h2>Anki Card Studio</h2><p>Data folder: <code>{html.escape(str(app.data))}</code></p>"
                        f"<ul>{rows or '<li>No .html found - put anki_card_studio.html into the apps/ folder.</li>'}</ul></body>")
                return self.send(200, page, "text/html; charset=utf-8")
            if p[0] == "apps" and len(p) == 2:
                f = next((x for x in files if x.name == p[1]), None)
                if not f:
                    raise FileNotFoundError
                return self.send(200, f.read_bytes(), "text/html; charset=utf-8")
            raise FileNotFoundError

        # ---------------------------------------------------------------- api
        def api(self, m, p, q):
            d = app.data
            if p == ["ping"]:
                return self.send(200, {"ok": True, "version": VERSION, "dataDir": str(d), "apps": [f.name for f in app.html_files()]})
            if p == ["settings"]:
                f = d / "settings.json"
                if m == "GET":
                    return self.send(200, f.read_bytes() if f.exists() else b"null")
                if m == "PUT":
                    data = self.body(); json.loads(data); atomic_write(f, data); return self.send(200, {"ok": True})
            if p == ["projects"]:
                f = d / "projects.json"
                if m == "GET":
                    return self.send(200, f.read_bytes() if f.exists() else b"null")
                if m == "PUT":
                    # several windows/versions write this list: merge by id (newest entry wins), never resurrect deleted ones
                    incoming = json.loads(self.body()) or []
                    with app.lock:
                        cur = json.loads(f.read_bytes()) if f.exists() else []
                        gone = app.deleted()
                        by = {e["id"]: e for e in (cur or []) if isinstance(e, dict) and e.get("id")}
                        for e in incoming:
                            if not isinstance(e, dict) or not e.get("id"):
                                continue
                            old = by.get(e["id"])
                            if not old or (e.get("updated") or 0) >= (old.get("updated") or 0):
                                by[e["id"]] = e
                        merged = [e for i, e in by.items() if i not in gone]
                        atomic_write(f, json.dumps(merged, ensure_ascii=False).encode())
                    return self.send(200, merged)
            if p == ["open"] and m == "POST":
                sub = (q.get("path") or [""])[0]
                target = (d / sub).resolve()
                if not str(target).startswith(str(d.resolve())):
                    raise PermissionError("outside data folder")
                open_in_file_manager(target if target.exists() else d)
                return self.send(200, {"ok": True, "path": str(target)})
            if p == ["fetch"] and m == "GET":
                url = (q.get("url") or [""])[0]
                r = fetch_readable(url)
                if r.get("binary"):
                    return self.send(200, r["bytes"], "application/pdf", {"X-ACS-Title": urllib.parse.quote(r["title"]), "X-ACS-Url": urllib.parse.quote(r["url"]), "Access-Control-Expose-Headers": "X-ACS-Title, X-ACS-Url"})
                return self.send(200, r)
            if len(p) >= 2 and p[0] == "project":
                pd = app.project_dir(p[1])
                if len(p) == 3 and p[2] == "rev" and m == "GET":
                    f = pd / "project.json"
                    if not f.exists():
                        raise FileNotFoundError
                    return self.send(200, app.rev_of(f))
                if len(p) == 2:
                    f = pd / "project.json"
                    if m == "GET":
                        if not f.exists():
                            raise FileNotFoundError
                        return self.send(200, f.read_bytes())
                    if m == "PUT":
                        data = self.body(); json.loads(data)
                        base = self.headers.get("X-ACS-Base-Rev")
                        with app.lock:
                            # optimistic locking: a save must be based on the revision that is on disk now
                            if base is not None and base != "" and f.exists():
                                cur = app.rev_of(f)
                                if str(cur["rev"]) != base:
                                    return self.send(409, {"ok": False, "error": "conflict", **cur})
                            backup(f); atomic_write(f, data)
                        return self.send(200, {"ok": True, **app.rev_of(f)})
                    if m == "DELETE":
                        with app.lock:
                            if pd.exists():
                                dst = d / "trash" / f"{p[1]}-{datetime.datetime.now():%Y%m%d-%H%M%S}"
                                shutil.move(str(pd), str(dst))
                            app.mark_deleted(p[1])
                        return self.send(200, {"ok": True})
                if len(p) == 4 and p[2] in ("media", "sources"):
                    name = p[3]
                    if not NAME_RE.match(name) or ".." in name:
                        raise PermissionError("bad file name")
                    f = pd / p[2] / name
                    if m == "GET":
                        if not f.exists():
                            raise FileNotFoundError
                        return self.send(200, f.read_bytes(), mimetypes.guess_type(name)[0] or "application/octet-stream")
                    if m == "PUT":
                        atomic_write(f, self.body()); return self.send(200, {"ok": True})
                    if m == "DELETE":
                        f.unlink(missing_ok=True); return self.send(200, {"ok": True})
                if len(p) == 3 and p[2] in ("media", "sources") and m == "GET":
                    folder = pd / p[2]
                    return self.send(200, sorted(x.name for x in folder.iterdir()) if folder.exists() else [])
            self.err(404, "unknown endpoint")

    return H


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=int(os.environ.get("ACS_PORT", 8765)))
    ap.add_argument("--data", default=os.environ.get("ACS_DATA"))
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--allow-file-pages", action="store_true", help="also answer .html files opened from disk (file://)")
    a = ap.parse_args()
    data = Path(a.data).expanduser() if a.data else default_data_dir()
    app = App(data, a.port, Path(__file__).resolve().parent, a.allow_file_pages)
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(app))
    url = f"http://127.0.0.1:{a.port}/"
    print(f"Anki Card Studio server\n  data folder: {data}\n  open:        {url}\n  (Ctrl+C to stop)")
    if not a.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
