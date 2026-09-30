// jev.ai contract (03-jev-contract.md). One call per email, many yes/no questions.

export interface JevQuestion {
  question_id: string; // "sys_auth" | "sys_junk" | "cat_NNN"
  text: string;
}

export interface JevRequest {
  message_id: string;
  fields: {
    from: string;
    subject: string; // redacted
    snippet: string; // redacted, <= 500 chars
    authentication_results?: string;
  };
  questions: JevQuestion[];
}

export interface JevAnswer {
  question_id: string;
  answer: boolean;
  confidence: number; // integer 0-100
}

export interface JevResponse {
  message_id: string;
  status: "success" | "error" | "timeout" | "partial";
  answers: JevAnswer[];
}

/** Swap for the real jev.ai HTTP client later. */
export interface JevClient {
  classify(request: JevRequest, opts: { timeoutMs: number }): Promise<JevResponse>;
}

export class JevTimeoutError extends Error {
  constructor(msg = "jev.ai timeout") {
    super(msg);
    this.name = "JevTimeoutError";
  }
}
