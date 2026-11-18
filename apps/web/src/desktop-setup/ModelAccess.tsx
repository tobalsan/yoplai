import { For, Show, createMemo, createResource, createSignal, onCleanup } from "solid-js";
import { errorText, readAccess, readModels, request, SetupError, type Attempt, type Model } from "./api";

const oauth = [
  { id: "openai-codex", name: "ChatGPT subscription" },
  { id: "anthropic", name: "Claude subscription" },
];
const sources = [
  { id: "codex", name: "Codex CLI" }, { id: "claude-code", name: "Claude Code" },
  { id: "opencode", name: "OpenCode CLI" }, { id: "pi", name: "Pi CLI" },
];
const shortList = ["anthropic", "openai", "google", "openrouter", "zai", "opencode", "deepseek"];
const sourcePath = (id: string) => `model-access/external/${encodeURIComponent(id)}`;
const attemptPath = (attempt: Attempt) => `model-access/oauth/attempts/${encodeURIComponent(attempt.handle)}`;

export function ReadyMark() { return <span class="setup-ready">Ready</span>; }

export function ModelAccess(props: { onContinue: (models: Model[]) => void }) {
  const [error, setError] = createSignal("");
  const [attempts, setAttempts] = createSignal<Attempt[]>([]);
  let firstRead = true;
  const [info, { refetch: reload }] = createResource(async () => {
    try {
      const [access, models] = await Promise.all([readAccess(), readModels()]);
      if (firstRead) { setAttempts(access.attempts ?? []); firstRead = false; }
      return { access, models };
    }
    catch (cause) { setError(errorText(cause)); return undefined; }
  });
  const [busy, setBusy] = createSignal(false);
  const [confirm, setConfirm] = createSignal<{ message: string; accept: () => Promise<void>; keyForm?: true }>();
  const [entry, setEntry] = createSignal(false);
  const [search, setSearch] = createSignal("");
  const [provider, setProvider] = createSignal("");
  const [key, setKey] = createSignal("");
  const [codes, setCodes] = createSignal<Record<string, string>>({});
  const providers = createMemo(() => {
    const all = info()?.access.apiKeyProviders ?? [];
    const query = search().trim().toLowerCase();
    return query ? all.filter((row) => `${row.id} ${row.name}`.toLowerCase().includes(query))
      : shortList.flatMap((id) => all.filter((row) => row.id === id));
  });
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const updateAttempt = (attempt: Attempt) => setAttempts((rows) => {
    const other = rows.filter((row) => row.provider !== attempt.provider);
    return attempt.state === "waiting-browser" || attempt.state === "waiting-code" ? [...other, attempt] : other;
  });
  const fail = (cause: unknown) => setError(errorText(cause));
  const perform = async (action: () => Promise<void>) => {
    if (busy()) return;
    setBusy(true);
    setError("");
    try { await action(); } catch (cause) { fail(cause); } finally { setBusy(false); }
  };
  const finish = async (attempt: Attempt) => {
    updateAttempt(attempt);
    if (attempt.state === "failed") setError(attempt.message ?? "Sign-in failed. Try again.");
    if (attempt.state === "done") await reload();
  };
  let polling = false;
  const timer = setInterval(async () => {
    if (polling || busy() || !attempts().length) return;
    polling = true;
    try {
      await Promise.all(attempts().map(async (current) => {
        try {
          const next = await request<Attempt>(attemptPath(current));
          if (!disposed && !busy() && attempts().includes(current)) await finish(next);
        } catch (cause) {
          if (!disposed && !busy() && attempts().includes(current)) {
            fail(cause);
            if (cause instanceof SetupError && cause.code === "attempt_not_found") updateAttempt({ ...current, state: "failed" });
          }
        }
      }));
    } finally { polling = false; }
  }, 1000);
  onCleanup(() => clearInterval(timer));

  const confirmError = (cause: unknown, code: string, fallback: string, accept: () => Promise<void>) => {
    if (!(cause instanceof SetupError) || cause.code !== code) throw cause;
    setConfirm({ message: code === "replacement_required" ? fallback : cause.message, accept });
  };
  const signIn = async (id: string, warningAccepted = false, replace = false): Promise<void> => {
    try { await finish(await request<Attempt>(`model-access/oauth/${id}`, "POST", { warningAccepted, replace })); }
    catch (cause) {
      if (cause instanceof SetupError && cause.code === "warning_required") {
        confirmError(cause, "warning_required", "", () => signIn(id, true, replace));
      } else confirmError(cause, "replacement_required", "Replace the current credential for this provider?", () => signIn(id, warningAccepted, true));
    }
  };
  const toggle = async (id: string, enabled: boolean, warningAccepted = false): Promise<void> => {
    try { await request(sourcePath(id), "POST", { enabled, warningAccepted }); await reload(); }
    catch (cause) { confirmError(cause, "warning_required", "", () => toggle(id, enabled, true)); }
  };
  let keyRevision = 0;
  const invalidateKey = () => {
    keyRevision += 1;
    if (confirm()?.keyForm) setConfirm(undefined);
  };
  const changeSearch = (query: string) => {
    setSearch(query);
    if (provider() && !providers().some((row) => row.id === provider())) {
      invalidateKey();
      setProvider("");
    }
  };
  const closeKey = () => {
    invalidateKey();
    setEntry(false);
    setKey("");
    changeSearch("");
  };
  const saveKey = async (id: string, value: string, revision = keyRevision, replace = false): Promise<void> => {
    const current = () => !disposed && entry() && keyRevision === revision;
    if (!current()) return;
    try {
      await request("model-access/api-key", "POST", { provider: id, key: value, replace });
      if (current()) closeKey();
      if (!disposed) await reload();
    } catch (cause) {
      if (!current()) return;
      if (!(cause instanceof SetupError) || cause.code !== "replacement_required") throw cause;
      setConfirm({ keyForm: true, message: "Replace the current credential for this provider?", accept: () => saveKey(id, value, revision, true) });
    }
  };
  const modelList = () => info()?.models ?? [];
  const ownedReady = (type: string, provider?: string) => modelList().some((model) => model.source === "owned" &&
    (!provider || model.provider === provider) && info()?.access.owned.some((row) => row.providerId === model.provider && row.type === type));
  const rowOrder = [...sources, ...oauth, { id: "key", name: "API key" }];
  const external = (id: string) => info()?.access.external.find((row) => row.source === id);
  const ready = (id: string) => id === "key" ? ownedReady("api_key") : oauth.some((row) => row.id === id)
    ? ownedReady("oauth", id) : modelList().some((model) => model.source === id);
  const rows = createMemo(() => rowOrder.filter((row) => !sources.includes(row) || external(row.id)?.detected)
    .sort((a, b) => Number(ready(b.id)) - Number(ready(a.id))));

  return <>
    <div class="setup-model-rows">
      <For each={rows()}>{(row) => {
        const attempt = () => attempts().find((active) => active.provider === row.id);
        return <section class="setup-model-row" aria-label={row.name} classList={{ "setup-row-ready": ready(row.id) }}>
          <div class="setup-model-line">
            <div class="setup-row-label"><strong>{row.name}</strong>
              <Show when={external(row.id)}><span>Found on this Mac</span></Show>
              <Show when={row.id === "anthropic"}><small class="setup-tag">Experimental</small></Show>
            </div>
            <Show when={ready(row.id)}><ReadyMark /></Show>
            <Show when={external(row.id)} fallback={
              <Show when={row.id === "key"} fallback={
                <Show when={!attempt()}><button class="setup-outline" disabled={busy() || info.loading} onClick={() => void perform(() => signIn(row.id))}>Sign in</button></Show>
              }><button class="setup-outline" disabled={busy()} onClick={() => { setEntry(true); setError(""); }}>Add a key</button></Show>
            }>{(source) => <button role="switch" aria-label={row.name} aria-checked={source().enabled} class="setup-switch" disabled={busy()}
                onClick={() => void perform(() => toggle(row.id, !source().enabled))}><span /></button>}</Show>
          </div>
          <Show when={row.id === "claude-code"}><p class="setup-row-note">macOS can ask for Keychain access.</p></Show>
          <Show when={external(row.id)?.message ?? (external(row.id)?.denied ? "Access denied" : undefined)}>{(message) => <p class="setup-row-note">{message()}</p>}</Show>
          <Show when={attempt()}>{(active) => <div class="setup-row-detail">
            <p role="status">Finish the sign-in in your browser.</p>
            <Show when={active().state === "waiting-code"}>
              <form onSubmit={(event) => {
                event.preventDefault();
                void perform(async () => {
                  await finish(await request<Attempt>(`${attemptPath(active())}/answer`, "POST", { code: codes()[row.id] }));
                  setCodes((values) => ({ ...values, [row.id]: "" }));
                });
              }}>
                <label>Sign-in code<input autocomplete="off" value={codes()[row.id] ?? ""} onInput={(event) => setCodes((values) => ({ ...values, [row.id]: event.currentTarget.value }))} required /></label>
                <button class="setup-outline" disabled={busy()} type="submit">Submit code</button>
              </form>
            </Show>
            <button class="setup-outline" disabled={busy()} onClick={() => void perform(async () => {
              await finish(await request<Attempt>(`${attemptPath(active())}/cancel`, "POST"));
              setCodes((values) => ({ ...values, [row.id]: "" }));
            })}>Cancel</button>
          </div>}</Show>
        </section>;
      }}</For>
    </div>
    <Show when={entry()}>
      <form class="setup-interaction" aria-label="Add an API key" onSubmit={(event) => {
        event.preventDefault(); void perform(() => saveKey(provider(), key()));
      }}>
        <label>Search providers<input value={search()} onInput={(event) => changeSearch(event.currentTarget.value)} /></label>
        <label>Provider<select required value={provider()} onChange={(event) => { invalidateKey(); setProvider(event.currentTarget.value); }}>
          <option value="">Select a provider</option>
          <For each={providers()}>{(row) => <option value={row.id} selected={provider() === row.id}>{row.name}</option>}</For>
        </select></label>
        <label>API key<input type="password" autocomplete="off" required value={key()} onInput={(event) => { invalidateKey(); setKey(event.currentTarget.value); }} /></label>
        <div class="setup-actions">
          <button class="setup-outline" type="submit" disabled={busy() || !provider()}>Save key</button>
          <button class="setup-outline" type="button" onClick={closeKey}>Cancel</button>
        </div>
      </form>
    </Show>
    <Show when={confirm()}>{(choice) => <section class="setup-interaction" role="alertdialog" aria-label="Confirm model access">
      <p>{choice().message}</p>
      <div class="setup-actions">
        <button class="setup-outline" disabled={busy()} onClick={() => { const accept = choice().accept; setConfirm(undefined); void perform(accept); }}>Confirm</button>
        <button class="setup-outline" onClick={() => setConfirm(undefined)}>Cancel</button>
      </div>
    </section>}</Show>
    <Show when={error()}><p role="alert">{error()}</p></Show>
    <Show when={info.loading && !info()}><p role="status">Loading models…</p></Show>
    <Show when={!info.loading && !info()}><button class="setup-outline" onClick={() => void perform(async () => { await reload(); })}>Retry</button></Show>
    <button class="setup-primary" disabled={!modelList().length || busy() || !!confirm()} onClick={() => props.onContinue(modelList())}>Continue</button>
  </>;
}
