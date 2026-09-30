import { JevClient, JevRequest, JevResponse, JevTimeoutError } from "./types";

export type FakeScript =
  | { kind: "answers"; answers: Record<string, [boolean, number]>; status?: JevResponse["status"] }
  | { kind: "timeout" }
  | { kind: "error" } // rejects with a generic Error
  | { kind: "raw"; response: unknown }; // malformed payloads

/**
 * Fake jev.ai. Scripts are consumed one per call (last one repeats).
 * Unlisted questions default to "no, confidence 99" so tests only state what matters.
 */
export class FakeJev implements JevClient {
  calls: JevRequest[] = [];
  private i = 0;
  constructor(private scripts: FakeScript[]) {}

  async classify(request: JevRequest): Promise<JevResponse> {
    this.calls.push(request);
    const s = this.scripts[Math.min(this.i++, this.scripts.length - 1)];
    if (s.kind === "timeout") throw new JevTimeoutError();
    if (s.kind === "error") throw new Error("jev.ai 500");
    if (s.kind === "raw") return s.response as JevResponse;
    return {
      message_id: request.message_id,
      status: s.status ?? "success",
      answers: request.questions.map((q) => {
        const [answer, confidence] = s.answers[q.question_id] ?? [false, 99];
        return { question_id: q.question_id, answer, confidence };
      }),
    };
  }
}
