# Torn Lending Bank — BETA

Standalone beta bank. Beta.36 adds lender-reviewed PI payment collateral for users with the saved Private Island status. The lender opens on Overview, borrowers retain Welcome lobby, and sign-in lasts until logout; deployment is tracked separately from source validation.

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

New sign-ins have no time limit. The server stores a token digest with `expires_at = 0`, an explicit no-expiry value; scheduled cleanup removes only expired legacy timed sessions. Signing in on another device does not revoke existing sessions. Connections → Log out removes this device's saved key and session and revokes its token on the server when connected. Access removal still blocks existing sessions immediately.

Successful sign-in saves the Torn API key and bank session on the device, isolated by bank origin. Closing the panel, reloading Torn, and restarting Torn PDA restore the same session and key. Keys are excluded from diagnostics and the bank database. Trade checks still require a valid key with suitable Torn API permissions. Clearing device storage removes the saved login.

Update the beta Worker and install the beta.22 userscript, then sign in once to create a session without expiry. Legacy timed sessions remain supported during the update; a saved key can renew them. No database migration is required. If logout cannot reach the server, local credentials are still removed and a connection warning explains that server revocation was not confirmed.

## Beta.23 welcome lobby

Welcome lobby is the first tab after a new or restored sign-in for borrowers and bankers. It shows the bank's online/offline status and each enabled banker's name, role, Torn ID, and staff-set availability. It uses the existing authenticated bank refresh; no public status endpoint or additional data exposure is introduced. The Overview tab remains available from the lobby and navigation. Remembered sign-in is unchanged.

## Beta.24 overview cleanup

Removed the duplicate bank status and staff availability section from Overview. The Welcome lobby retains these details. Overview continues to show account summaries, application and loan search, and loan activity.

Beta.25 removes duplicate application notices when eligibility checks and saved review reasons contain the same message.

Beta.26 simplifies history filters to Activity and Search (plus User in the full history view), removing date-range and Live/TEST selectors. Mobile filters use full-width stacked fields.

Beta.27 groups history into Applications, Loans, Comments & notes, Payments, Collateral, Extensions, User status & restrictions, Funding & transfers, Bank & staff, and Other activity. Category filters apply consistently to the list, export, and selected-history clearing.

Beta.28 removes the separate History navigation tab. Per-user history, categories, search and exports remain in Users. Stored audit records are unchanged.

Beta.29 separates Applications and Loans in Manage. Archiving an application preserves its loans; archiving a loan preserves its application while including loan-dependent records. Collateral date verification can use the archived application. Existing funded-live-loan protections, history, archives and ledger preservation remain.

Beta.30 expands Manage to 13 action-record categories, including collateral, trade receipts, comments, drafts, transfers, extensions, cash ledger and activity/status history. Independent cleanup retains an owner archive and consumed references; records supporting posted balances, accepted payments, collateral evidence and agreed extensions remain protected. Archiving history does not undo an action.

Beta.31 adds press-and-hold tab reordering (hold about 0.4 seconds, drag, release). Quick swipes still scroll the mobile row; dragging near an edge reveals off-screen tabs. Order is stored per bank/account/role on this device. Desktop users can also hold and drag or use Alt + arrow keys. New tabs are appended and inaccessible tabs are excluded.

Beta.32 removes Welcome lobby from the Lender userscript and opens it on Overview. The Borrower userscript keeps Welcome lobby. Saved tab orders automatically exclude the removed lender tab.

Beta.33 simplifies the native panel header to one close (×) button. Closing retains the saved bank login; the BETA Bank launcher reopens the panel.

## Beta.34 phone notifications

Settings lets each lender choose applications, loans, payments, collateral, comments, extensions, transfers, user restrictions, bank/staff changes, and other activity. A master switch and an Include my own actions switch apply across that account’s connected devices. The Send test notification button checks the current device.

On iPhone, open the bank website in Safari, use Share → Add to Home Screen, then open the new Torn Bank icon and sign in. Go to Settings → Enable on this device and allow notifications. The native Torn userscript links to this setup; iOS push permission belongs to the installed bank website. Closing the bank keeps alerts enabled; logging out of the web app disconnects its session’s devices. Settings can disconnect one device or all of the account’s devices.

Alerts are sent for newly saved bank activity even while the website and Torn script are closed. External Torn trades first need to be checked in the bank. Previews contain event types, without borrower names, amounts or API keys. Category changes do not replay older activity. Delivery timing depends on the phone and push service.

Deployment must run `npm run deploy`, which applies `migrations/0002_notifications.sql` before publishing the Worker. This adds separate notification preferences, subscriptions and an event outbox. The Worker generates its VAPID signing key once in D1; it is never returned to clients or included in bank exports. No manual key configuration is required. Saved bank actions and their outbox entries are atomic; delivery runs after actions and retries every five minutes. Expired subscriptions are removed, events are retained for seven days, and delivery rechecks current staff access and session validity. `/api/health` reports `notificationsReady` when the notification tables exist.

The test button’s success means the push service accepted the message; actual receipt must be checked on the phone.

## Beta.35 notification delivery fix

Replaces the unsupported `redirect: "error"` fetch option with Cloudflare-compatible `manual` handling. Redirect responses are not followed or treated as delivered; queued events remain available for retry. Existing subscriptions and preferences are retained. Reload the website and use Send test notification again.

`npm test` now also runs the encrypted push request inside local workerd, using its supported 2026-05-22 compatibility date and a simulated push service. This reproduces the beta.34 runtime error and verifies successful sends and non-followed redirects without sending notifications to a real device.


## Beta.36 PI payment collateral

Users with Private Island status saved in Users can propose a PI payment collateral value on an application. It counts toward the preliminary collateral calculation and always requires lender review. For an approved loan awaiting collateral, staff can choose **Record PI payment collateral**, enter the accepted value and valuation notes, select the responsible lender and confirm that the value is available for this loan. A payment/agreement reference is optional; no Torn trade ID or API check is needed. The accepted value must cover the loan's required collateral.

The server checks the borrower's current saved PI status and staff permissions. Application checkboxes alone do not authorize this path. Confirmation is recorded once against the loan with its value, reviewer, responsible lender, time and notes, and appears in collateral custody and user history. It does not add bank cash or repay the loan; funding still requires borrower confirmation and a separate disbursement record. Payment values are entered and reviewed by the lender, not automatically calculated from PI payments. Existing Torn trade verification remains available. No database migration is required.
