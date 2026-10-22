import { Show, createSignal } from "solid-js";

/** Decorative profile photo with initials when missing or unavailable. A changed URL retries the photo. */
export function UserAvatar(props: { name?: string | null; email?: string | null; image?: string | null; class?: string }) {
  const [failedImage, setFailedImage] = createSignal<string>();
  const initials = () => (props.name?.trim() || props.email?.trim() || "?")
    .split(/\s+/).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("");
  return (
    <span class={props.class} aria-hidden="true" style={{ overflow: "hidden" }}>
      <Show when={props.image && props.image !== failedImage()} fallback={initials()}>
        <img src={props.image!} alt="" referrerPolicy="no-referrer"
          style={{ width: "100%", height: "100%", "object-fit": "cover" }}
          onError={(event) => setFailedImage(event.currentTarget.getAttribute("src") ?? undefined)} />
      </Show>
    </span>
  );
}
