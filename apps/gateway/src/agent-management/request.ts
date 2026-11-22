import { desktopEnabled } from "../desktop/guard.js";
import { getGatewayListener } from "../relay/state.js";
import { resolveSkillActor } from "../skills/context.js";
import { agentManagementPolicy } from "./policy.js";
import { readAgentManagementMode } from "./mode.js";

export async function agentManagementRequest(multiUser: boolean, userId?: string) {
  const actor = await resolveSkillActor(userId);
  return {
    actor,
    multiUser,
    ...agentManagementPolicy({
      value: readAgentManagementMode().value,
      multiUser,
      desktop: desktopEnabled(),
      listenerAddress: getGatewayListener()?.address,
      actor,
    }),
  };
}
