/**
 * "Add a web page" for sources: fetch a public page and reduce it to readable text (headings, paragraphs, lists,
 * code, tables), like local/acs.py does.
 *
 * Safety: the server must never be usable to reach private networks (cloud metadata endpoints, localhost, the VPC).
 * Only http(s) on ports 80/443; every address the hostname resolves to must be public unicast, checked again at
 * connect time (so DNS rebinding can't swap the address after the check), and every redirect is re-checked.
 */
import { lookup as dnsLookup } from "node:dns";
import { Agent, fetch as ufetch } from "undici";
import ipaddr from "ipaddr.js";
import { Parser } from "htmlparser2";
import { HttpError } from "./store";

const MAX_HTML = 10 * 1024 * 1024;
export const MAX_PDF = 4 * 1024 * 1024; // a Vercel function response can't exceed 4.5 MB

export function isPublicAddress(addr: string): boolean {
  try {
    let ip = ipaddr.parse(addr);
    if (ip.kind() === "ipv6" && (ip as ipaddr.IPv6).isIPv4MappedAddress()) ip = (ip as ipaddr.IPv6).toIPv4Address();
    return ip.range() === "unicast";
  } catch {
    return false;
  }
}

const agent = new Agent({
  connect: {
    timeout: 10_000,
    lookup(hostname, options, cb) {
      dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
        if (err) return cb(err, [] as never, 0 as never);
        const list = (Array.isArray(addrs) ? addrs : [addrs]) as { address: string; family: number }[];
        const bad = list.find((a) => !isPublicAddress(a.address));
        if (!list.length || bad) return cb(new Error(`blocked address for ${hostname}`), [] as never, 0 as never);
        if ((options as { all?: boolean }).all) return cb(null, list as never, 0 as never);
        cb(null, list[0].address as never, list[0].family as never);
      });
    },
  },
});

function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, "not a valid URL");
  }
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, "only http(s) URLs");
  if (u.username || u.password) throw new HttpError(400, "URLs with credentials are not allowed");
  if (u.port && !["80", "443"].includes(u.port)) throw new HttpError(400, "only the standard web ports are allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (ipaddr.isValid(host) && !isPublicAddress(host)) throw new HttpError(400, "private addresses are not allowed");
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw new HttpError(400, "private hosts are not allowed");
  return u;
}

async function readCapped(body: ReadableStream<Uint8Array> | null, cap: number): Promise<Buffer | null> {
  if (!body) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  let n = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > cap) {
      await reader.cancel();
      return null;
    }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

export type Readable =
  | { kind: "pdf"; url: string; title: string; bytes: Buffer }
  | { kind: "text" | "web"; url: string; title: string; text: string };

export async function fetchReadable(raw: string): Promise<Readable> {
  let url = checkUrl(raw);
  for (let hop = 0; hop < 6; hop++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25_000);
    let r;
    try {
      r = await ufetch(url, {
        dispatcher: agent,
        redirect: "manual",
        signal: ctl.signal,
        headers: { "User-Agent": "Mozilla/5.0 (ACS source import)", Accept: "text/html,text/plain,application/pdf,*/*" },
      });
    } catch (e) {
      clearTimeout(timer);
      const msg = String((e as Error)?.cause ?? e);
      throw new HttpError(502, /blocked address/.test(msg) ? "that site resolves to a private address" : "could not fetch the page");
    }
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      clearTimeout(timer);
      const loc = r.headers.get("location");
      await r.body?.cancel();
      if (!loc) throw new HttpError(502, "redirect without a location");
      url = checkUrl(new URL(loc, url).toString());
      continue;
    }
    try {
      if (!r.ok) throw new HttpError(502, `the site answered HTTP ${r.status}`);
      const ctype = r.headers.get("content-type") || "";
      const final = url.toString();
      if (ctype.includes("pdf") || url.pathname.toLowerCase().endsWith(".pdf")) {
        const bytes = await readCapped(r.body as ReadableStream<Uint8Array>, MAX_PDF);
        if (!bytes) throw new HttpError(413, "PDF is larger than 4 MB - download it and add the file instead");
        return { kind: "pdf", url: final, title: decodeURIComponent(url.pathname.split("/").pop() || "") || "download.pdf", bytes };
      }
      const raw = await readCapped(r.body as ReadableStream<Uint8Array>, MAX_HTML);
      if (!raw) throw new HttpError(413, "page is too large");
      const charset = (/charset=([\w-]+)/i.exec(ctype) || [])[1] || "utf-8";
      let text: string;
      try {
        text = new TextDecoder(charset).decode(raw);
      } catch {
        text = new TextDecoder("utf-8").decode(raw);
      }
      if (!ctype.includes("html") && !/<html|<body|<p[ >]/i.test(text.slice(0, 5000))) return { kind: "text", url: final, title: final, text };
      return { kind: "web", url: final, ...htmlToText(text, final) };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new HttpError(502, "too many redirects");
}

const SKIP = new Set(["title", "script", "style", "noscript", "svg", "nav", "footer", "header", "aside", "form", "iframe", "button"]);
const BLOCK = new Set(["p", "div", "section", "article", "li", "tr", "br", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "table", "ul", "ol", "dd", "dt", "figcaption"]);

/** very small readability: keep headings, paragraphs, lists, code, tables; drop page chrome */
export function htmlToText(html: string, fallbackTitle = ""): { title: string; text: string } {
  const main = /<(main|article)\b[\s\S]*?<\/\1>/i.exec(html);
  const src = main && main[0].length > 2000 ? main[0] : html;
  let title = "";
  {
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    if (m) title = decodeEntities(m[1]).replace(/\s+/g, " ").trim();
  }
  const out: string[] = [];
  let skip = 0, pre = 0;
  const p = new Parser(
    {
      onopentag(tag, attrs) {
        if (SKIP.has(tag)) skip++;
        if (skip) return;
        if (tag === "pre") { pre++; out.push("\n```\n"); }
        else if (/^h[1-4]$/.test(tag)) out.push("\n\n" + "#".repeat(Number(tag[1])) + " ");
        else if (tag === "li") out.push("\n- ");
        else if (tag === "td" || tag === "th") out.push(" | ");
        else if (tag === "img") { if (attrs.alt) out.push(` [image: ${attrs.alt}] `); }
        else if (BLOCK.has(tag)) out.push("\n");
      },
      onclosetag(tag) {
        if (SKIP.has(tag)) { skip = Math.max(0, skip - 1); return; }
        if (skip) return;
        if (tag === "pre") { pre = Math.max(0, pre - 1); out.push("\n```\n"); }
        else if (BLOCK.has(tag)) out.push("\n");
      },
      ontext(data) {
        if (skip) return;
        out.push(pre ? data : data.replace(/\s+/g, " "));
      },
    },
    { decodeEntities: true, lowerCaseTags: true },
  );
  p.write(src);
  p.end();
  const text = out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title: (title || fallbackTitle).slice(0, 200), text };
}

function decodeEntities(s: string): string {
  let out = "";
  const p = new Parser({ ontext: (t) => { out += t; } }, { decodeEntities: true });
  p.write(s.replace(/</g, "&lt;"));
  p.end();
  return out;
}
