import { getSlackContext } from "./context.js";
import { getSlackPairingService } from "./pairing.js";
import type { SlackWebClient } from "./types.js";

const workspaces = new WeakMap<SlackWebClient, Promise<string | undefined>>();
const knownWorkspaces = new WeakMap<SlackWebClient, string>();

export function getCachedSlackWorkspace(client: SlackWebClient): string | undefined {
  return knownWorkspaces.get(client);
}

export function cacheSlackWorkspace(client: SlackWebClient, workspace: string): void {
  knownWorkspaces.set(client, workspace);
}

export async function getSlackWorkspace(client: SlackWebClient): Promise<string | undefined> {
  const known = getCachedSlackWorkspace(client);
  if (known) return known;
  let workspace = workspaces.get(client);
  if (!workspace) {
    let timer: ReturnType<typeof setTimeout>;
    workspace = Promise.race([
      Promise.resolve().then(() => client.auth?.test()).then((auth) => auth?.team_id),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 5000);
        timer.unref();
      }),
    ]).catch(() => undefined).finally(() => clearTimeout(timer));
    workspaces.set(client, workspace);
  }
  const id = await workspace;
  if (id) cacheSlackWorkspace(client, id);
  else workspaces.delete(client);
  return id;
}

export async function resolveSlackRequester(
  client: SlackWebClient,
  slackUserId: string | undefined
): Promise<string | undefined> {
  const pairing = getSlackPairingService();
  if (!pairing || !slackUserId) return undefined;
  const workspace = await getSlackWorkspace(client);
  // Missing workspace or pairing is an unpaired run: team credentials only.
  return workspace ? pairing.resolve(workspace, slackUserId) : undefined;
}

/**
 * Requester for an answer to a tracked proactive DM. A paired account without
 * access to the agent runs as the service actor (team credentials), like an
 * unpaired participant, instead of being denied by the gateway.
 */
export async function resolveProactiveSlackRequester(
  client: SlackWebClient,
  slackUserId: string | undefined,
  agentId: string
): Promise<string | undefined> {
  const requesterId = await resolveSlackRequester(client, slackUserId);
  if (!requesterId) return undefined;
  const { getMultiUserRuntime, getEligibleAccount, hasAgentAccess } = await import("@yoplai/extension-multi-user");
  const runtime = getMultiUserRuntime();
  if (!runtime) return requesterId;
  // Same check as the gateway's requireActorExecution, so the two cannot disagree.
  const account = getEligibleAccount(runtime.db, requesterId, { approvalBypass: "superadmin" });
  if (account && (await hasAgentAccess({ user: { id: account.id, email: account.email, role: account.role, approved: true }, session: { id: "agent-execution", userId: account.id } }, agentId))) {
    return requesterId;
  }
  getSlackContext().logger.warn("[slack] proactive reply runs as service actor", { requesterId, agentId, reason: "no agent access" });
  return undefined;
}

/** Trusted Slack sender of an in-flight run, so tools can act for them without model input. */
export type ActiveSlackSender = {
  agentId: string;
  sessionKey: string;
  sessionId?: string;
  requesterId?: string;
  client: SlackWebClient;
  user: string;
  /** Shared-thread overlapping runs cannot safely identify a tool caller. */
  credentialConnectAmbiguous?: boolean;
  channel?: string;
  messageTs?: string;
  threadTs?: string;
  /** Set by slack.pair; the bot substitutes it for the reply placeholder. */
  pairingLink?: string;
};

export const SLACK_PAIR_LINK_PLACEHOLDER = "<slack-pair-link>";

const activeSenders = new Set<ActiveSlackSender>();

export function trackSlackSender(sender: ActiveSlackSender): () => void {
  for (const active of activeSenders) {
    if ((!active.requesterId || !sender.requesterId) && active.agentId === sender.agentId && (active.sessionKey === sender.sessionKey || (active.sessionId && active.sessionId === sender.sessionId))) {
      active.credentialConnectAmbiguous = true;
      sender.credentialConnectAmbiguous = true;
    }
  }
  activeSenders.add(sender);
  return () => activeSenders.delete(sender);
}

export async function findSlackSender(
  agentId: string,
  sessionId: string | undefined,
  resolveSessionId: (agentId: string, sessionKey: string) => Promise<string | undefined>,
  requireUnique = false,
  requesterId?: string
): Promise<ActiveSlackSender | undefined> {
  if (!sessionId) return undefined;
  let matched: ActiveSlackSender | undefined;
  for (const sender of activeSenders) {
    if (sender.agentId !== agentId) continue;
    if (requesterId && sender.requesterId !== requesterId) continue;
    const id = sender.sessionId ?? (await resolveSessionId(agentId, sender.sessionKey));
    if (id === sessionId) {
      if (!requireUnique) return sender;
      if (matched) return undefined;
      matched = sender;
    }
  }
  return matched;
}
