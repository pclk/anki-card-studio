/**
 * The Studio itself: the single-file app in studio/studio.html, served to signed-in users only.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { currentUser } from "@/lib/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let cached: string | null = null;

async function studioHtml(): Promise<string> {
  if (cached && process.env.NODE_ENV === "production") return cached;
  const html = await readFile(path.join(process.cwd(), "studio", "studio.html"), "utf8");
  // installable app: manifest + theme colour (the service worker is registered by the page itself)
  cached = html.replace(
    "</head>",
    `<link rel="manifest" href="/manifest.webmanifest">\n<meta name="theme-color" content="#14171c">\n` +
      `<link rel="apple-touch-icon" href="/icons/icon-180.png">\n<meta name="apple-mobile-web-app-capable" content="yes">\n` +
      `<meta name="mobile-web-app-capable" content="yes">\n</head>`,
  );
  return cached;
}

export async function GET(req: Request): Promise<Response> {
  let user;
  try { user = await currentUser(); }
  catch { return new Response("Account verification temporarily unavailable. Please retry.", { status: 503, headers: {"Cache-Control": "no-store"} }); }
  if (!user) {
    const u = new URL(req.url);
    return Response.redirect(new URL(`/api/auth/signin?callbackUrl=${encodeURIComponent(u.pathname + u.search)}`, u), 302);
  }
  return new Response(await studioHtml(), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-cache",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
    },
  });
}
