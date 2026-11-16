import { For, Show, createResource, createSignal, onCleanup } from "solid-js";
import { createImportToken, fetchImportTokens, revokeImportToken, type CreatedImportToken } from "../api/skills";
import type { GatewayName } from "../api/gateway";
import { IMPORT_REACH_NOTE, importAddressProblem } from "../lib/skill-import-url";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";

const formatDate = (value: string) => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * The tokens belong to one gateway. The dialog reads that gateway once, and the page mounts a new dialog for each
 * gateway visit. A secret token and its prompt live only in this component. They go to no cache, storage, or log,
 * and they end with the dialog. A late answer of a closed dialog changes nothing.
 */
export function SkillImportDialog(props: { onClose: () => void; gateway?: GatewayName }) {
  const gateway = props.gateway;
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const [tokens, { refetch }] = createResource(() => fetchImportTokens(gateway));
  const [created, setCreated] = createSignal<CreatedImportToken>();
  const [copied, setCopied] = createSignal<"token" | "prompt">();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  // A remote prompt with an address of the local network cannot work. The secret then stays hidden.
  const addressProblem = () => { const token = created(); return gateway !== undefined && token ? importAddressProblem(token.prompt) : undefined; };
  // After an uncertain create or revoke the remote may hold the change although the answer failed. Both controls stay off
  // until a read of the same gateway works, so no click creates a second token or repeats a revoke from a stale list.
  const [unknown, setUnknown] = createSignal(false);
  // Each write has its own attempt number. A recovery of an older attempt changes nothing.
  let attempt = 0;
  const settle = async (mine: number) => {
    try { await refetch(); } catch { /* The error state of the resource tells the result. */ }
    if (!disposed && mine === attempt) setUnknown(Boolean(tokens.error));
  };
  const run = async (operation: () => Promise<void>, uncertain = true) => {
    if (unknown()) return;
    const mine = ++attempt;
    setBusy(true); setError("");
    let failed = false;
    try { await operation(); }
    catch (cause) { failed = true; if (!disposed && mine === attempt) setError(cause instanceof Error ? cause.message : "Unable to manage import token."); }
    if (failed && uncertain && !disposed && mine === attempt) await settle(mine);
    if (!disposed && mine === attempt) setBusy(false);
  };
  const retryRead = async () => {
    const mine = ++attempt;
    setBusy(true);
    await settle(mine);
    if (!disposed && mine === attempt) setBusy(false);
  };
  const copy = (kind: "token" | "prompt", value: string) => run(async () => {
    await navigator.clipboard.writeText(value);
    if (disposed) return;
    setCopied(kind); setTimeout(() => setCopied((current) => current === kind ? undefined : current), 2000);
  }, false);
  const copyLabel = (kind: "token" | "prompt", label: string) => copied() === kind ? "Copied" : label;
  return <Modal title="Import from Claude or ChatGPT" size="lg" onClose={props.onClose} dismissible={!busy()} error={error()} footer={<Button onClick={props.onClose} disabled={busy()}>Done</Button>}>
    <ol class="skill-dialog-steps">
      <li>Generate an import token.</li>
      <li><span>Copy the prompt and paste it into Claude or ChatGPT. For 24 hours, it can send skill files to your library. <strong>If you want to import specific skills, do not forget to customize the prompt to name them first.</strong></span></li>
      <li>Turn on the skills that you want. Imported skills stay off until you turn them on.</li>
    </ol>
    <Show when={created()} fallback={<div class="skill-dialog-start"><Button variant="primary" icon="fa-solid fa-key" disabled={busy() || unknown()} onClick={() => void run(async () => { const token = await createImportToken(gateway); if (disposed) return; setCreated(token); await refetch(); })}>Generate import token</Button></div>}>{(token) => <Show when={!addressProblem()} fallback={<p class="skill-dialog-status" role="alert">{addressProblem()} Revoke the token below, then generate a new one.</p>}><section class="skill-dialog-token" aria-label="New import token">
      <p class="skill-dialog-notice"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true" />Copy the prompt now. The token shows only once. It expires {formatDate(token().expiresAt)}.</p>
      <Show when={gateway !== undefined}><p class="skill-dialog-status" role="note">{IMPORT_REACH_NOTE}</p></Show>
      <div class="skill-dialog-field">
        <div class="skill-dialog-field-head"><span>Prompt to paste</span><Button variant="primary" icon={copied() === "prompt" ? "fa-solid fa-check" : "fa-regular fa-copy"} onClick={() => void copy("prompt", token().prompt)} disabled={busy()}>{copyLabel("prompt", "Copy prompt")}</Button></div>
        <textarea aria-label="Import prompt" readonly rows={8} value={token().prompt} />
      </div>
      <div class="skill-dialog-field">
        <div class="skill-dialog-field-head"><span>Token only</span></div>
        <div class="skill-dialog-inline"><input aria-label="Import token" readonly value={token().token} /><Button icon={copied() === "token" ? "fa-solid fa-check" : "fa-regular fa-copy"} onClick={() => void copy("token", token().token)} disabled={busy()}>{copyLabel("token", "Copy token")}</Button></div>
      </div>
    </section></Show>}</Show>
    <section class="skill-dialog-section" aria-labelledby="skill-import-active">
      <h3 id="skill-import-active">Active import tokens</h3>
      <Show when={tokens.error}><p class="skill-dialog-status" role="alert">Unable to load tokens. <button class="skill-dialog-link" onClick={() => void retryRead()}>Retry</button></p></Show>
      <Show when={tokens.loading}><p class="skill-dialog-status" role="status">Loading tokens…</p></Show>
      <Show when={!tokens.loading && !tokens.error}>
        <Show when={tokens()?.tokens.length} fallback={<p class="skill-dialog-status">No active tokens.</p>}>
          <ul class="skill-dialog-list">
            <For each={tokens()?.tokens}>{(token) => <li>
              <div><strong>Import token</strong><span>Expires {formatDate(token.expiresAt)}</span></div>
              <Button icon="fa-solid fa-ban" aria-label={`Revoke import token ${token.id}`} disabled={busy() || unknown()} onClick={() => void run(async () => { await revokeImportToken(token.id, gateway); if (disposed) return; if (created()?.id === token.id) setCreated(undefined); await refetch(); })}>Revoke</Button>
            </li>}</For>
          </ul>
        </Show>
      </Show>
    </section>
  </Modal>;
}
