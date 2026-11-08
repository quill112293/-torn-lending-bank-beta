# Torn Lending Bank — BETA

Standalone source candidate based on beta.19. Not yet deployed or approved for public release.

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

## Beta.21 remembered sign-in

Successful sign-in saves the Torn API key and bank session on the device, isolated by bank origin. Reopening restores the key for live Torn checks. Expired sessions renew through the normal identity/access checks; logout removes the local key and session and attempts server revocation. Keys are excluded from diagnostics and the bank database. Device storage removal or revoked credentials/access can require sign-in again. Existing installations need one sign-in with this version to save their key. Trade checks still require suitable Torn API permissions.
