# Torn Lending Bank — BETA

Standalone beta bank. This beta.24 source update keeps bank and banker availability in the signed-in welcome lobby and retains sign-in without a time limit; deployment is tracked separately from source validation.

## Setup

1. Create a NEW Cloudflare D1 database named `torn-lending-bank-beta`. Never reuse the original bank or the other installation's ID.
2. Run `node scripts/configure.mjs DATABASE_ID` and commit wrangler.jsonc.
3. Connect this repository to a NEW Cloudflare Worker named `torn-lending-bank-beta`. Build command: `npm run build`. Deploy command: `npm run deploy`.
4. Confirm the deployed address is `https://torn-lending-bank-beta.975y7srs57.workers.dev`. If different, update scripts/build.mjs BANK_ORIGIN default and rebuild downloads.
5. Test login, invites, applications, collateral and resets before sharing. Public release requires owner approval of tested code.

## Isolation

Repository: `quill112293/-torn-lending-bank-beta`. Dedicated Worker, D1, membership, sessions, script namespace, update links and UI storage. No bank environment switch. No original bank data migrated. The original service is unchanged.

Application/status/history features are preserved. Legacy test-record helpers remain for compatibility; participant test controls and Live/TEST selectors are removed from the primary interface. Testing takes place in the separate BETA installation. Transfers still use real Torn money; resetting data cannot reverse them.

Promote approved code deliberately. Never copy bindings, origins, update links or database records between installations. Both new databases must start empty.

## Verification

Run `npm run build` then `npm test`. Deployment is blocked until a new database ID is configured. The old database ID is explicitly rejected.

## Beta.22 sign-in until logout

New sign-ins have no time limit. The server stores a token digest with `expires_at = 0`, an explicit no-expiry value; daily cleanup removes only expired legacy timed sessions. Signing in on another device does not revoke existing sessions. Connections → Log out removes this device's saved key and session and revokes its token on the server when connected. Access removal still blocks existing sessions immediately.

Successful sign-in saves the Torn API key and bank session on the device, isolated by bank origin. Closing the panel, reloading Torn, and restarting Torn PDA restore the same session and key. Keys are excluded from diagnostics and the bank database. Trade checks still require a valid key with suitable Torn API permissions. Clearing device storage removes the saved login.

Update the beta Worker and install the beta.22 userscript, then sign in once to create a session without expiry. Legacy timed sessions remain supported during the update; a saved key can renew them. No database migration is required. If logout cannot reach the server, local credentials are still removed and a connection warning explains that server revocation was not confirmed.

## Beta.23 welcome lobby

Welcome lobby is the first tab after a new or restored sign-in for borrowers and bankers. It shows the bank's online/offline status and each enabled banker's name, role, Torn ID, and staff-set availability. It uses the existing authenticated bank refresh; no public status endpoint or additional data exposure is introduced. The Overview tab remains available from the lobby and navigation. Remembered sign-in is unchanged.

## Beta.24 overview cleanup

Removed the duplicate bank status and staff availability section from Overview. The Welcome lobby retains these details. Overview continues to show account summaries, application and loan search, and loan activity.
