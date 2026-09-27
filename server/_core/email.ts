// Platform-mediated email (DESIGN §5.1.2 / §8.5).
//
// A published app must NOT send mail directly — it is untrusted and driven by
// anonymous visitors (open-relay / reputation risk). Sending goes through the
// platform, which owns quota, per-app rate limits, a locked From on the
// platform subdomain, billing attribution to the owner, and suppression lists.
//
// M1 ships the SIGNATURE the capability matrix promises; the platform send
// endpoint is wired in a later milestone (§8.5). Keep app code calling this —
// never a raw SMTP/provider SDK.
export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail(_input: SendEmailInput): Promise<void> {
  throw new Error("sendEmail: platform email endpoint not wired yet (DESIGN §8.5).");
}
