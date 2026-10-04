# Personal credentials from Slack

A tool refusal returns one link for the trusted Slack sender and originating thread. It expires after ten minutes, is kept in memory as a token hash, and disappears on gateway restart. Missing Google grants, unusable personal grants, and missing extension tokens all use this flow; existing usable team credentials continue to work.

Sign in if necessary. An unpaired sender sees their Slack identity, logged-in email, credential target, and **Just me** on one combined form. Submitting reuses Slack pairing's fresh email ownership check before starting OAuth or saving tokens. Mismatched/unreadable emails leave both pairing and credentials untouched. Already-paired senders must open the link as their existing owner and have agent access; Google goes directly to provider consent, while token forms require one submit. Completion posts “You're connected, try again” to the original thread, bounded to five seconds; delivery failures do not undo the credential. No automatic retry is performed.

## Friction budget

Counted after clicking the Slack link, with an existing web session:

| Sender / credential | Platform screens | Platform clicks | Additional provider work |
| --- | --- | --- | --- |
| Unpaired / Google | 1 combined confirmation | 1 | Google account/consent screens and clicks |
| Paired / Google or reconnect | 0 | 0 | Google account/consent screens and clicks |
| Unpaired or paired / token | 1 token form | 1 submit | Enter token |

Without a web session, the link redirects directly to sign-in with the original flow as its return path; no intermediate sign-in landing click is added. Sign-in is additionally required. Actual provider screens depend on existing provider sessions and consent. Pairing still requires equal Slack/Yoplai emails; Sign in with Slack remains future work.

## Extension-owned OAuth hook

MCP OAuth is implemented by the extensions repository, not this platform slice. An extension can register its start step through `@yoplai/shared`:

```ts
const unregister = registerCredentialOAuthConnector("mcp", async ({ agentId, userId, targetId, onComplete }) => {
  // targetId is the extension-defined server ID captured when the Slack link was issued.
  // Bind agentId, userId, and targetId into expiring CSRF/PKCE state.
  return startPersonalAuthorization({ agentId, userId, targetId, onComplete });
});
```

A refusing tool requests the same Slack link with:

```ts
const link = await requestCredentialConnectLink(toolContext, {
  kind: "extension-oauth", extensionId: "mcp", targetId: server.id,
});
```

At the extension's OAuth callback, load and verify the saved state, then persist the grant for its personal owner and resource before completing:

```ts
await savePersonalGrant(savedState.agentId, savedState.userId, savedState.targetId, tokens);
await savedState.onComplete(savedState.targetId);
```

The extension must resolve `server.id` from its trusted server configuration; the model, browser, URL query, form body, or link opener must not choose it. The platform snapshots the required `targetId` with `extensionId` at link issuance. A different completion ID is rejected without confirming the Slack flow. `undefined` from `requestCredentialConnectLink` means there is no active Slack flow; preserve the extension's normal connect route. The hook starts only after login, agent access, owner verification, and pairing redemption when necessary. Do not invoke completion on denial/error, or accept a callback-selected user, resource, or scope. Bound external network work and maintain your own state expiry/replay protection; call `unregister` when stopping. Completion is idempotent and Slack delivery is bounded. `ctx.credentialConnect` is a trusted host service, not an authenticated HTTP endpoint.
