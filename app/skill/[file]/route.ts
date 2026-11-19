/**
 * The anki skill, for the AI to download by itself (prompts with "the AI downloads the skill" point here):
 *   /skill/anki.zip                  the whole skill (anki/SKILL.md, anki/scripts/*), the same layout as the Studio's download
 *   /skill/SKILL.md, /skill/<script>  single files, for tools that can't unzip
 * Public on purpose: an AI's sandbox has no sign-in. It serves only these files, which hold no user data.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { zip } from "@/lib/zip";

export const runtime = "nodejs";

const DIR = path.join(process.cwd(), "skill", "anki");
const FILES: Record<string, { rel: string; type: string }> = {
  "SKILL.md": { rel: "SKILL.md", type: "text/markdown; charset=utf-8" },
  "anki_helper.py": { rel: "scripts/anki_helper.py", type: "text/x-python; charset=utf-8" },
  "extract.py": { rel: "scripts/extract.py", type: "text/x-python; charset=utf-8" },
  "make_prompts.py": { rel: "scripts/make_prompts.py", type: "text/x-python; charset=utf-8" },
};
const HEADERS = { "Cache-Control": "public, max-age=300", "X-Robots-Tag": "noindex" };

export async function GET(_req: Request, ctx: { params: Promise<{ file: string }> }): Promise<Response> {
  const { file } = await ctx.params;
  if (file === "anki.zip") {
    const files = await Promise.all(Object.values(FILES).map(async (f) => ({ name: "anki/" + f.rel, data: await readFile(path.join(DIR, f.rel)) })));
    return new Response(new Uint8Array(zip(files)), {
      headers: { ...HEADERS, "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="anki-skill.zip"' },
    });
  }
  const f = FILES[file];
  if (!f) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(await readFile(path.join(DIR, f.rel)), { headers: { ...HEADERS, "Content-Type": f.type } });
}
