# Operator setup: Google Drive OAuth

This guide is for the **operator** running a Yoplai deployment. It walks through
standing up your own Google OAuth client so agents can connect Google Drive
(read-only), and configuring Yoplai to use it — including the **token-at-rest
encryption key**.

Every deployment uses **its own** Google OAuth client and **its own** redirect
URIs (see [Redirect URIs are per-deployment](#redirect-uris-are-per-deployment)).
There is no shared Yoplai Google app; you bring your own (BYO client).

---

## Overview

1. [Enable the Google Drive API](#1-enable-the-google-drive-api) in a GCP project.
2. [Configure the OAuth consent screen](#2-configure-the-oauth-consent-screen) with the Drive **read-only** scope.
3. [Create an OAuth client and register your callback URL](#3-create-an-oauth-client-id-and-register-your-callback-url).
4. [Configure Yoplai](#4-configure-yoplai) with the client ID/secret and the redirect base URL.
5. [Set the token encryption key](#5-set-the-token-at-rest-encryption-key) so tokens are encrypted at rest.
6. [Connect from the UI](#6-connect-from-the-ui) and verify.

---

## 1. Enable the Google Drive API

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and select
   (or create) a **project** for this deployment.
2. Go to **APIs & Services → Library**.
3. Search for **Google Drive API** and click **Enable**.

Only the Drive API is required for the read-only Drive consumer. Enabling more
APIs is unnecessary and widens the blast radius of a leaked grant.

---

## 2. Configure the OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**.
2. Choose a **User Type**:
   - **Internal** — only Google Workspace users in your org can connect. Simplest
     if this deployment serves a single org.
   - **External** — anyone with a Google account can connect. While the app is in
     **Testing**, only accounts you add under **Test users** can connect; move to
     **In production** (may require Google verification for sensitive scopes) to
     allow anyone.
3. Fill in the required app info (app name, support email, developer contact).
4. Under **Scopes**, click **Add or remove scopes** and add **only** the
   read-only Drive scope:

   ```
   https://www.googleapis.com/auth/drive.readonly
   ```

   Do **not** add broad Drive scopes (`.../auth/drive`) — read-only is all the
   Drive consumer needs, and requesting less keeps user consent (and Google
   verification) simpler.
5. Save.

---

## 3. Create an OAuth client ID and register your callback URL

1. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. **Application type:** **Web application**.
3. Under **Authorized redirect URIs**, add **your deployment's callback URL**:

   ```
   https://<your-deployment-domain>/api/oauth/google/callback
   ```

   The path is fixed (`/api/oauth/<provider>/callback`); the host is **yours**.
   Examples:

   | Deployment | Redirect URI |
   | --- | --- |
   | Local dev | `http://localhost:4000/api/oauth/google/callback` |
   | Staging | `https://yoplai-staging.example.com/api/oauth/google/callback` |
   | Production | `https://yoplai.example.com/api/oauth/google/callback` |

   Add every environment you connect from. The redirect URI Google receives must
   **exactly** match one registered here (scheme, host, port, path), or the
   consent flow fails with `redirect_uri_mismatch`.
4. Click **Create** and copy the **Client ID** and **Client secret**.

### Redirect URIs are per-deployment

The redirect/callback URL is tied to **your own domain**, not to Yoplai. Each
deployment (local, staging, production) has a **different** callback host and
must register its own redirect URI in **your** Google OAuth client. Do not expect
a shared or default URL — if you move domains or add an environment, register the
new URI in the Google client first.

Yoplai builds the callback URL from `oauth.redirectBaseUrl` (below); make sure it
matches, byte-for-byte, a redirect URI you registered here.

---

## 4. Configure Yoplai

Set the OAuth client and redirect base URL in your instance config
(`yoplai.json` under `$YOPLAI_HOME`). Secrets should be `$env:` refs so they live
in `$YOPLAI_HOME/.env`, not in the JSON:

```jsonc
{
  "oauth": {
    // Public base URL of THIS deployment. Yoplai appends
    // /api/oauth/<provider>/callback to build the redirect URI, which must
    // match a URI you registered in the Google client above.
    "redirectBaseUrl": "https://yoplai.example.com",

    "providers": {
      "google": {
        "clientId": "$env:GOOGLE_CLIENT_ID",
        "clientSecret": "$env:GOOGLE_CLIENT_SECRET"
      }
    },

    // See section 5.
    "encryptionKey": "$env:OAUTH_ENCRYPTION_KEY"
  }
}
```

Then set the secrets in `$YOPLAI_HOME/.env`:

```dotenv
GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxxxxxx
```

`$env:` refs are resolved by the host at runtime; the literal values never need
to appear in `yoplai.json`.

---

## 5. Set the token-at-rest encryption key

OAuth access and refresh tokens are **live credentials**: a leaked token row is a
working Google grant until it is revoked. Yoplai therefore **encrypts token fields
at rest** (AES-256-GCM) before persisting them to the connection store under
`$YOPLAI_HOME/oauth/`. The encryption secret comes from `oauth.encryptionKey`.

Generate a strong secret (32+ bytes of entropy):

```bash
openssl rand -base64 32
```

Store it in `$YOPLAI_HOME/.env` and reference it from config as shown above:

```dotenv
OAUTH_ENCRYPTION_KEY=<output of openssl rand -base64 32>
```

Notes:

- **Key source.** The secret is read from instance config/env only. Yoplai never
  hardcodes or generates a persistent key for you.
- **Key required to connect (fail closed).** If `oauth.encryptionKey` is unset,
  the store **refuses to persist tokens** rather than writing them in plaintext:
  the gateway logs a warning at startup and any attempt to connect a new account
  fails with an error telling you to set the key. Plaintext token rows are never
  created. (Existing legacy plaintext rows from older builds are still read and
  are re-encrypted on the next save.) **Set a key before connecting any account.**
- **Rotation.** Changing the key makes previously stored tokens unreadable;
  affected agents simply reconnect (the connect flow re-issues tokens). There is
  no plaintext fallback that would leak the old tokens.
- **Backups.** Because token rows are ciphertext, a leaked backup of
  `$YOPLAI_HOME/oauth/` does not expose usable tokens **unless** the encryption key
  leaks too. Keep the key out of the same backup.

---

## 6. Connect from the UI

1. Start (or restart) the gateway so it picks up the config and `.env`.
2. Open **`/connections`** in the web UI.
3. Click **Connect** next to Google. You are redirected to Google's consent
   screen requesting Drive read-only access.
4. Approve. Google redirects back to your callback URL; Yoplai exchanges the code,
   stores the (encrypted) tokens, and shows **Connected as `<your-account>`**.

To verify tokens are encrypted at rest, inspect a stored row:

```bash
cat "$YOPLAI_HOME/oauth/main__google.json"
```

The `accessToken` and `refreshToken` fields are `enc:v2:...` envelopes, not
readable tokens.

---

## Troubleshooting

- **`redirect_uri_mismatch`** — the redirect URI Yoplai sent does not exactly
  match one registered in the Google client. Confirm `oauth.redirectBaseUrl`
  matches your registered URI (scheme/host/port), and that the environment you
  are connecting from is registered.
- **`access_denied` / stuck in Testing** — for an **External** consent screen in
  Testing, add the connecting account under **Test users**, or publish the app.
- **No refresh token / re-consent every time** — Yoplai requests
  `access_type=offline` and `prompt=consent` for Google, so a refresh token is
  issued on first consent. If you revoked access, disconnect and reconnect.
- **Connect fails / startup warning about `oauth.encryptionKey`** — the key is
  unset, so the store fails closed and will not persist tokens. Set
  `oauth.encryptionKey` (section 5) and restart, then connect.
