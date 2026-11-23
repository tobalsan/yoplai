import { createMemo, createSignal, For, Show } from "solid-js";
import { useSession } from "../auth/client";
import { GatewaySelect } from "../components/GatewaySelect";
import { SlackPairingsSection } from "./SlackPairingsSection";
import { SurfaceLinksSection } from "./SurfaceLinksSection";
import { missingGatewayText, useGatewayChoice } from "../lib/gateway-choice";
import { useRequester } from "../lib/requester";
import type { GatewayName } from "../api/gateway";

/**
 * Pairings of the local account, or of the account that the linked bearer names on one linked gateway
 * (`?gateway=<name>`). The view below mounts again for each gateway, so every list, error, and unpair attempt belongs
 * to one visit. A gateway that is not configured makes no call and never means Local.
 */
export function AccountConnections() {
  const choice = useGatewayChoice();
  const visitKey = createMemo(() => (choice.ready() ? JSON.stringify([choice.gateway() ?? null]) : undefined));
  const missing = () => { const selection = choice.selection(); return selection.state === "missing" ? selection : undefined; };
  return (
    <>
      <main class="account-connections">
        <style>{ACCOUNT_CONNECTIONS_STYLES}</style>
        <h1>Pairings</h1>
        <GatewaySelect value={choice.chosen()} names={choice.names()} onChange={choice.choose} />
        <Show when={missing()}>{(selection) => <p role="alert" class="account-connections-error">{missingGatewayText(selection())}</p>}</Show>
        <Show when={choice.selection().state === "loading"}><p role="status">Loading linked gateways…</p></Show>
        <Show when={visitKey()} keyed>{(_visit) => <PairingsView gateway={choice.gateway()} />}</Show>
      </main>
    </>
  );
}

/** The channel sections of the page, in order. A new channel adds its own section component here. */
const PAIRING_SECTIONS = [SlackPairingsSection, SurfaceLinksSection];

function PairingsView(props: { gateway?: GatewayName }) {
  // One view is one visit: the gateway is fixed for its life. On Local the owner is the signed-in user. On a linked
  // gateway the owner is the account of the linked bearer, which the remote capabilities name.
  const gateway = props.gateway;
  const session = useSession();
  const requester = useRequester(() => gateway);
  const ownerId = () => (gateway === undefined ? session().data?.user?.id : requester().user?.id);
  // Sections that said "not available". When all of them said it, the page has nothing to list.
  const [hidden, setHidden] = createSignal<number[]>([]);
  const markAvailable = (index: number, available: boolean) =>
    setHidden((current) => (available ? current.filter((item) => item !== index) : current.includes(index) ? current : [...current, index]));
  const allHidden = () => hidden().length === PAIRING_SECTIONS.length;
  // A gateway with no multi-user sign-in has no account that could hold a pairing. That is a fact, not a failure.
  const noSignIn = () => {
    if (ownerId()) return false;
    if (gateway === undefined) return !session().isPending && !requester().multiUser;
    return requester().ready && !requester().unknown;
  };
  const remoteFailure = () => gateway !== undefined && requester().ready && requester().unknown;

  return (
    <>
      <p>Manage the accounts linked to {gateway === undefined ? "your Yoplai account" : `your account on ${gateway}`}.</p>
      <Show when={remoteFailure()}><p role="alert" class="account-connections-error">Could not read the account of the remote gateway. <button type="button" onClick={() => requester().retry()}>Retry</button></p></Show>
      <Show when={noSignIn()}><p role="status">No pairings on this gateway. It has no multi-user sign-in.</p></Show>
      <Show when={gateway === undefined && !ownerId() && !noSignIn() && !session().isPending}><p role="status">Sign in to manage pairings.</p></Show>
      <Show when={ownerId() && allHidden()}><p role="status">No pairings on this gateway.</p></Show>
      <Show when={ownerId()}>
        <For each={PAIRING_SECTIONS}>{(Section, index) => (
          <Section gateway={gateway} ownerId={ownerId} onAvailable={(available) => markAvailable(index(), available)} />
        )}</For>
      </Show>
    </>
  );
}

const ACCOUNT_CONNECTIONS_STYLES = `
  .account-connections { max-width: 720px; margin: 0 auto; padding: 32px 24px; }
  .account-connections h1 { margin: 0 0 6px; color: var(--text-primary); font-size: 22px; }
  .account-connections > p, .account-connections p { margin: 0 0 22px; color: var(--text-secondary); font-size: 14px; }
  .account-pairing-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
  .account-pairing { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 14px; border: 1px solid var(--border-default); border-radius: 10px; background: var(--bg-surface); }
  .account-pairing strong, .account-pairing span { display: block; }
  .account-pairing strong { color: var(--text-primary); font-size: 14px; }
  .account-pairing span { margin-top: 4px; color: var(--text-secondary); font-size: 12px; }
  .account-pairing button { border: 1px solid var(--border-default); border-radius: 7px; padding: 7px 10px; background: transparent; color: var(--text-primary); cursor: pointer; }
  .account-pairing button:disabled { opacity: .55; cursor: default; }
  .pairing-section { margin-top: 24px; }
  .pairing-section h2 { margin: 0 0 10px; color: var(--text-primary); font-size: 16px; }
  .surface-account-links .account-pairing > div { min-width: 0; overflow-wrap: anywhere; }
  .surface-account-links button { flex-shrink: 0; min-height: 40px; }
  .account-connections-error { color: var(--tone-error, #e55) !important; }
  @media (max-width: 768px) { .account-connections { padding-top: 64px; } }
`;
