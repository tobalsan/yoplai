import { getSlackPairingService } from "./pairing.js";
import type { SlackWebClient } from "./types.js";

const workspaces = new WeakMap<SlackWebClient, Promise<string | undefined>>();

export async function getSlackWorkspace(client: SlackWebClient): Promise<string | undefined> {
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
  if (!id) workspaces.delete(client);
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

/** Trusted Slack sender of an in-flight run, so tools can act for them without model input. */
export type ActiveSlackSender = {
  agentId: string;
  sessionKey: string;
  sessionId?: string;
  client: SlackWebClient;
  user: string;
  /** Set by slack.pair; the bot substitutes it for the reply placeholder. */
  pairingLink?: string;
};

export const SLACK_PAIR_LINK_PLACEHOLDER = "<slack-pair-link>";

const activeSenders = new Set<ActiveSlackSender>();

export function trackSlackSender(sender: ActiveSlackSender): () => void {
  activeSenders.add(sender);
  return () => activeSenders.delete(sender);
}

export async function findSlackSender(
  agentId: string,
  sessionId: string | undefined,
  resolveSessionId: (agentId: string, sessionKey: string) => Promise<string | undefined>
): Promise<ActiveSlackSender | undefined> {
  if (!sessionId) return undefined;
  for (const sender of activeSenders) {
    if (sender.agentId !== agentId) continue;
    const id = sender.sessionId ?? (await resolveSessionId(agentId, sender.sessionKey));
    if (id === sessionId) return sender;
  }
  return undefined;
}
