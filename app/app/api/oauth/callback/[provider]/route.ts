import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "../../../../../src/runtime/runtime";

export const dynamic = "force-dynamic";

/** Loopback redirect target for Gmail / Outlook sign-in. Validates state, exchanges the code (PKCE). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  if (provider !== "gmail" && provider !== "outlook") return new NextResponse("Not found", { status: 404 });
  const q = req.nextUrl.searchParams;
  const rt = await getRuntime();
  const outcome = await rt.oauth.complete(provider, { state: q.get("state"), code: q.get("code"), error: q.get("error") });
  revalidatePath("/", "layout");
  const dest = new URL("/settings", req.nextUrl.origin);
  dest.searchParams.set("notice", outcome.text);
  dest.searchParams.set("kind", outcome.ok ? "ok" : "error");
  return NextResponse.redirect(dest);
}
