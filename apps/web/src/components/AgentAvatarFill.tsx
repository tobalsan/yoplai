import { Show } from "solid-js";
import { defaultAvatarUrl } from "../lib/default-avatar";

/**
 * Inside an avatar box: an image for a URL avatar, the text of an emoji avatar,
 * and the default image of the agent when the avatar is empty.
 * `agentId` is the full wire agent ID, also for a remote agent.
 */
export function AgentAvatarFill(props: { avatar?: string | null; agentId: string }) {
  return (
    <Show when={props.avatar} fallback={<img src={defaultAvatarUrl(props.agentId)} alt="" />}>
      {(avatar) => (
        <Show when={avatar().startsWith("/") || /^https?:\/\//i.test(avatar())} fallback={avatar()}>
          <img src={avatar()} alt="" />
        </Show>
      )}
    </Show>
  );
}
