import { handleApi } from "@/lib/api";
import { currentUser } from "@/lib/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ path: string[] }> };

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  return handleApi(req, path, await currentUser());
}

export { handle as GET, handle as PUT, handle as POST, handle as DELETE };
