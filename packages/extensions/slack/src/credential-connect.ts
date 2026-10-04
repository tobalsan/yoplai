import { createHash, randomBytes } from "node:crypto";
import type { CredentialConnectTarget, ExtensionAgentToolContext } from "@yoplai/shared";
import { getSlackContext } from "./context.js";
import { getSlackPairingService, SlackPairingError } from "./pairing.js";
import { findSlackSender, getSlackWorkspace, SLACK_PAIR_LINK_PLACEHOLDER, type ActiveSlackSender } from "./requester.js";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const lifetime = 10 * 60 * 1000;

type ConnectRequest = {
  sender: ActiveSlackSender;
  workspace: string;
  target: CredentialConnectTarget;
  pairingToken?: string;
  owner?: string;
  expires: number;
  busy: boolean;
  completed: boolean;
};
const requests = new Map<string, ConnectRequest>();

export function clearCredentialConnectRequests(): void { requests.clear(); }

export async function createCredentialConnectLink(context: ExtensionAgentToolContext, target: CredentialConnectTarget): Promise<string | undefined> {
  if (target.kind === "extension-oauth" && !target.targetId.trim()) throw new Error("An extension OAuth target ID is required.");
  const ctx = getSlackContext();
  const pairing = getSlackPairingService();
  if (!pairing || !ctx.credentialConnect) return undefined;
  const sender = await findSlackSender(context.agent.id, context.sessionId, async (agentId, key) => (await ctx.resolveSessionId(agentId, key, context.userId))?.sessionId, true);
  if (!sender?.channel || sender.credentialConnectAmbiguous) return undefined;
  const workspace = await getSlackWorkspace(sender.client);
  if (!workspace) return undefined;
  const owner = pairing.resolve(workspace, sender.user);
  const pairingToken = owner ? undefined : new URL(await pairing.issue(workspace, sender.user, sender.client)).pathname.split("/").pop();
  if (sender.credentialConnectAmbiguous) return undefined;
  const token = randomBytes(32).toString("base64url");
  for (const [key, request] of requests) if (request.expires <= Date.now()) requests.delete(key);
  const snapshot: CredentialConnectTarget = target.kind === "extension-oauth"
    ? { kind: "extension-oauth", extensionId: target.extensionId, targetId: target.targetId }
    : target;
  requests.set(hash(token), { sender, workspace, target: snapshot, pairingToken, owner, expires: Date.now() + lifetime, busy: false, completed: false });
  sender.pairingLink = new URL(`/api/slack/connect/${token}`, pairing.baseUrl).href;
  return SLACK_PAIR_LINK_PLACEHOLDER;
}

export function inspectCredentialConnect(token: string): ConnectRequest {
  const request = requests.get(hash(token));
  if (!request || request.expires <= Date.now() || request.completed) throw new SlackPairingError("This connection link has expired or already been used. Request a new link in Slack.");
  return request;
}

/** Reuse pairing's email ownership check; no credential operation precedes it. */
export async function bindCredentialConnect(request: ConnectRequest, user: { id: string; email: string }): Promise<void> {
  const pairing = getSlackPairingService();
  if (!pairing) throw new SlackPairingError("Slack pairing is unavailable.");
  if (request.owner) {
    if (request.owner !== user.id || pairing.resolve(request.workspace, request.sender.user) !== user.id) {
      throw new SlackPairingError("This link was created for another Slack account");
    }
    return;
  }
  if (!request.pairingToken) throw new SlackPairingError("Slack pairing is unavailable.");
  await pairing.redeem(request.pairingToken, user);
  request.owner = user.id;
  request.pairingToken = undefined;
}

export async function confirmCredentialConnect(request: ConnectRequest): Promise<void> {
  if (request.completed) return;
  request.completed = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      request.sender.client.chat.postMessage({ channel: request.sender.channel!, thread_ts: request.sender.threadTs, text: "You're connected, try again", unfurl_links: false }),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 5000); }),
    ]);
  } catch {
    console.warn("[slack] Connection succeeded but thread confirmation could not be delivered");
  } finally {
    if (timer) clearTimeout(timer);
  }
}
