# Desktop packaging

`pnpm --filter @yoplai/desktop dist` makes an ad-hoc build in `apps/desktop/release`. It does not use a certificate or the notary service.

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

```sh
pnpm --filter @yoplai/desktop dist:release
```

Find `Yoplai.app` and the disk image (DMG) in `apps/desktop/release/signed`.
The release command signs the app and DMG, submits them to Apple, and staples their tickets.
