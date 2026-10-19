import { For, Show, createResource, createSignal } from "solid-js";
import { createImportToken, fetchImportTokens, revokeImportToken, type CreatedImportToken } from "../api/skills";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";

export function SkillImportDialog(props: { onClose: () => void }) {
  const [tokens, { refetch }] = createResource(fetchImportTokens);
  const [created, setCreated] = createSignal<CreatedImportToken>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await operation(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to manage import token."); }
    finally { setBusy(false); }
  };
  const copy = (value: string) => run(async () => { await navigator.clipboard.writeText(value); });
  return <Modal title="Import from Claude or ChatGPT" size="lg" onClose={props.onClose} dismissible={!busy()} error={error()} footer={<Button onClick={props.onClose} disabled={busy()}>Done</Button>}>
    <p>Generate a token, then paste the prompt into your other assistant. It can send skill files to your library for 24 hours. Imported skills stay off until you enable them.</p>
    <Button variant="primary" disabled={busy() || !!created()} onClick={() => void run(async () => { setCreated(await createImportToken()); await refetch(); })}>Generate import token</Button>
    <Show when={created()}>{(token) => <>
      <p>Copy this token now. It is shown only once. Expires {new Date(token().expiresAt).toLocaleString()}.</p>
      <label>Import token<input aria-label="Import token" readonly value={token().token} /></label><Button onClick={() => void copy(token().token)} disabled={busy()}>Copy token</Button>
      <label>Prompt to paste<textarea aria-label="Import prompt" readonly rows={12} value={token().prompt} /></label><Button onClick={() => void copy(token().prompt)} disabled={busy()}>Copy prompt</Button>
    </>}</Show>
    <h3>Active import tokens</h3>
    <Show when={tokens.error}><p role="alert">Unable to load tokens. <button onClick={() => void refetch()}>Retry</button></p></Show>
    <Show when={tokens.loading}><p role="status">Loading tokens…</p></Show>
    <ul><For each={tokens.error ? [] : tokens()?.tokens ?? []} fallback={<li>No active tokens.</li>}>{(token) => <li>Expires {new Date(token.expiresAt).toLocaleString()} <button aria-label={`Revoke import token ${token.id}`} disabled={busy()} onClick={() => void run(async () => { await revokeImportToken(token.id); if (created()?.id === token.id) setCreated(undefined); await refetch(); })}>Revoke</button></li>}</For></ul>
    <style>{`.skills-page .ui-modal label{display:flex;flex-direction:column;gap:8px}.skills-page .ui-modal textarea,.skills-page .ui-modal input{width:100%;box-sizing:border-box;padding:10px;font:inherit;color:var(--text-primary);background:var(--bg-base);border:1px solid var(--border-default);border-radius:6px}`}</style>
  </Modal>;
}
