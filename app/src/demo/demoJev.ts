// Scripted jev.ai stand-in for the demo mailbox. Not a real classifier.
import { JevClient, JevRequest, JevResponse, JevTimeoutError } from "../jev/types";

export type DemoScript = Record<string, [boolean, number]> | "timeout";

export class DemoJev implements JevClient {
  constructor(private readonly bySubject: Record<string, DemoScript>) {}
  async classify(req: JevRequest): Promise<JevResponse> {
    const s = this.bySubject[req.fields.subject] ?? {};
    if (s === "timeout") throw new JevTimeoutError();
    return {
      message_id: req.message_id,
      status: "success",
      answers: req.questions.map((q) => {
        const [answer, confidence] = s[q.question_id] ?? [false, 99];
        return { question_id: q.question_id, answer, confidence };
      }),
    };
  }
}
