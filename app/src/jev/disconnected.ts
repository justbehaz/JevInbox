import { JevClient, JevRequest, JevResponse } from "./types";

export class JevNotConnectedError extends Error {
  constructor() {
    super("jev.ai is not connected");
    this.name = "JevNotConnectedError";
  }
}

/** Stand-in used until the real jev.ai client exists. Every call fails, so the gate's own fail-safe
 *  applies: deterministic Auth rules still work, everything else goes to Needs review, nothing is junked. */
export class DisconnectedJev implements JevClient {
  calls = 0;
  async classify(_req: JevRequest): Promise<JevResponse> {
    this.calls++;
    throw new JevNotConnectedError();
  }
}

export const JEV_DISCONNECTED_BANNER = "jev.ai not connected — deterministic rules only";
