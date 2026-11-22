import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { avatarFaceUrl } from "../../lib/default-avatar";
import { Button } from "../ui/Button";
import "./agent-management.css";

export type AvatarDraft = { face: number; file?: File; existing?: string };

export function preventFileNavigation() {
  onMount(() => {
    const prevent = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files") || event.dataTransfer?.files.length) event.preventDefault();
    };
    document.addEventListener("dragover", prevent);
    document.addEventListener("drop", prevent);
    onCleanup(() => {
      document.removeEventListener("dragover", prevent);
      document.removeEventListener("drop", prevent);
    });
  });
}

export function AvatarPreview(props: { image: string; label?: string }) {
  return <Show when={!(/^\p{Emoji}/u.test(props.image) && props.image.length <= 4)}
    fallback={<span class="agent-avatar-emoji" role="img" aria-label={props.label ?? "Avatar preview"}>{props.image}</span>}>
    <img class="agent-avatar-preview" src={props.image} alt={props.label ?? "Avatar preview"} />
  </Show>;
}

export function AvatarField(props: { value: AvatarDraft; custom?: boolean; disabled?: boolean; onChange: (draft: AvatarDraft) => void }) {
  let input: HTMLInputElement | undefined;
  const [dragOver, setDragOver] = createSignal(false);
  const [preview, setPreview] = createSignal<string>();
  createEffect(() => {
    const file = props.value.file;
    if (!file) { setPreview(undefined); return; }
    const reader = new FileReader();
    reader.onload = () => setPreview(typeof reader.result === "string" ? reader.result : undefined);
    reader.readAsDataURL(file);
    onCleanup(() => reader.abort());
  });
  const accept = (file?: File) => {
    if (file?.type.startsWith("image/") && !props.disabled) props.onChange({ face: props.value.face, file });
  };
  const shuffle = () => {
    const offset = 1 + Math.floor(Math.random() * 9);
    props.onChange({ face: (props.value.face - 1 + offset) % 10 + 1 });
  };
  return <div class="agent-avatar-field" classList={{ "is-drag-over": dragOver() }}
    onDragOver={(event) => {
      event.preventDefault();
      if (event.dataTransfer?.types.includes("Files") && !props.disabled) setDragOver(true);
    }}
    onDragLeave={(event) => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragOver(false);
    }}
    onDrop={(event) => {
      event.preventDefault();
      setDragOver(false);
      accept(event.dataTransfer?.files[0]);
    }}>
    <AvatarPreview image={preview() ?? props.value.existing ?? avatarFaceUrl(props.value.face)} />
    <div class="agent-avatar-actions">
      <Button disabled={props.disabled} onClick={shuffle}>Shuffle face</Button>
      <Button disabled={props.disabled} onClick={() => input?.click()}>Upload image</Button>
      <Show when={props.value.file || (props.custom && props.value.existing)}>
        <Button variant="ghost" disabled={props.disabled} onClick={() => props.onChange({ face: props.value.face })}>Remove image</Button>
      </Show>
    </div>
    <input type="file" ref={input} hidden aria-label="Avatar image" accept="image/png,image/jpeg,image/webp,image/gif"
      onChange={(event) => { accept(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} />
    <Show when={dragOver()}><span class="agent-avatar-drop-hint">Drop image</span></Show>
  </div>;
}
