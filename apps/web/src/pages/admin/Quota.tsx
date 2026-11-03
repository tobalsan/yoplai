import { For, Show, createEffect, createResource, onCleanup } from "solid-js";
import { fetchModelQuota, type ModelQuota, type QuotaLogin } from "../../api/model-quota";
import { capabilities } from "../../lib/capabilities";
import { isSuperadmin } from "../../lib/roles";
import { Button } from "../../components/ui/Button";
import AdminLayout from "./AdminLayout";

const POLL_INTERVAL_MS = 20_000;
const REQUEST_TIMEOUT_MS = 30_000;
const SOURCES: Record<string, string> = { headers: "Claude response headers", "usage-endpoint": "Claude usage endpoint", "wham-usage": "ChatGPT usage endpoint" };
const absolute = (time: number) => new Date(time * 1000).toLocaleString();
function relative(seconds: number) {
  const amount = Math.abs(seconds);
  const value = amount < 60 ? `${Math.floor(amount)}s` : amount < 3600 ? `${Math.floor(amount / 60)}m` : amount < 86400 ? `${Math.floor(amount / 3600)}h` : `${Math.floor(amount / 86400)}d`;
  return seconds > 0 ? `in ${value}` : `${value} ago`;
}

export default function Quota() {
  const permitted = () => !capabilities.multiUser || isSuperadmin(capabilities.user?.role);
  let activeRequest: AbortController | undefined;
  let requestDeadline: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => { activeRequest?.abort(); clearTimeout(requestDeadline); });
  const [result, { refetch }] = createResource(permitted, async (_, { value }): Promise<{ data?: ModelQuota; error?: string }> => {
    const controller = new AbortController();
    activeRequest = controller;
    let deadline: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => { controller.abort(); reject(new Error("Quota request timed out.")); }, REQUEST_TIMEOUT_MS);
    });
    requestDeadline = deadline!;
    try { return { data: await Promise.race([fetchModelQuota(controller.signal), timeout]) }; }
    catch { return { data: value?.data, error: "Unable to refresh quota. Retry or wait for the next update." }; }
    finally { clearTimeout(deadline!); if (activeRequest === controller) activeRequest = undefined; }
  });
  const data = () => result.latest?.data;
  createEffect(() => {
    if (!permitted()) return;
    const timer = setInterval(() => { if (!result.loading) void refetch(); }, POLL_INTERVAL_MS);
    onCleanup(() => clearInterval(timer));
  });
  const window = (value: QuotaLogin["weekly"]) => value ? <><strong>{value.usedPercent}%</strong><time title={absolute(value.resetAt)} dateTime={new Date(value.resetAt * 1000).toISOString()}>resets {relative(value.resetAt - data()!.generatedAt)}</time></> : "—";
  return <AdminLayout title="Quota" description="Subscription usage on this host.">
    <Show when={permitted()} fallback={<p role="alert">Superadmin access required.</p>}>
      <Show when={result.latest?.error}><p role="alert">{result.latest?.error} <Button disabled={result.loading} onClick={() => void refetch()}>Retry</Button></p></Show>
      <Show when={result.loading && !result.latest}><p role="status">Loading quota…</p></Show>
      <Show when={data()?.logins.length === 0}><p>No quota readings yet.</p><Show when={!data()?.pollingEnabled}><p>Enable <code>modelQuota.enabled</code> in configuration to poll subscription usage.</p></Show></Show>
      <p class="quota-note">Claude updates after each call. ChatGPT readings can be up to 5–10 minutes old. This page refreshes local readings every 20 seconds.</p>
      <For each={data()?.logins}>{(login) => <article class="quota-login">
        <header><h2>{login.provider === "anthropic" ? "Claude" : login.provider === "openai-codex" ? "ChatGPT" : login.provider} <span>{login.accountRef}</span></h2><div class="quota-status"><Show when={login.stale}><span class="quota-badge quota-badge--warning">Stale</span></Show><Show when={login.error}><span class="quota-badge quota-badge--error">Error: {login.error}</span></Show><Show when={!login.stale && !login.error}><span class="quota-badge">Fresh</span></Show></div></header>
        <dl classList={{ "quota-numbers--stale": login.stale }}>
          <div><dt>Plan</dt><dd>{login.plan ?? "—"}</dd></div>
          <div><dt>5-hour window</dt><dd>{login.fiveHourState === "absent" ? "none" : login.fiveHourState === "unknown" ? <>—<Show when={login.fiveHour}><span class="quota-last-known">Last known: {window(login.fiveHour)}</span></Show></> : <>{window(login.fiveHour)}<Show when={login.fiveHourState === "exhausted"}><span class="quota-exhausted">Exhausted</span></Show></>}</dd></div>
          <div><dt>Weekly window</dt><dd>{window(login.weekly)}</dd></div>
          <div><dt>Weekly pace</dt><dd>{login.weeklyPace === null ? "—" : `${login.weeklyPace.toFixed(2)}×`}</dd></div>
          <div><dt>Last updated</dt><dd>{login.updatedAt === null ? "—" : <><time dateTime={new Date(login.updatedAt * 1000).toISOString()}>{absolute(login.updatedAt)}</time><span>{relative(login.updatedAt - data()!.generatedAt)}</span></>}</dd></div>
          <div><dt>Source</dt><dd>{login.source ? SOURCES[login.source] ?? login.source : "—"}</dd></div>
        </dl>
      </article>}</For>
    </Show>
    <style>{`
      .quota-note { max-width: 72ch; margin: 0 0 20px; color: var(--text-secondary); font-size: 13px; line-height: 1.6; }
      .quota-login { max-width: 1120px; padding: 16px; margin-bottom: 16px; border: 1px solid var(--border-default); border-radius: 12px; background: var(--bg-surface); }
      .quota-login header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
      .quota-login h2 { margin: 0; color: var(--text-primary); font-size: 16px; font-weight: 600; }
      .quota-login h2 span { margin-left: 8px; color: var(--text-secondary); font-size: 13px; font-weight: 400; overflow-wrap: anywhere; }
      .quota-status { display: flex; gap: 6px; flex-wrap: wrap; }
      .quota-badge { padding: 3px 8px; border: 1px solid var(--border-default); border-radius: 999px; color: var(--text-secondary); font-size: 12px; }
      .quota-badge--warning { color: var(--text-primary); background: color-mix(in srgb, var(--tone-warning, #b7791f) 12%, var(--bg-surface)); }
      .quota-badge--error { color: var(--text-primary); background: color-mix(in srgb, var(--color-danger, #dc2626) 12%, var(--bg-surface)); }
      .quota-login dl { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 20px 24px; margin: 20px 0 0; font-size: 13px; }
      .quota-login dt { color: var(--text-secondary); margin-bottom: 6px; }
      .quota-login dd { margin: 0; color: var(--text-primary); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; line-height: 1.5; }
      .quota-login dd > time, .quota-login dd > span { display: block; }
      .quota-login dd > strong { font-weight: 600; }
      .quota-login dd > time:not(:first-child), .quota-login dd > span { color: var(--text-secondary); font-size: 12px; }
      .quota-login .quota-numbers--stale dd, .quota-login .quota-last-known { color: var(--text-secondary); }
      .quota-login .quota-exhausted { display: inline-block; margin-top: 4px; padding: 2px 6px; border-radius: 4px; color: var(--color-danger, #dc2626); background: color-mix(in srgb, var(--color-danger, #dc2626) 10%, var(--bg-surface)); font-weight: 600; }
      .quota-last-known time { display: block; }
      @media (max-width: 1000px) { .quota-login dl { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
      @media (max-width: 420px) { .quota-login dl { gap: 16px; } .quota-login { padding: 12px; } }
    `}</style>
  </AdminLayout>;
}
