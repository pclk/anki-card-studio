import { handleApi } from "@/lib/api";
import { currentUser } from "@/lib/user";
import { deviceUser } from "@/lib/bridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ path: string[] }> };

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  try {
    // the Mac bridge sends a device token instead of the sign-in cookie (lib/bridge.ts); a bad token is just signed out
    const bearer = req.headers.get("authorization");
    return await handleApi(req, path, bearer ? await deviceUser(bearer) : await currentUser());
  }
  catch { return Response.json({ok: false, error: "account verification temporarily unavailable"}, {status: 503, headers: {"Cache-Control": "no-store"}}); }
}

export { handle as GET, handle as PUT, handle as POST, handle as PATCH, handle as DELETE };
