// Demo mailbox: fictional senders on example domains. No real data.
import { DemoScript } from "./demoJev";

type Answers = Record<string, [boolean, number]>;
import { FakeImapTransport } from "../providers/imap/testing/fakeTransport";

interface Seed { from: string; subject: string; body: string; jev?: DemoScript }

const J = { junk: (c = 96) => ({ sys_auth: [false, 96], sys_junk: [true, c] }) as DemoScript };
const cat = (id: string, c = 88): Answers => ({ [id]: [true, c] });

export const DEMO_MESSAGES: Seed[] = [
  // Auth (deterministic rules)
  { from: "Accounts <no-reply@accounts.example>", subject: "Your verification code", body: "Your code is 482913. It expires soon." },
  { from: "Bank Security <security@bank.example>", subject: "Login alert on your account", body: "New sign-in from Berlin. If this was not you, reset your password." },
  { from: "Shop <deals@shop.example>", subject: "Your one-time password", body: "Use 551029 to sign in to Shop." },
  { from: "Code Host <noreply@codehost.example>", subject: "Password reset requested", body: "Someone asked to reset your password." },
  { from: "CloudCo <help@cloudco.example>", subject: "Confirm your email", body: "Welcome to CloudCo." },
  // Auth recognised by jev.ai
  { from: "Service <help@service.example>", subject: "Finish signing up", body: "Tap the button to finish.", jev: { sys_auth: [true, 92] } },
  // Needs review: low Auth confidence, security-shaped, provider timeout
  { from: "Service <help@service.example>", subject: "Complete your setup", body: "One more step to go.", jev: { sys_auth: [true, 65] } },
  { from: "Team <team@profile.example>", subject: "Note about your profile", body: "Enter 739201 to continue.", jev: { sys_auth: [false, 95], sys_junk: [true, 99] } },
  { from: "Someone <unknown@weird.example>", subject: "Quick question", body: "Do you have a minute?", jev: "timeout" },
  // Promotions and travel
  { from: "Shop <deals@shop.example>", subject: "Summer sale", body: "Shoes 30% off this weekend.", jev: { ...cat("cat_020"), sys_junk: [false, 90] } },
  { from: "Shop <deals@shop.example>", subject: "Autumn sale", body: "Coats 20% off.", jev: { ...cat("cat_020"), sys_junk: [false, 90] } },
  { from: "Flights <offers@travel.example>", subject: "Weekend flights from 39 pounds", body: "Book now.", jev: { ...cat("cat_011", 82), ...cat("cat_020", 70) } },
  // Newsletters
  { from: "Letters <news@letters.example>", subject: "Weekly digest", body: "Stories this week.", jev: cat("cat_019") },
  { from: "Digest <digest@newsletter.example>", subject: "The Friday read", body: "Five links worth your time.", jev: cat("cat_019") },
  // Work
  { from: "Boss <boss@corp.example>", subject: "Project plan review", body: "Can you review the plan by Thursday?", jev: cat("cat_002", 91) },
  { from: "Colleague <colleague@corp.example>", subject: "Lunch tomorrow?", body: "Fancy the new place?", jev: cat("cat_002", 80) },
  // Personal and family
  { from: "Mum <mum@family.example>", subject: "Sunday dinner", body: "Are you coming round at six?", jev: cat("cat_001", 94) },
  { from: "Friend <friend@mail.example>", subject: "Weekend plans", body: "See you Saturday.", jev: cat("cat_001", 85) },
  // Receipts, shipping, finance
  { from: "Store <receipts@store.example>", subject: "Your order receipt", body: "Order number: A-1. Total: 24.00", jev: cat("cat_007", 93) },
  { from: "Parcels <tracking@parcels.example>", subject: "Your parcel is on the way", body: "Track your delivery.", jev: cat("cat_010", 90) },
  { from: "Bank <statements@bank.example>", subject: "Your monthly statement", body: "Your statement is ready to view.", jev: cat("cat_003", 92) },
  // Junk (jev.ai high confidence, nothing protects them)
  { from: "Lottery <spam@lottery.example>", subject: "You have won a prize", body: "Claim your reward now.", jev: J.junk(96) },
  { from: "Prince <prince@scam.example>", subject: "Urgent business proposal", body: "Kindly reply with your details.", jev: J.junk(95) },
];

export function seedMailbox(t: FakeImapTransport): void {
  for (const m of DEMO_MESSAGES) t.deliver("INBOX", { from: m.from, subject: m.subject, body: m.body });
}

export function demoScripts(): Record<string, DemoScript> {
  const out: Record<string, DemoScript> = {};
  for (const m of DEMO_MESSAGES) if (m.jev) out[m.subject] = m.jev;
  return out;
}
