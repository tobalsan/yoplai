import { For, Show, createEffect, createResource, onCleanup } from "solid-js";
import { fetchModelQuota, type ModelQuota, type QuotaLogin } from "../../api/model-quota";
import { capabilities } from "../../lib/capabilities";
import { isSuperadmin } from "../../lib/roles";
import { Button } from "../../components/ui/Button";
import { ProgressBar } from "../../components/ui/ProgressBar";
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
function resetText(seconds: number) {
  if (seconds <= 0) return "Reset due";
  if (seconds < 60) return "Resets in <1m";
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 1440) return `Resets in ${Math.floor(minutes / 1440)}d ${Math.floor(minutes / 60) % 24}h`;
  return `Resets in ${minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`}`;
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
  const reset = (time: number) => <time title={absolute(time)} dateTime={new Date(time * 1000).toISOString()}>{resetText(time - data()!.generatedAt)}</time>;
  const window = (value: QuotaLogin["weekly"], label: string, stale: boolean, exhausted = false) => <div class="quota-window">
    <div class="quota-window-label">{label}{value && reset(value.resetAt)}</div>
    <Show when={value} fallback={<span>—</span>}>{(reading) => <>
      <ProgressBar percent={reading().usedPercent} label={label} dimmed={stale} tone={exhausted || reading().usedPercent >= 90 ? "critical" : reading().usedPercent >= 75 ? "warning" : "normal"} />
      <div class="quota-window-value"><strong>{Math.round(reading().usedPercent)}% used</strong><Show when={exhausted}><span class="quota-exhausted">Exhausted</span></Show></div>
    </>}</Show>
  </div>;
  return <AdminLayout title="Quota" description="Subscription usage on this host.">
    <Show when={permitted()} fallback={<p role="alert">Superadmin access required.</p>}>
      <Show when={result.latest?.error}><p role="alert">{result.latest?.error} <Button disabled={result.loading} onClick={() => void refetch()}>Retry</Button></p></Show>
      <Show when={result.loading && !result.latest}><p role="status">Loading quota…</p></Show>
      <Show when={data()?.logins.length === 0}><p>No quota readings yet.</p><Show when={!data()?.pollingEnabled}><p>Enable <code>modelQuota.enabled</code> in configuration to poll subscription usage.</p></Show></Show>
      <p class="quota-note">Claude updates after each call. ChatGPT readings can be up to 5–10 minutes old. This page refreshes local readings every 20 seconds.</p>
      <For each={data()?.logins}>{(login) => <article class="quota-login">
        <header><h2>{login.provider === "anthropic" ? "Claude" : login.provider === "openai-codex" ? "ChatGPT" : login.provider}{login.plan ? ` · ${login.plan}` : ""} <span>{login.accountRef}</span></h2><div class="quota-status"><Show when={login.stale}><span class="quota-badge quota-badge--warning">Stale</span></Show><Show when={login.error}><span class="quota-badge quota-badge--error">Error: {login.error}</span></Show><Show when={!login.stale && !login.error}><span class="quota-badge">Fresh</span></Show></div></header>
        <div class="quota-numbers" classList={{ "quota-numbers--stale": login.stale }}>
          {login.fiveHourState === "absent" ? <div class="quota-window"><div class="quota-window-label">5-hour window</div><span>none</span></div> : login.fiveHourState === "unknown" ? <div class="quota-window"><div class="quota-window-label">5-hour window<Show when={login.fiveHour}>{(reading) => reset(reading().resetAt)}</Show></div><div>—<Show when={login.fiveHour}>{(reading) => <span class="quota-last-known">Last known: {Math.round(reading().usedPercent)}% used</span>}</Show></div></div> : window(login.fiveHour, "5-hour window", login.stale, login.fiveHourState === "exhausted")}
          <div>{window(login.weekly, "Weekly window", login.stale)}<Show when={login.weekly}><p class="quota-pace">Pace {login.weeklyPace === null ? "—" : `${login.weeklyPace.toFixed(2)}×`}</p></Show></div>
        </div>
        <footer class="quota-footer">Updated {login.updatedAt === null ? "—" : <><time dateTime={new Date(login.updatedAt * 1000).toISOString()}>{absolute(login.updatedAt)}</time> ({relative(login.updatedAt - data()!.generatedAt)})</>} · Source: {login.source ? SOURCES[login.source] ?? login.source : "—"}</footer>
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
      .quota-numbers { display: flex; flex-direction: column; gap: 20px; margin-top: 20px; color: var(--text-primary); font-size: 13px; line-height: 1.5; font-variant-numeric: tabular-nums; }
      .quota-window { display: grid; grid-template-columns: 160px minmax(0, 1fr) 100px; gap: 16px; align-items: center; }
      .quota-window-label time { display: block; color: var(--text-secondary); font-size: 12px; }
      .quota-window-value { text-align: right; }
      .quota-window-value strong { font-weight: 600; white-space: nowrap; }
      .quota-pace { margin: 4px 0 0 176px; color: var(--text-secondary); font-size: 12px; }
      .quota-footer { margin-top: 20px; color: var(--text-secondary); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
      .quota-numbers--stale, .quota-last-known { color: var(--text-secondary); }
      .quota-last-known { display: block; }
      .quota-login .quota-exhausted { display: inline-block; margin-top: 4px; padding: 2px 6px; border-radius: 4px; color: var(--color-danger, #dc2626); background: color-mix(in srgb, var(--color-danger, #dc2626) 10%, var(--bg-surface)); font-weight: 600; }
      @media (max-width: 600px) {
        .quota-window { grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; }
        .quota-window .ui-progress { grid-column: 1; grid-row: 2; }
        .quota-window-value { grid-column: 2; grid-row: 2; }
        .quota-pace { margin-left: 0; }
      }
    `}</style>
  </AdminLayout>;
}
