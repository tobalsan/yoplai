import { Match, Show, Switch, untrack, type Accessor, type JSX } from "solid-js";
import { gatewayKey, type GatewayName } from "../api/gateway";
import { useRequester, type Requester } from "./requester";

/** A failed read of the capabilities of a gateway. The page offers one Retry that reads them again. */
export function RequesterFailure(props: { requester: Accessor<Requester>; class?: string; children: JSX.Element }) {
  return (
    <p class={props.class} role="alert">
      {props.children} <button type="button" onClick={() => props.requester().retry()}>Retry</button>
    </p>
  );
}

/**
 * One visit of a page: one gateway, one identity (agent, job, run, ...), and the requester of that gateway.
 * The content mounts again for each new gateway or identity, so no row, draft, or attempt of an earlier visit
 * stays on screen. Until the requester is known the visit shows `pending`. When the capabilities could not be
 * read it shows `failure` with a Retry, and never reports that a right is missing. A local visit has nothing
 * to read and shows its content at once. `resolved` is false while the page still looks up its gateway; the
 * page then shows its own status and the visit shows nothing.
 */
export function PageVisit(props: {
  gateway: Accessor<GatewayName>;
  identity: Accessor<string[]>;
  resolved?: Accessor<boolean>;
  pending: string;
  failure: string;
  children: (visit: { gateway: GatewayName; requester: Accessor<Requester> }) => JSX.Element;
}) {
  const requester = useRequester(props.gateway);
  const key = () => (props.resolved?.() === false ? undefined : gatewayKey(props.gateway(), ...props.identity()));
  const known = () => requester().gateway === undefined || requester().ready;
  return (
    <Show when={key()} keyed>
      {(_visit) => {
        const gateway = untrack(props.gateway);
        return (
          <Switch>
            <Match when={!known()}><p role="status">{props.pending}</p></Match>
            <Match when={requester().unknown}><RequesterFailure requester={requester}>{props.failure}</RequesterFailure></Match>
            <Match when={true}>{untrack(() => props.children({ gateway, requester }))}</Match>
          </Switch>
        );
      }}
    </Show>
  );
}
