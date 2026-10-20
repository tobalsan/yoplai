import { For, Show, createResource, createSignal } from "solid-js";
import { createImportToken, fetchImportTokens, revokeImportToken, type CreatedImportToken } from "../api/skills";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";

const formatDate = (value: string) => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function SkillImportDialog(props: { onClose: () => void }) {
  const [tokens, { refetch }] = createResource(fetchImportTokens);
  const [created, setCreated] = createSignal<CreatedImportToken>();
  const [copied, setCopied] = createSignal<"token" | "prompt">();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await operation(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to manage import token."); }
    finally { setBusy(false); }
  };
  const copy = (kind: "token" | "prompt", value: string) => run(async () => {
    await navigator.clipboard.writeText(value);
    setCopied(kind); setTimeout(() => setCopied((current) => current === kind ? undefined : current), 2000);
  });
  const copyLabel = (kind: "token" | "prompt", label: string) => copied() === kind ? "Copied" : label;
  return <Modal title="Import from Claude or ChatGPT" size="lg" onClose={props.onClose} dismissible={!busy()} error={error()} footer={<Button onClick={props.onClose} disabled={busy()}>Done</Button>}>
    <ol class="skill-dialog-steps">
      <li>Generate an import token.</li>
      <li>Copy the prompt and paste it into Claude or ChatGPT. For 24 hours, it can send skill files to your library.</li>
      <li>Turn on the skills that you want. Imported skills stay off until you turn them on.</li>
    </ol>
    <Show when={created()} fallback={<div class="skill-dialog-start"><Button variant="primary" icon="fa-solid fa-key" disabled={busy()} onClick={() => void run(async () => { setCreated(await createImportToken()); await refetch(); })}>Generate import token</Button></div>}>{(token) => <section class="skill-dialog-token" aria-label="New import token">
      <p class="skill-dialog-notice"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true" />Copy the prompt now. The token shows only once. It expires {formatDate(token().expiresAt)}.</p>
      <div class="skill-dialog-field">
        <div class="skill-dialog-field-head"><span>Prompt to paste</span><Button variant="primary" icon={copied() === "prompt" ? "fa-solid fa-check" : "fa-regular fa-copy"} onClick={() => void copy("prompt", token().prompt)} disabled={busy()}>{copyLabel("prompt", "Copy prompt")}</Button></div>
        <textarea aria-label="Import prompt" readonly rows={8} value={token().prompt} />
      </div>
      <div class="skill-dialog-field">
        <div class="skill-dialog-field-head"><span>Token only</span></div>
        <div class="skill-dialog-inline"><input aria-label="Import token" readonly value={token().token} /><Button icon={copied() === "token" ? "fa-solid fa-check" : "fa-regular fa-copy"} onClick={() => void copy("token", token().token)} disabled={busy()}>{copyLabel("token", "Copy token")}</Button></div>
      </div>
    </section>}</Show>
    <section class="skill-dialog-section" aria-labelledby="skill-import-active">
      <h3 id="skill-import-active">Active import tokens</h3>
      <Show when={tokens.error}><p class="skill-dialog-status" role="alert">Unable to load tokens. <button class="skill-dialog-link" onClick={() => void refetch()}>Retry</button></p></Show>
      <Show when={tokens.loading}><p class="skill-dialog-status" role="status">Loading tokens…</p></Show>
      <Show when={!tokens.loading && !tokens.error}>
        <Show when={tokens()?.tokens.length} fallback={<p class="skill-dialog-status">No active tokens.</p>}>
          <ul class="skill-dialog-list">
            <For each={tokens()?.tokens}>{(token) => <li>
              <div><strong>Import token</strong><span>Expires {formatDate(token.expiresAt)}</span></div>
              <Button icon="fa-solid fa-ban" aria-label={`Revoke import token ${token.id}`} disabled={busy()} onClick={() => void run(async () => { await revokeImportToken(token.id); if (created()?.id === token.id) setCreated(undefined); await refetch(); })}>Revoke</Button>
            </li>}</For>
          </ul>
        </Show>
      </Show>
    </section>
  </Modal>;
}
