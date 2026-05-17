# Making the installer a trusted program (removing the Windows warning)

Windows shows **"Windows protected your PC" (SmartScreen)** / **"unknown
publisher"** because the MSI and the bundled `rts-companion.exe` are not
**Authenticode code-signed**. It's a *reputation/identity* warning, not a
malware detection. The only legitimate fix is to sign the binaries with a
code-signing certificate from a CA Windows trusts. Self-signed certs do
**not** work for public distribution (they'd have to be manually trusted on
every PC).

## Options (cheapest → most expensive), pick one

1. **Azure Trusted Signing (recommended for this project)** — Microsoft's
   own signing service, ~US$9.99/month. Identity validated once (individual
   or business). Signatures get **immediate SmartScreen trust** (no slow
   reputation build). No hardware token. Integrates with `signtool` /
   `dotnet sign`. Best cost/UX for a self-hosted indie tool.
2. **EV (Extended Validation) code-signing certificate** — ~US$250–700/yr
   (DigiCert, Sectigo, SSL.com…). Immediate SmartScreen trust. Requires a
   FIPS hardware token or cloud HSM; stricter org validation.
3. **OV (Organization Validation) certificate** — ~US$200–400/yr. Cheaper,
   but SmartScreen reputation **builds over time/downloads** — users may
   still see the warning for a while after launch.

In all cases: sign **both** `rts-companion.exe` (its original Node
signature is invalidated by the SEA injection) **and** the final `.msi`,
and **timestamp** the signature (so it stays valid after the cert expires).

## Once you have a certificate

The build script already does the signing — just set, before running
`installer/build.ps1`:

- Cert in the Windows store: `RTS_SIGN_THUMBPRINT=<sha1 thumbprint>`
- …or a PFX file: `RTS_SIGN_PFX=C:\path\cert.pfx` and `RTS_SIGN_PFX_PW=...`
- Optional timestamp URL: `RTS_SIGN_TS=http://timestamp.digicert.com`

(For Azure Trusted Signing, use its `signtool` dlib per Microsoft's docs;
the script's `signtool sign` invocation is compatible — point
`RTS_SIGN_THUMBPRINT` at the ATS cert or adapt the `Invoke-Sign` args.)

`signtool.exe` from the Windows SDK must be on PATH (the script also probes
the default SDK location). Without any of these env vars the build still
succeeds and produces an **unsigned** installer (current state).

## Interim (no cert yet)

Until signing is in place, the Account page tells users the warning is
expected and to choose **More info → Run anyway**. This is safe; it's the
standard unsigned-app flow. Prioritize Azure Trusted Signing to remove it.
