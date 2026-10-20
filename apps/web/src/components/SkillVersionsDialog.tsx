import { For, Show, createResource, createSignal } from "solid-js";
import { fetchSkillVersions, restoreSkillVersion, type SkillRow } from "../api/skills";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";

const formatDate = (value: string) => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

export function SkillVersionsDialog(props: { skill: SkillRow; onClose: () => void; onRestored: () => Promise<void> }) {
  const [versions, { refetch }] = createResource(() => props.skill.id, fetchSkillVersions);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const restore = async (versionId: string) => {
    setBusy(true); setError("");
    try { await restoreSkillVersion(props.skill.id, versionId); await refetch(); await props.onRestored(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to restore version."); }
    finally { setBusy(false); }
  };
  const list = () => versions.error ? [] : versions()?.versions ?? [];
  return <Modal title={`Version history: ${props.skill.name}`} onClose={props.onClose} dismissible={!busy()} error={error()} footer={<Button aria-label="Close versions" disabled={busy()} onClick={props.onClose}>Done</Button>}>
    <p class="skill-dialog-intro">Roll back to a saved version. Yoplai saves the current content first, and keeps sharing and enable settings. It keeps the last 10 versions.</p>
    <Show when={versions.loading}><p class="skill-dialog-status" role="status">Loading versions…</p></Show>
    <Show when={versions.error}><p class="skill-dialog-status" role="alert">Unable to load versions. <button class="skill-dialog-link" onClick={() => void refetch()}>Retry</button></p></Show>
    <Show when={!versions.loading && !versions.error}>
      <Show when={list().length} fallback={<div class="skill-dialog-empty"><i class="fa-solid fa-clock-rotate-left" aria-hidden="true" /><p>No saved versions yet</p><span>Each update saves the previous content here.</span></div>}>
        <ul class="skill-dialog-list">
          <For each={list()}>{(version, index) => <li>
            <div><strong>{formatDate(version.createdAt)}</strong><Show when={index() === 0}><span>Latest saved version</span></Show></div>
            <Button disabled={busy()} icon="fa-solid fa-rotate-left" aria-label={`Restore version ${version.id}`} onClick={() => void restore(version.id)}>Roll back</Button>
          </li>}</For>
        </ul>
      </Show>
    </Show>
  </Modal>;
}
