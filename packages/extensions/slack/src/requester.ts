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
