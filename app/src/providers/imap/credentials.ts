// Credentials are ONLY obtained through this interface. The adapter never stores, logs or
// echoes them. Real implementations (OS keychain / encrypted file) come later.

export interface ImapCredentials {
  /** Full login, e.g. the account email address. */
  user: string;
  /** Password or app-specific password. */
  password?: string;
  /** OAuth2 access token for XOAUTH2. */
  accessToken?: string;
}

export interface CredentialsProvider {
  get(accountId: string): Promise<ImapCredentials>;
}

/** For tests and local scripts only. Do not use for real accounts. */
export class StaticCredentialsProvider implements CredentialsProvider {
  constructor(private readonly byAccount: Record<string, ImapCredentials>) {}
  async get(accountId: string): Promise<ImapCredentials> {
    const c = this.byAccount[accountId];
    if (!c) throw new Error(`no credentials for account ${accountId}`);
    return c;
  }
}
