import { Message, UserContext } from "../src/gate/types";
import { FakeJev, FakeScript } from "../src/jev/fake";

export const msg = (id: string, from: string, subject: string, body: string): Message => ({ id, from, subject, body });

export const PROMO = msg("promo", "Deals <deals@shop.example>", "Big summer sale, 30% off", "Save on shoes this weekend only.");
export const NEUTRAL = msg("neutral", "help@service.example", "Finish signing up", "Tap the button to finish.");

export function ctx(over: Partial<UserContext> = {}): UserContext {
  return {
    allowlist: [],
    markedJunk: [],
    hasRepliedTo: () => false,
    hasAuthHistory: () => false,
    ...over,
  };
}

type A = Record<string, [boolean, number]>;
export const answers = (a: A): FakeScript => ({ kind: "answers", answers: a });
export const fake = (...s: FakeScript[]) => new FakeJev(s);
