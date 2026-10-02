"use server";
// Server actions. They only parse the form, call the action layer in src/ui/actions.ts, and
// redirect back with a notice. No gate or move logic lives here.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import * as ui from "../src/ui/actions";
import { getAppState } from "../src/ui/state";

const str = (f: FormData, k: string) => String(f.get(k) ?? "");

/** Only same-site relative paths are allowed as a return target. */
function safeReturn(f: FormData, fallback = "/"): string {
  const r = str(f, "returnTo");
  return r.startsWith("/") && !r.startsWith("//") && !r.includes("\\") ? r : fallback;
}

function back(f: FormData, n: ui.Notice, fallback?: string): never {
  const path = safeReturn(f, fallback);
  const [base, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  params.delete("notice"); params.delete("kind");
  params.set("notice", n.text); params.set("kind", n.kind);
  revalidatePath("/", "layout");
  redirect(`${base}?${params.toString()}`);
}

/** Bulk or single move. Auth mail is blocked in the action layer, whatever the form says. */
export async function moveAction(f: FormData): Promise<void> {
  const st = await getAppState();
  const tokens = f.getAll("token").map(String);
  const t = str(f, "target");
  if (!tokens.length) back(f, { kind: "info", text: "Select at least one message first." });
  let target: ui.MoveTarget;
  if (t === "junk" || t === "needs_review" || t === "archive") target = t;
  else if (t.startsWith("category:")) target = { category: t.slice("category:".length) };
  else back(f, { kind: "error", text: "Choose where to move the message." });
  const r = await ui.moveMessages(st, tokens, target);
  back(f, r);
}

export async function junkAction(f: FormData): Promise<void> {
  const st = await getAppState();
  const action = str(f, "action");
  if (action !== "not_junk" && action !== "keep" && action !== "archive") back(f, { kind: "error", text: "Unknown action." });
  const r = await ui.junkQueueAction(st, str(f, "token"), action, { allowSender: f.get("allowSender") === "on" });
  back(f, r, "/junk");
}

export async function fileAction(f: FormData): Promise<void> {
  const st = await getAppState();
  const t = str(f, "target");
  const target = t === "auth" ? "auth" : t.startsWith("category:") ? { category: t.slice(9) } : null;
  if (!target) back(f, { kind: "error", text: "Choose a category or Auth." }, "/needs-review");
  back(f, await ui.fileFromReview(st, str(f, "token"), target), "/needs-review");
}

export async function senderAction(f: FormData): Promise<void> {
  const st = await getAppState();
  const key = str(f, "sender");
  const fallback = `/senders/${encodeURIComponent(key)}`;
  switch (str(f, "action")) {
    case "allow": back(f, ui.senderAllow(st, key), fallback);
    case "unallow": back(f, ui.senderUnallow(st, key), fallback);
    case "mute": back(f, ui.senderMute(st, key, true), fallback);
    case "unmute": back(f, ui.senderMute(st, key, false), fallback);
    case "unmark": back(f, ui.senderUnmarkJunk(st, key), fallback);
    case "mark_junk": back(f, await ui.senderMarkJunk(st, key), fallback);
    default: back(f, { kind: "error", text: "Unknown action." }, fallback);
  }
}

export async function categoryAction(f: FormData): Promise<void> {
  const st = await getAppState();
  const id = str(f, "id");
  switch (str(f, "action")) {
    case "add": back(f, ui.addCategory(st, str(f, "name")), "/categories");
    case "enable": back(f, ui.setCategoryEnabled(st, id, true), "/categories");
    case "disable": back(f, ui.setCategoryEnabled(st, id, false), "/categories");
    case "delete": back(f, await ui.deleteCategory(st, id), "/categories");
    default: back(f, { kind: "error", text: "Unknown action." }, "/categories");
  }
}

/** Stub: reads nothing from the form (no password is touched) and saves nothing. */
export async function addAccountAction(f: FormData): Promise<void> {
  back(f, ui.addAccountStub(str(f, "provider")), "/settings");
}
