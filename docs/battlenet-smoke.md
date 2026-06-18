# Battle.net end-to-end smoke

The Battle.net OAuth flow can only be exercised against a real Battle.net
client because the OAuth provider doesn't accept loopback redirect URIs
during the consent step. Here's the path I've used during dev.

## Prereqs

1. A Battle.net developer client registered at
   <https://develop.battle.net/access/clients>.
2. Both these redirect URIs registered on that client (Settings → Redirect
   URIs) — the app's built-in Auth.js callback path:
   - `https://raiders.hxxp.io/api/auth/callback/battlenet` (production)
   - `http://localhost:3000/api/auth/callback/battlenet` (dev — Battle.net does
     allow `http://localhost`)
3. `BLIZZARD_CLIENT_ID` and `BLIZZARD_CLIENT_SECRET` set in `.env` (there is no
   redirect-URI env var).

## Smoke steps

1. Boot the dev stack:

   ```bash
   docker compose up -d
   npx prisma migrate deploy
   ```

2. Sign up via the UI (a real email or `phase2-smoke-<ts>@example.com`).
   Use the dev token issuer to verify without SMTP delivery:

   ```bash
   docker compose exec web npx tsx scripts/dev-issue-verify-token.ts \
     verify_email <your-email>
   ```

3. Sign in.

4. On `/profile`, click **Link Battle.net**. You should be redirected to
   <https://us.battle.net/oauth/authorize?...>, see Blizzard's consent
   screen, and on approval be redirected back to
   `http://localhost:3000/api/auth/callback/battlenet?code=...&state=...`, which
   Auth.js handles directly — writing the encrypted OAuth tokens onto `Account`
   and redirecting you to `/profile`.

5. On `/profile`, click **Discover guilds from Battle.net**. This calls
   `api.guild.discoverFromBattlenet`, which:
   - Fetches `/profile/user/wow` with your stored access token.
   - For each character: fetches its summary + guild.
   - Upserts `Character` and `Guild` rows.
   - Calls `applyVerification` to record presence and (if you're rank 0)
     opportunistically GM-auto-claim the guild.

6. Confirm in the DB that the rows materialised:

   ```bash
   docker compose exec postgres psql -U raid_team_stats -d raid_team_stats -c \
     'SELECT id, name, region, "realmSlug", "claimStatus" FROM "Guild";'
   ```

7. Trigger a Tier C manual roster refresh from `/guild/<id>` — it should
   pull the roster, fan out per-character summaries, and populate
   `GuildCharacterLink` rows.

## Common pitfalls

- `state` mismatch on the callback: Auth.js's OAuth state cookie is bound to
  the request origin. If you start the flow on `localhost` and finish on
  `127.0.0.1` (or vice versa), the cookie won't follow and you'll see a
  generic OAuthAccountNotLinked / state-mismatch error. Pick one host and
  stick with it.
- Redirect URI mismatch (Battle.net `400 "callback URL is not valid"`): the URL
  on the Battle.net developer console must be `/api/auth/callback/battlenet`
  exactly, matching scheme + host + port + path.
- Token decrypt failures: if `TOKEN_ENCRYPTION_KEY` changes between linking
  and reading, the Prisma extension returns `null` and the discover flow
  errors out. Either rotate the key with a re-encryption pass or relink.
