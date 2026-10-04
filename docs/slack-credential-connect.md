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
const unregister = registerCredentialOAuthConnector("my-extension", async ({ agentId, userId, onComplete }) => {
  // Create CSRF/PKCE state bound to agentId + personal userId.
  // Retain onComplete in that pending state; return your provider authorization URL.
  return startPersonalAuthorization({ agentId, userId, onComplete });
});
```

A refusing tool requests the same Slack link with:

```ts
const link = await requestCredentialConnectLink(toolContext, {
  kind: "extension-oauth", extensionId: "my-extension",
});
```

The tool context must be the host's trusted call context, not model-selected identity. `undefined` means there is no active Slack flow; preserve the extension's normal connect route. The hook starts only after login, agent access, owner verification, and pairing redemption when necessary. Persist only a verified **personal** grant for the supplied `agentId`/`userId`; invoke `onComplete` only after successful persistence. Do not invoke it on denial/error, and do not accept a callback-selected user or scope. Bound external network work and maintain your own state expiry/replay protection; call `unregister` when stopping. Completion is idempotent and Slack delivery is bounded. `ctx.credentialConnect` is a trusted host service, not an authenticated HTTP endpoint.
