# Torn Lending Bank — BETA

Standalone beta bank. Beta.37 moves faction/non-faction selection to member setup; loan applications use the saved assignment. The lender opens on Overview, borrowers retain Welcome lobby, and sign-in lasts until logout; deployment is tracked separately from source validation.

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


## Beta.37 member type at signup

The owner selects **Faction VIP+** or **Non-faction secured** when inviting a member. The invitation and member type are saved together. Repeating an invitation cannot change an existing member's type. Active owner, vault and staff accounts can assign or correct it in **Users → Member type**, with a reason recorded in user history. Other user statuses, trust overrides, invitations, access removal and history clearing retain their owner-only permissions.

Applications have no faction/non-faction dropdown. They display the saved member type and automatically use the matching loan product and eligibility rules. The server validates that assignment for new submissions, pending application edits and approvals; a borrower cannot override it in a request. Eligible cash requests still use automatic approval after the member's setup is complete. Existing loans retain their saved terms.

Existing members need a one-time assignment in Users before submitting a new application. Their old self-selected applications are not treated as staff-confirmed membership. If staff change the member type while an application is pending, review and save that application's details before approving it. No database migration is needed. Rebuild and update both userscripts along with the Worker; older scripts may still display the old dropdown, but the updated server rejects mismatched selections.

Validation: `npm run build` and `npm test`, including signup persistence, transaction rollback/concurrent saves, staff/borrower permissions, both application programs, unchanged existing loans, and rendered forms.

## Beta.43: loan slots for every bank level

Faction and non-faction members use open-loan limits of 1 for Level 1, 3 for Level 2, 5 for Level 3, and 10 for VIP. VIP-PI also allows 10. Active loans (including staff adjustments) and approved loans awaiting funding consume slots. Requests at the limit go to manual review instead of automatic approval.

Existing bank rules receive the previously missing non-faction limits and the VIP limit of 10 when loaded. The one-time rules upgrade is persisted on the next bank save; later owner edits are preserved. Existing loans retain their saved terms. The owner can edit each program's count limits in Rules. Profiles and borrower Overview use the same limits, including on older installed scripts after a bank refresh.


## Beta.58 Weav3r application pricing recovery

The application keeps the full Weav3r listing median as its first choice. If the per-item responses omit usable listing counts and market prices, it checks the public Weav3r marketplace catalog for the exact Torn item ID and uses the catalog's reported Torn market reference. The catalog is cached for five minutes and shared across simultaneous item checks in one application. Cached data keeps its original check time. Immediate per-item retries are skipped after a rate-limit response. A separate bounded timeout lets the catalog run after a slow item lookup.

Item rows identify the price source and check time, and offer **Refresh Weav3r price** for existing live, saved, or Torn fallback estimates. Failed refreshes retain the previous value as an estimate. Submission still revalidates prices on the server; client estimates do not approve collateral. Staff must verify and accept collateral before funding.

The existing fixed Xanax market health check includes bounded public response fields and counts for each attempted feed. It contains no bank records, API keys, request headers, or raw upstream responses. This makes live provider-shape failures distinguishable from a local successful API test.


## Beta.59 application collateral total

Application details now show **Total = $…** directly below the cash and item breakdown. This is the combined cash, item reference value and proposed PI payment collateral, when present. A separate **Credited collateral = $…** line uses the bank's existing collateral calculation, including its configured item-credit percentage. Both lenders and borrowers see the same summary.

## Beta.60 borrower approval message

Pending applications show **Awaiting approval** to borrowers when lending funds need allocation. Staff retain the allocation review reason. Once an application is approved or denied, that saved allocation reason is hidden from the borrower so it cannot continue to imply that approval is pending. All other review notices and approval checks are unchanged.

## Beta.61 automatic approval followed by staff collateral verification

A new borrower application automatically receives approval when the server-verified identity, current program and trust level, net-worth limit, open-loan allowance, accepted terms, standing, item prices and credited collateral satisfy the rules. Approval no longer depends on a lender having allocated or recorded enough bank cash. The system records the decision in its own name and creates an unfunded loan with no assigned issuer. It consumes the borrower's loan slot without reserving any individual lender's cash. Manual and legacy approvals already assigned to a lender retain their existing reservations.

Acceptance of the exact submitted amount and terms is recorded with an automatic approval. A staff change to the start date clears that acceptance and requires reconfirmation. The borrower then creates a collateral trade in Torn. Receiving staff review the approved amount and required collateral, complete the trade in Torn, and explicitly accept the completed trade's cash and reviewed item values. The existing staff-reviewed PI payment route remains available to eligible borrowers. Collateral has to meet the full credited requirement before the staff member sends and records the loan funds. Funding also retains the receiving lender's bank-cash, date, terms and restriction checks; the actual funding staff member becomes the issuer. Neither approval nor collateral acceptance transfers money in Torn or adds collateral to spendable bank cash.

A previously synchronized, unassigned trade receipt can now be verified as collateral without creating a duplicate receipt. Consumed, assigned or mismatched receipts remain blocked, and a collateral receipt cannot be reused as a loan repayment. The server owns new borrower application timestamps so an older trade cannot qualify through a backdated request. Final funding rechecks the accepted collateral amount.

The application and loan views show the next step: awaiting collateral verification, revised-terms confirmation or funding. Unfunded approvals display their approved principal with no funded balance or accrued interest. Existing pending applications are not retrospectively approved from saved review reasons; they retain their recorded decision state. No database migration is required. Deploy the updated Worker and update both userscripts for the new server checks and interface.

## Beta.62 borrower request withdrawal

Borrowers can choose **Withdraw request** from their pending application or an approved loan awaiting funding, then confirm the withdrawal. The server verifies that the application belongs to the signed-in borrower and has no recorded funding. The application and its linked unfunded loan become **Withdrawn by borrower**, retaining the original request, approval, notes, withdrawal time and activity history. Withdrawal releases the open-loan slot and any approval reservation against a lender's cash. It does not count as a successful repayment or accrue a loan balance, interest, due dates or strikes. A borrower can submit a fresh application under the usual rules.

Withdrawn requests leave staff approval and funding queues. Current-status checks and the existing conditional state save prevent a competing or stale approval, collateral verification or funding action from reviving the request. Repeated withdrawal requests produce one activity event, and enabled staff application notifications include that event. If a competing save wins, the borrower view refreshes and displays the conflict instead of reporting a successful withdrawal.

Received collateral and trade receipts remain recorded. A withdrawn loan with held collateral appears in the staff collateral-return queue until staff records its release. PI payment collateral must also be released from the cancelled loan. The borrower confirmation explains that any open trade must be cancelled in Torn. Withdrawal does not cancel a Torn trade or transfer assets automatically.

Staff must refresh the bank and confirm the request is still approved immediately before sending funds in Torn. The bank prevents withdrawal after disbursement is recorded; it cannot observe an external transfer that staff has not yet recorded. This update adds no database migration. Deploy the Worker and update the borrower and lender userscripts together.

## Beta.63 create a Torn trade for any approved loan

Every borrower-owned approved, unfunded application now has **Create a trade** at the bottom of its details and on its linked loan. This applies to automatic and staff approvals across loan products. Each action uses that loan's saved reference as the Torn **trade description**; there is no special-case loan number. Torn still assigns its own numeric trade ID. Loans whose collateral is already accepted or whose requirement is zero also offer the action, as an optional step. PI payment collateral and existing funding prerequisites are unchanged.

The borrower chooses an enabled receiving staff member in **Trade with**. An eligible original lender is selected by default; an automatic approval with multiple possible recipients asks the borrower to choose. Selecting a recipient does not change the lender's cash reservation or the eventual funding issuer. The website opens Torn in a new tab, with a Continue in Torn link if a popup is blocked. The native userscript navigates its current tab. Both require an updated userscript and the borrower's saved bank sign-in within Torn to complete the native handoff. Demo mode cannot create or open live trades.

The bank prepares a two-minute setup containing the canonical loan reference and recipient. On Torn's new-trade page the userscript checks the current Torn account, signed-in bank borrower, approved loan, recipient, and uniquely identifiable visible Description and Initiate controls. It fills the exact reference, claims the attempt once on the server, rechecks the page, and initiates one empty trade. It does not add assets, accept a trade, cancel a trade, or disburse the loan. Torn's API is read-only, so this action uses the borrower's native Torn page after their explicit button click, without adding API permissions or using a private write endpoint.

Opening Torn, preparing a setup, or clicking Initiate is not recorded as proof of creation. The userscript must observe an exact description, the selected recipient, and a numeric view link in the same visible native trade record. The supported active-trades list supplies this evidence. If the opened trade screen does not expose enough matching detail, **Check trades in Torn** opens the list; **Check current trade** only observes and saves its link. A per-tab resume record contains only the loan, attempt, and recipient identifiers, allowing observation after navigation or reload without resubmitting. No login token, API key, or loan reference is put in the handoff URL or resume storage. A missing or ambiguous form stops the helper and directs the borrower to check the request and existing trades. Actual Torn form and iPhone/Torn PDA behavior still require on-device confirmation; synthetic adapter and controller tests do not establish live compatibility.

Saved creation is labelled **Borrower browser observation** and never verifies collateral or changes the loan balance, terms, issuer, or funding state. Staff continue to verify completed Torn collateral through the existing checks. Repeated or competing claims cannot initiate again. A native Initiate click while the claim is pending is observed without another helper click. If withdrawal wins before the claim, creation is blocked; if a valid in-flight result arrives after withdrawal, its link is retained with cancellation instructions and the request stays withdrawn. A valid earlier claim can also save its link after recorded funding, as nonfinancial follow-up only. There is no new preparation or claim after funding.

No database migration is required. Deploy the beta Worker and update both beta userscripts together. Native form discovery uses semantic labels scoped to Torn's new-trade form; verified selector references are [Torn's trade guide](https://wiki.torn.com/wiki/Trade), [TornW3B's original source](https://greasyfork.org/en/scripts/561291-tornw3b-trading-companion/code), and [TornTools' original source](https://github.com/Mephiles/torntools_extension).

## Beta.64 Torn native trade validation

Fixes the filled Description field followed by **Check trade setup** on the New Trade screen. Torn's [native trade validator](https://www.torn.com/js/script/src/trade/trade_initiate.js?v=2025-04) listens for `keyup` on the recipient input and description textarea before enabling **INITIATE TRADE**. Beta.63 dispatched only `input` and `change`, so the button could remain disabled despite both fields being filled. The helper now also dispatches one bubbling `keyup` event, allowing Torn's own validator to enable its button. It does not send Enter, move focus, force a disabled button, or submit before the saved single-use claim.

Timeout messages now distinguish an unconfirmed form, a still-disabled Initiate button, and a missing created-trade result. A failure before any attempt explains that the helper did not submit a trade and directs the borrower back to the bank. An uncertain attempt keeps the existing observation-only recovery and one no-retry message. Polling stops permanently when it settles, including if a queued callback arrives later.

This change applies to the existing generic handoff for every approved, unfunded loan, using each loan's own reference. Approval, withdrawal, collateral and funding rules are unchanged. Update the installed borrower or lender userscript to beta.64, reload Torn, and reopen Create a trade from the approved request; a setup left open from beta.63 can have expired. The regression models Torn's textarea and initially disabled submit input with keyup-only validation. Actual phone and signed-in Torn testing remain separate from local validation.

## Beta.65 loan details and expected collateral

Every automatic or staff approval now keeps the approved application's collateral breakdown on its loan: cash, exact item names and quantities, optional Torn item IDs, and proposed PI payment collateral value. For example, an application listing 14 Xanax displays **14 × Xanax** for that loan; other loans retain their own quantities. **Expected collateral** appears beside the loan's trade information in the application and loan views and inside both staff collateral-review dialogs. The credited collateral requirement remains separate from the listed assets, and PI payment value is labelled for its separate staff review.

The updated borrower and lender userscripts add a collapsed **Loan details** panel on Torn's trade page. Open it to load the bank records available to the signed-in account. A **Loan** selector identifies each accessible loan by borrower, reference and status. A uniquely matched current trade can select its linked loan; otherwise staff can choose a loan and compare its reference with the Torn trade description. The panel shows the chosen loan's status, approved amount, credited collateral requirement and expected assets, with a refresh control and a link back to the bank. Changing the selector only changes the displayed details. The current Torn account must match the saved bank account.

Existing loans can recover their breakdown from the matching original application, including an archived application, without exposing raw archives to borrowers or non-owner staff. The compact snapshot is persisted on the next ordinary bank action. An unavailable or incomplete original breakdown is labelled unavailable rather than presented as zero. Explicitly empty proposals remain distinguishable. Previously accepted, funded or withdrawn loans show the saved proposal as history; it is not a statement of what collateral remains held.

The Torn trade description stays exactly equal to the loan reference. Viewing the checklist, selecting a loan or observing a linked trade does not accept collateral, transfer assets or fund a loan. Staff still compare the actual trade, verify its completed receipt and accept the reviewed credited value through the existing bank workflow. This release adds no database migration. Deploy the Worker and update both userscripts to beta.65; reload Torn to load the new panel. Local API, rendered-interface and native-page fixture tests do not establish signed-in Torn or iPhone/Torn PDA compatibility.

## Beta.66 staged collateral and funding in one trade

The trade-page **Loan details** menu now supports the complete exchange for every eligible approved loan, whether automatically or manually approved. Both borrower and staff keep the collapsible panel and loan selector. Borrowers can act only on their own loans; staff verification belongs to the receiving lender named on the matching trade. Other authorized staff can view the loan. Each trade description must equal that loan's reference, with no special-case loan number.

1. The borrower adds the approved cash and items, then chooses **Confirm collateral placed**. A staff-approved loan whose terms have not yet been accepted shows its approved principal, rate, start, maturity and repayment schedule with a separate required terms-acceptance checkbox.
2. The receiving staff member chooses **Verify collateral**, compares the exact quantities with the expected checklist, and records accepted item values, their source and any eligible PI payment value. Cash and item amounts are checked against Torn's ongoing trade details. Legacy proposals without item IDs also require an explicit staff review of the item mapping.
3. Staff adds the full approved principal to the same Torn trade and chooses **Confirm loan funds added**. The bank rechecks eligibility and available lender cash, then reserves that principal once.
4. The borrower chooses **Verify loan funds added**. This checks the lender's exact cash offer; the money has not yet been recorded as received.
5. **Accept trade in Torn** becomes available in the menu once all four checks are saved and the matching native Accept control is available. An explicit click performs a fresh API check and opens Torn's initial Accept step once. Each participant continues Torn's own confirmation; the script does not bypass it or click the final confirmation automatically.
6. After Torn has completed both sides, the receiving staff member chooses **Verify completed transfer**. One atomic bank save records the received collateral, the full principal disbursement, the completed trade receipt and staff verification, and activates the loan. The agreed terms stay intact; the disbursement uses the actual completed trade date.

The menu distinguishes offered collateral and reserved cash from completed transfers. Changed borrower assets clear the collateral and subsequent checks. Changed lender cash clears the funds checks. Changed terms require a new review. A reserved trade cannot be withdrawn, separately funded, have its terms changed or be archived. To withdraw while funds are reserved, staff first removes its cash from the ongoing Torn trade and uses **Reset trade review**. The bank confirms a zero lender cash offer before releasing that reservation. An unavailable or already cancelled trade requires reconciliation; absence is not treated as proof that cash is safe to release.

The API trade ID and the numeric ID in Torn's page address are stored separately. Leave the optional API ID blank to find the unique ongoing trade by exact reference and participants. Existing linked trades retain their API identity, and mismatched pages or accounts stop the action. Completed proof cannot be reused for another loan or repayment. Repeated completion checks cannot create another disbursement. Loans with collateral already received through the earlier workflow retain that existing bank workflow so the collateral is not collected twice.

Both userscript key-creation links now request `trades` and `trade` read access; lenders also retain `money`. Existing saved keys without the required access need replacing, or a suitable temporary key can be entered for one check. Temporary keys are not saved, included in bank records or included in diagnostics. Merely opening or selecting a loan performs no trade write. The menu gates its own Accept action; Torn's independent controls and other clients remain under Torn's control.

Deploy the beta Worker and update both userscripts to **1.1.0-beta.66**, then reload Torn. No database migration is needed. Validation covers the staged API and accounting, role and terms controls, changed offers, withdrawal and settlement races, rollback, native Accept forwarding, and a mounted six-stage menu with synthetic DOM/API data. No live trade, real asset transfer, visual-browser or iPhone/Torn PDA result is claimed. API behavior follows [Torn's official OpenAPI specification](https://www.torn.com/swagger/openapi.json) and [API guidance](https://www.torn.com/api.html); native confirmation follows [Torn's trade guide](https://wiki.torn.com/wiki/Trade).

## Beta.67 trade confirmation click feedback

Addresses an enabled **Confirm collateral placed** button whose review form can be refused while the reason is above the visible portion of a long trade menu. An unlabelled native heading such as “Trade” is now distinguished from an explicit trade description or a recognizable loan reference. A non-Accept review can open with an uncertain heading only when the current native trade ID exactly matches the loan's saved native trade ID. Ambiguous native containers, another loan reference, an explicit mismatched description, an incorrect native ID or a changed account still stop the action. Opening a form sends no write; the existing server check verifies the actual Torn API description, participants and assets before advancing any stage. Native Accept retains its stricter reference and control checks.

Review feedback appears beside the action being used, and opening the review brings its form into view. Required confirmation fields also display an explicit inline validation message instead of relying on a native validation popup inside the closed userscript panel. The borrower's placement confirmation and any separate terms acceptance remain explicit and independent. Keys retain their existing validation and temporary-use handling.

After the bank observes and saves a newly created trade, the helper opens that existing trade and automatically opens its borrower's collateral review in **Loan details**. It checks the current account and exact saved loan, creation attempt and native trade ID again with a fresh bank read before showing the form. A short per-tab continuation containing only those identifiers survives navigation and is cleared when consumed; ordinary visits and repeated events do not reopen the form. The borrower then adds the collateral and explicitly submits verification. Auto-opening never checks a box, accepts terms, verifies collateral, creates another trade or presses Torn's Accept control. Cancelled, funded, unrelated or already advanced loans do not start this review.

Update the installed borrower or lender script to **1.1.0-beta.67**, reload the existing Torn trade, open **Loan details** and select the linked loan. No new trade, database migration or alteration of existing loan records is required. The reported screenshot identifies an enabled initial action with no open review form; the generic-heading refusal and hidden validation paths were reproduced locally, while the exact native heading on that phone was not available. Synthetic production-bundle tests cover the corrected click paths; live iPhone/Torn PDA confirmation remains separate.

## Beta.68 replacement for expired loan trades

Every approved, unfunded loan can replace an expired or cancelled trade through **Replace expired trade**, available in its bank loan record and the **Loan details** menu on Torn's trade page. This applies to existing loans, future loans, automatic approvals and staff approvals. Each replacement has a new creation attempt and native trade ID while keeping the exact loan reference as its description. The same recovery remains available if that replacement later expires; there is no fixed number of replacement attempts.

1. Wait for Torn to return the cash and items offered in the expired trade.
2. Open **Loan details**, select the loan, and choose **Replace expired trade**. The same option is available beneath the saved trade link in the bank.
3. Choose the receiving staff member, explicitly confirm the old trade did not complete and its offered assets were returned, then choose **Create replacement trade**.
4. The bank checks current and finished Torn trades before issuing a new setup. The userscript creates one empty replacement trade using the same loan reference. Its collateral review opens through the existing created-trade flow.
5. Place the collateral in the new trade and repeat all borrower and staff collateral/funds checks. Earlier confirmations cannot authorize acceptance of a different trade.

If staff had confirmed loan funds were added, the receiving staff member must first use **Confirm returned loan funds** in the same menu or loan record. Staff enters the full principal, notes how they checked its return, and explicitly confirms the old trade did not complete. The bank verifies the staff identity and checks trade history before recording this return confirmation and releasing the trade's commitment. This is an audited staff confirmation of the actual return; an unavailable trade page alone does not release funds or establish that a transfer failed. The borrower can then create the replacement. Loans with an actual completed transfer, accepted collateral, disbursement, repayment or other financial evidence require their existing settlement/reconciliation workflow.

The [official Torn API schema](https://www.torn.com/swagger/openapi.json) exposes ongoing and finished trades, without a distinct expired/cancelled status. Recovery therefore checks two fresh ongoing snapshots around a complete finished-history scan from the earliest preparation of this loan's attempts, along with the participant's explicit return confirmation. A matching ongoing or completed trade stops replacement. API errors, missing history metadata and an incomplete scan stop the action without changing the loan. Large history windows are split at exclusive/inclusive timestamp boundaries; an unresolvable saturated timestamp or request limit requires staff review rather than skipping trades.

Previous intents, native/API IDs, review state and return confirmations stay in the loan's attempt history. Late reports, old creation links, delayed claim responses and stale auto-open events cannot create or relink a retired attempt. Server state and permissions are rechecked after Torn reads, and concurrent requests can save only one replacement. A lost response triggers a bank read without replaying creation; a saved setup can be resumed with **Continue in Torn**. Temporary keys remain local to a single check and are redacted from displayed errors.

Update both installed userscripts to **1.1.0-beta.68** and reload Torn. No database migration is required. Validation covers repeated expirations, both approval paths, participant permissions, returned-funds reconciliation, ongoing/completed trade conflicts, pagination completeness, stale attempts, concurrent replacement and late verification. Mounted production components use synthetic mobile DOM fixtures; no live Torn trade or iPhone/Torn PDA action was performed during validation.

## Beta.69 exact loan cash entry in Torn

On Torn's **Add Money** screen for a linked loan, the receiving lender's **Change** button is disabled unless the displayed cash and Torn's hidden cash field both equal the approved principal. For a $200,000,000 loan, $202,000,000 and $199,000,000 are blocked before Torn's normal button or Enter-key handler can submit. The message shows the required amount and the entered amount. The field sets the total offered money, not an additional increment. Entering **0** remains available to remove the lender's offer for cancellation or a safe review reset.

The guard reads the bank automatically on the native cash page and does not require opening Loan details. It matches the current Torn account, receiving lender and saved native trade ID; borrower collateral amounts and unrelated trades retain their ordinary controls. Old replacement attempts, cancelled loans, completed loans and ambiguous loan matches cannot receive new positive loan funding through the guarded form. The guard never fills an amount, submits money, or accepts a trade on its own.

Capture handlers also block mismatched click, submit and Enter events if another script enables the native button. Both cash fields are rechecked at the event. A stale bank read pauses submission for a refresh and requires another explicit click. Route/account changes discard pending reads; native form replacement reattaches the guard. Existing disabled native controls stay disabled. A failed refresh of a known loan keeps positive cash blocked while retaining zero for removal. If initial bank access is unavailable, a visible **Loan amount protection unavailable** message appears: sign in and refresh before funding. No confirmed loan amount is invented from a page heading or a manually selected loan.

This is a local userscript block on Torn's supported cash form. It requires the updated script to be enabled and the bank sign-in to be available; it cannot enforce Torn's server rules in another browser or against requests made outside the guarded controls. The existing server checks still independently require the exact principal at funds confirmation, borrower review, acceptance readiness and settlement.

Validation: 489 Node tests passed, including 16 new amount-policy and mounted DOM interaction tests, plus the existing workerd encrypted-push test. The native cash selectors are grounded in [TornW3B Trading Companion's source](https://greasyfork.org/en/scripts/561291-tornw3b-trading-companion/code). DOM tests cover exact, excess, short and zero amounts, hidden-field mismatch, capture blocking, stale/failed reads, navigation races, form replacement, borrower/unrelated trades and original disabled state. Chromium could not launch in the execution environment, and actual iPhone/Torn PDA behavior remains to be checked on-device. Update the userscripts to **1.1.0-beta.69** and reload Torn; no database migration is required.

## Beta.74 completed-trade verification and native acceptance

The script now has five review steps. After the four collateral and funds checks, participants accept using Torn's own controls. The script's Accept button, native forwarding adapter and separate Accept checklist step have been removed. The receiving lender then chooses **Verify completed transfer**; this action does not accept a trade or send money.

Final verification reads Torn's finished history in the current review period, requires exactly one record with the selected loan's reference and both expected participants, and fetches only that record's details. The completed receipt ID may differ from the saved ongoing API ID and native page ID; those original links remain unchanged. The server rechecks the current loan attempt, completion timestamp, saved asset fingerprints, collateral review and exact principal before one atomic settlement. Missing, ambiguous, old or inconsistent evidence stops verification. Other trade records are never settled by this action, and repeat verification uses the saved receipt without duplicating funding. Refresh can discover finished evidence after Torn stops resolving the original ongoing ID, but does not settle the loan.

Existing loans waiting at the final step can retry verification after deployment; they do not need another trade or another transfer. Update both userscripts to **1.1.0-beta.74** and reload Torn. No database migration is required. Validation covers changed completion IDs, retries, rollback and races, mismatched evidence, the five-step menu, and one selected deal among fourteen unrelated trades with the same players and amounts. Synthetic tests and deployment checks do not prove live account verification has succeeded.

## Beta.75 bank reset passcode

The owner-only bank reset dialog now uses a masked four-digit passcode field with a numeric keyboard. Enter `1234` to confirm instead of the previous all-caps phrase. The server requires that exact passcode; owner permissions, revision checks and duplicate-request protection still apply. Update the userscript to **1.1.0-beta.75** and reload Torn.

## Beta.76 bank restock status

The Bank tab now lets the owner or a vault lender select **Online**, **Awaiting restock**, or **Offline**. The borrower's welcome page, Bank tab and sidebar share the saved status: green for online, yellow for restocking and red for offline. Awaiting restock explains that loan funding is delayed while bank funds are replenished; applications, existing loans and repayments remain available. Offline keeps the existing pause on new lending.

The status is controlled manually, and changes are audited and shared across accounts. Existing banks retain their online/offline setting until an authorized operator changes it. Update both userscripts to **1.1.0-beta.76** and reload Torn. No database migration is required.
