# Desktop packaging

`pnpm --filter @yoplai/desktop dist` makes an ad-hoc build in `apps/desktop/release`. It does not use a certificate or the notary service.

The desktop build uses pnpm copy mode to prevent a second gateway store. It prunes unused package files and keeps the runtime assets and license files. It checks the assets in the stage and in the app. Electron keeps English and French locales.

## Set up a release Mac

1. In Keychain Access, create a certificate signing request (CSR) with Certificate Assistant.
2. Use the CSR to request a Developer ID Application certificate in the Apple Developer portal.
3. Install the certificate and the Developer ID G2 CA intermediate certificate in Keychain Access.
4. Create an app-specific password in your Apple Account.
5. Store a notarytool profile with the command below. Enter the app-specific password at the prompt.

```sh
xcrun notarytool store-credentials yoplai-notary --apple-id '<Apple Account>' --team-id '<Team ID>'
```

## Build a release

Get the SHA-1 fingerprint of the Developer ID Application certificate with `security find-identity -v -p codesigning`.
Set `YOPLAI_MAC_IDENTITY` to that fingerprint.
Set `APPLE_KEYCHAIN_PROFILE` to the profile name.
If `apps/desktop/electron-builder.env` exists, move it before you build a release.

```sh
pnpm --filter @yoplai/desktop dist:release
```

Find `Yoplai.app` and the disk image (DMG) in `apps/desktop/release/signed`.
The release command signs the app and DMG, submits them to Apple, and staples their tickets. It also runs `scripts/packaged-check.mjs` on the signed app: SQLite, offline OCR, text extraction, canvas assets and catalog install through the UI port.

To run the check by hand, use `node apps/desktop/scripts/packaged-check.mjs <app> [reference-app]`. Add a reference app only to compare startup timings.

## Run the desktop app from source

`pnpm desktop` uses `~/.yoplai` by default. To use a different home, set `YOPLAI_HOME` on the same line:

```sh
YOPLAI_HOME='~/some/dir' pnpm desktop
```

The desktop app expands a leading `~`. The gateway keeps your `HOME` so it can find your Codex CLI and Claude Code logins. On macOS, Claude Code uses the Keychain. The desktop app asks for consent before it reads the login.

Use `pnpm desktop --fresh` or `YOPLAI_DESKTOP_FRESH=1 pnpm desktop` for a new temporary home. Set `YOPLAI_DESKTOP_DEV_PARENT` to select its parent folder. Fresh mode uses a temporary `HOME` and does not use the Keychain. Each home has separate Electron storage.

**CAUTION:** Do not run a second gateway on the same home. Both gateways can write to the same state files.

The desktop seed creates a config only if neither `yoplai.json` nor `aihub.json` exists. It adds `OAUTH_ENCRYPTION_KEY` to `.env` only if both the shell and the file lack the key. The seed does not change agent or session files. If the config lacks agent discovery rules or a usable `oauth.encryptionKey`, the desktop app warns but does not change the config.

The gateway makes separate writes at start. The dashboard registry migration writes `canvas/schema.json` and can update `canvas/registry.json`. The gateway also resets `run/active-turns.json` to an empty turn list.
