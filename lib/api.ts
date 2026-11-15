/**
 * The Studio's storage API, the same routes as local/acs.py so the page works unchanged against either:
 *
 *   GET  /api/ping                               -> {ok, version, hosted, user}
 *   GET|PUT /api/settings
 *   GET|PUT /api/projects                        (PUT merges by id, returns the merged list)
 *   GET|PUT|DELETE /api/project/<id>             (PUT honours X-ACS-Base-Rev -> 409 on conflict)
 *   GET  /api/project/<id>/rev
 *   GET  /api/project/<id>/(media|sources)       -> [names]
 *   GET|PUT|DELETE /api/project/<id>/(media|sources)/<name>
 *        large files travel in pieces: PUT ?chunk=i&chunks=n; GET answers {chunked, chunks, size, type}
 *        (header X-ACS-Chunked: 1) and each piece is fetched with ?chunk=i
 *   GET  /api/fetch?url=...                      readable text of a public web page (or a PDF up to 4 MB)
 *
 * Kept free of Next.js so the tests can call it directly.
 */
import { gunzipSync } from "node:zlib";
import * as st from "./store";
import { HttpError } from "./store";
import { fetchReadable } from "./fetch-readable";
import type { User } from "./user";
import { envLogins, adminLogins, forgetAllowedCache } from "./allow";

export const API_VERSION = "2";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });

const bytes = (b: Buffer, type: string, headers: Record<string, string> = {}) =>
  new Response(new Uint8Array(b), { status: 200, headers: { "Content-Type": type, "Cache-Control": "private, no-store", ...headers } });

/** cookie-authenticated writes must come from this site (defence in depth on top of SameSite cookies) */
function sameOrigin(req: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  const origin = req.headers.get("origin");
  if (!origin) return req.headers.get("sec-fetch-site") !== "cross-site";
  try {
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || new URL(req.url).host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function handleApi(req: Request, parts: string[], user: User | null): Promise<Response> {
  try {
    if (!user) return json(401, { ok: false, error: "sign in required", signIn: "/api/auth/signin?callbackUrl=/" });
    if (!sameOrigin(req)) return json(403, { ok: false, error: "cross-site request refused" });
    const m = req.method;
    const url = new URL(req.url);
    const p = parts.map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
    const o = user.owner;

    if (p.length === 1 && p[0] === "ping")
      return json(200, { ok: true, version: API_VERSION, hosted: true, dataDir: "", user: { login: user.login, name: user.name ?? null, image: user.image ?? null, admin: !!user.admin } });

    // who may sign in: admins only (ACS_ADMIN_GITHUB, default pclk)
    if (p[0] === "people") {
      if (!user.admin) return json(403, { ok: false, error: "only the admin can manage who signs in" });
      const list = async () => {
        const added = await st.listAllowed(), env = envLogins(), admins = adminLogins();
        return { env, admins, added: added.filter((r) => !env.includes(r.login) && !admins.includes(r.login)) };
      };
      if (p.length === 1 && m === "GET") return json(200, await list());
      if (p.length === 1 && m === "POST") {
        const { login } = JSON.parse(await req.text() || "{}");
        await st.addAllowed(String(login || "").trim().replace(/^@/, ""), user.login);
        forgetAllowedCache();
        return json(200, await list());
      }
      if (p.length === 2 && m === "DELETE") {
        const login = p[1].toLowerCase();
        if (adminLogins().includes(login)) return json(400, { ok: false, error: "the admin can't be removed" });
        if (envLogins().includes(login)) return json(400, { ok: false, error: "this username is set in ACS_ALLOWED_GITHUB on Vercel - remove it there" });
        await st.removeAllowed(login);
        forgetAllowedCache();
        return json(200, await list());
      }
    }

    if (p.length === 1 && p[0] === "settings") {
      if (m === "GET") return json(200, await st.getSettings(o));
      if (m === "PUT") { await st.putSettings(o, await req.text()); return json(200, { ok: true }); }
    }

    if (p.length === 1 && p[0] === "projects") {
      if (m === "GET") return json(200, (await st.getIndex(o)) ?? null);
      if (m === "PUT") return json(200, await st.putIndex(o, JSON.parse(await req.text() || "[]")));
    }

    if (p.length === 1 && p[0] === "fetch" && m === "GET") {
      const r = await fetchReadable(url.searchParams.get("url") || "");
      if (r.kind === "pdf")
        return bytes(r.bytes, "application/pdf", {
          "X-ACS-Title": encodeURIComponent(r.title), "X-ACS-Url": encodeURIComponent(r.url),
          "Access-Control-Expose-Headers": "X-ACS-Title, X-ACS-Url",
        });
      return json(200, r);
    }

    if (p.length >= 2 && p[0] === "project") {
      const id = st.checkId(p[1]);
      if (p.length === 3 && p[2] === "rev" && m === "GET") {
        const r = await st.getRev(o, id);
        return r ? json(200, r) : json(404, { ok: false, error: "not found" });
      }
      if (p.length === 2) {
        if (m === "GET") {
          const d = await st.getProject(o, id);
          return d == null ? json(404, { ok: false, error: "not found" }) : json(200, d);
        }
        if (m === "PUT") {
          // the Studio gzips big projects (X-ACS-Encoding: gzip); at most 64 MB unpacked
          const raw = Buffer.from(await req.arrayBuffer());
          const text = req.headers.get("x-acs-encoding") === "gzip" ? gunzipSync(raw, { maxOutputLength: 64 * 1024 * 1024 }).toString("utf8") : raw.toString("utf8");
          return json(200, await st.putProject(o, id, text, req.headers.get("x-acs-base-rev"), req.headers.get("x-acs-restore") === "1"));
        }
        if (m === "DELETE") { await st.deleteProject(o, id); return json(200, { ok: true }); }
      }
      if (p.length === 3 && st.KINDS.has(p[2]) && m === "GET") return json(200, await st.listFiles(o, id, p[2]));
      if (p.length === 4 && st.KINDS.has(p[2])) {
        const kind = p[2], name = st.checkName(p[3]);
        if (m === "GET") {
          const f = await st.fileMeta(o, id, kind, name);
          if (!f) return json(404, { ok: false, error: "not found" });
          const ci = url.searchParams.get("chunk");
          // the browser keeps images; asking again costs a tiny "not modified" (304) when nothing changed
          const etag = ci == null ? f.etag : f.etag.replace(/"$/, `-${ci}"`);
          if (req.headers.get("if-none-match") === etag)
            return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, no-cache" } });
          if (f.chunks > 1 && ci == null)
            return json(200, { chunked: true, chunks: f.chunks, size: f.size, type: f.mime }, { "X-ACS-Chunked": "1" });
          const b = await st.readChunk(o, id, kind, name, ci == null ? 0 : Number(ci));
          return b ? bytes(b, f.mime, { ETag: etag, "Cache-Control": "private, no-cache" }) : json(404, { ok: false, error: "not found" });
        }
        if (m === "PUT") {
          const idx = Number(url.searchParams.get("chunk") ?? 0), total = Number(url.searchParams.get("chunks") ?? 1);
          const type = (req.headers.get("content-type") || "application/octet-stream").split(";")[0];
          await st.writeChunk(o, id, kind, name, type, idx, total, Buffer.from(await req.arrayBuffer()));
          return json(200, { ok: true });
        }
        if (m === "DELETE") { await st.deleteFile(o, id, kind, name); return json(200, { ok: true }); }
      }
    }
    return json(404, { ok: false, error: "unknown endpoint" });
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, e.body ?? { ok: false, error: e.message });
    if (e instanceof SyntaxError) return json(400, { ok: false, error: "invalid JSON" });
    const code = String((e as { code?: string })?.code || "");
    if (code.startsWith("Z_") || code === "ERR_BUFFER_TOO_LARGE") return json(400, { ok: false, error: "bad or too large compressed body" });
    console.error(e);
    return json(500, { ok: false, error: "server error" });
  }
}
