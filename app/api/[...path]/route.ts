import { handleApi } from "@/lib/api";
import { currentUser } from "@/lib/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ path: string[] }> };

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  try { return await handleApi(req, path, await currentUser()); }
  catch { return Response.json({ok: false, error: "account verification temporarily unavailable"}, {status: 503, headers: {"Cache-Control": "no-store"}}); }
}

export { handle as GET, handle as PUT, handle as POST, handle as PATCH, handle as DELETE };
