# Making the installer a trusted program (removing the Windows warning)

Windows shows **"Windows protected your PC" (SmartScreen)** / **"unknown
publisher"** because the MSI and the bundled `rts-companion.exe` are not
**Authenticode code-signed**. It's a *reputation/identity* warning, not a
malware detection. The only legitimate fix is to sign the binaries with a
code-signing certificate from a CA Windows trusts. Self-signed certs do
**not** work for public distribution (they'd have to be manually trusted on
every PC).

## Options (cheapest → most expensive), pick one

1. **Azure Artifact Signing (recommended — wired into CI)** — Microsoft's
   own signing service (formerly "Trusted Signing"), ~US$9.99/month. Identity
   validated once (individual or business). Signatures get **immediate
   SmartScreen trust** (no slow reputation build). No hardware token. This
   repo's release workflow signs the exe + MSI with it automatically once
   configured (see "A." below). Best cost/UX for a self-hosted indie tool.
2. **EV (Extended Validation) code-signing certificate** — ~US$250–700/yr
   (DigiCert, Sectigo, SSL.com…). Immediate SmartScreen trust. Requires a
   FIPS hardware token or cloud HSM; stricter org validation.
3. **OV (Organization Validation) certificate** — ~US$200–400/yr. Cheaper,
   but SmartScreen reputation **builds over time/downloads** — users may
   still see the warning for a while after launch.

In all cases: sign **both** `rts-companion.exe` (its original Node
signature is invalidated by the SEA injection) **and** the final `.msi`,
and **timestamp** the signature (so it stays valid after the cert expires).

## A. Azure Artifact Signing in CI (recommended — already wired)

`.github/workflows/installer-release.yml` signs **both** the exe (before WiX
embeds it into the MSI) and the MSI using the official
`Azure/artifact-signing-action`. It activates automatically when you set, under
the repo's **Settings → Secrets and variables → Actions**:

- **Variables:** `AZURE_SIGNING_ENDPOINT` (region URI, e.g.
  `https://eus.codesigning.azure.net/`), `AZURE_SIGNING_ACCOUNT` (the
  `codeSigningAccounts` resource name — *not* the app-registration name), and
  `AZURE_SIGNING_PROFILE` (the certificate profile name).
- **Secrets:** `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` — a service principal
  (app registration) granted the **Artifact Signing Certificate Profile
  Signer** role on the account.

Auth is **OIDC (no client secret)**: give the app registration a GitHub
**federated credential** for the subject
`repo:<owner>/<repo>:environment:release`, and create a GitHub **environment**
named `release` (the job runs in it so the OIDC subject matches). Signing +
timestamping then happen on every `vX.Y.Z` tag (and on a `workflow_dispatch`
smoke run, without publishing). If the variables are absent, the build still
succeeds **unsigned**.

## B. Local certificate via signtool (alternative)

For a locally signed build, set these before running `installer/build.ps1`
(its `Invoke-Sign` uses `signtool`):

- Cert in the Windows store: `RTS_SIGN_THUMBPRINT=<sha1 thumbprint>`
- …or a PFX file: `RTS_SIGN_PFX=C:\path\cert.pfx` and `RTS_SIGN_PFX_PW=...`
- Optional timestamp URL: `RTS_SIGN_TS=http://timestamp.digicert.com`

`signtool.exe` from the Windows SDK must be on PATH (the script also probes
the default SDK location). Without any of these env vars (and outside the
Azure-signed CI path) the build produces an **unsigned** installer.

## Interim (no cert yet)

Until signing is in place, the Account page tells users the warning is
expected and to choose **More info → Run anyway**. This is safe; it's the
standard unsigned-app flow. Prioritize Azure Artifact Signing to remove it.
