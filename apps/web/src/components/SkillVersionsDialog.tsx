import { For, Show, createResource, createSignal } from "solid-js";
import { fetchSkillVersions, restoreSkillVersion, type SkillRow } from "../api/skills";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";

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
  return <Modal title={`Version history: ${props.skill.name}`} onClose={props.onClose} dismissible={!busy()} error={error()} footer={<Button aria-label="Close versions" disabled={busy()} onClick={props.onClose}>Done</Button>}>
    <p>Roll back to a saved version. The current content is saved first. Sharing and enable settings stay the same. The last 10 versions are kept.</p>
    <Show when={versions.loading}><p role="status">Loading versions…</p></Show>
    <Show when={versions.error}><p role="alert">Unable to load versions. <button onClick={() => void refetch()}>Retry</button></p></Show>
    <ul><For each={versions.error ? [] : versions()?.versions ?? []} fallback={<li>No saved versions yet.</li>}>{(version) => <li>{new Date(version.createdAt).toLocaleString()} <button disabled={busy()} aria-label={`Restore version ${version.id}`} onClick={() => void restore(version.id)}>Roll back</button></li>}</For></ul>
  </Modal>;
}
