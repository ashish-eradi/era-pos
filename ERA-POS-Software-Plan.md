# ERA POS software development plan

Working release plan for the founders, engineering team and pilot stores · 23 November 2026

### 1. Product and first customer

ERA sells a subscription to a retail business. The business owns its catalog, branches, staff, shopper transactions and payment-provider account. ERA provisions the software, invoices the merchant for its subscription, releases updates and supports the registers. Shopper payments flow to the merchant through its provider. Keep ERA subscription invoices in a separate record set from shop receipts.

ERA POS launches as a general retail POS for independent stores in India and the United States. Recruit across store types, including stationery, home goods, packaged grocery, apparel and footwear. Select pilot stores by the workflows they need and the hardware ERA can support. Start with one supported Windows counter per branch. Validate local payments, taxes, receipts and support before each installation.

### 2. What each person can do

| Workspace | Principal screens and permissions |
| --- | --- |
| ERA operations | Merchant list, trial creation, invitations, plan and renewal, branch/register allowance, activation history, software version, last sync, support case and release rollout. Separate account-management and support permissions. |
| Merchant owner | Business settings, stores, staff invitations, role assignments, receipt identity, payment setup, owner dashboard, exception queue, subscription and export. Owner can drill from a daily total to its receipts. |
| Branch manager | Product variants and labels, supplier receipts, stock count, adjustment approval, staff shifts, exchange approval and close review for assigned branches. |
| Cashier | PIN unlock on paired register, open shift, scan/search, park sale, discount within limit, take tender, print/reprint, find receipt, exchange and submit blind cash count. |
| Accountant | Read-only sales, discounts, tax, refunds, payment settlements and dated exports. Owner controls store access. |

A single owner-operated shop can assign several duties to the owner. Enforce permissions and tenant identity at the API. Record actor, register, branch, timestamp and reason for sensitive changes. ERA support starts with device and sync diagnostics. Access to a merchant’s records requires a scoped, expiring support session and an audit entry.

### 3. Release scope and commercial offer

Paid single-store pilot. One supported register configuration, product CSV import, opening stock, variant barcodes, basic supplier receiving, counter billing, cash and one integrated digital tender, receipt printing, exchanges and partial returns, stock adjustments, shift close, settlement matching, owner reports and accountant CSV. Include offline cash checkout, backups, restore, software updates, onboarding and support ownership in the delivery estimate.

Two-store pilot. Add branch stock lookup with last-sync time, dispatch and receipt, in-transit stock, branch-level availability, cross-store receipt lookup and online authorization of cross-store returns. Deliver this before charging a merchant for a two-store rollout.

Expansion backlog. Prioritize purchase orders and supplier returns, ecommerce reservations, loyalty/gift cards, self-service subscriptions, additional device families and accounting connectors according to paid demand. Grocery scales, pharmacy batches and electronics serial numbers each justify a separate store trial.

Commercial test. Quote per active location, state the included register count and price extra devices, installation, import assistance and onsite visits separately. Test ₹499/location/month for a single-store package and ₹999/location/month for a package with transfers and automated reconciliation. Pilot agreements should specify entitlement, support hours and what happens at renewal. Track support time and device visits before publishing prices. For the pilot, ERA can issue subscription invoices manually and record payment and entitlement in the console.

### 4. Merchant lifecycle

ERA creates a trial business, selects country and plan, and invites the owner. A demo merchant has its own data.

Owner confirms store identity, receipt settings, tax setup and staff. Pair the register using a short-lived activation code and record its branch and device ID.

Import the merchant’s catalog into staging. Preview duplicate barcodes, invalid prices, missing size/colour and opening quantities. Owner approves the reconciled totals. Re-running an import must be safe.

Connect the merchant’s provider, test printer/scanner, run a sale, exchange and close, then confirm opening stock at cutover. Keep the old system available for historical lookup under an agreed legacy-return policy.

During live use, ERA sees pending sync, app version and device health. The merchant sees sales, stock and unmatched payments.

At renewal, notify owner, record payment and extend entitlement. Define a grace period and display the expiry clearly. Preserve queued transactions through an outage or subscription change. On cancellation provide an owner export, revoke device access at the agreed end date and apply the documented retention policy.

### 5. Software architecture

| Component | Proposed implementation and boundary |
| --- | --- |
| Counter | React/TypeScript desktop app packaged with Electron for a validated Windows setup. SQLite stores local catalog, permissions with expiry, shifts, committed sales and a durable upload queue. |
| Web application | Responsive React screens for owners and branch staff, plus a separately authorized ERA console. Owner view shows branch timezone, business date and last successful sync. |
| API and worker | TypeScript/NestJS modular backend for merchant accounts, entitlements, catalog, stock, checkout, payments, reporting and device sync. A worker handles settlement imports, event retries, exports and scheduled jobs. |
| Cloud storage | PostgreSQL for business records. Encrypted object storage for controlled imports, exports and backups. Separate demo, staging and production environments and credentials. |
| External services | Provider adapter per market for payment creation, verification, refunds and settlement reports. Tax and accounting interfaces per country. Use a certified terminal provider where required by the chosen integration. |
| Distribution | Signed desktop installers, versioned API, backward-compatible database migrations, pilot rollout group and device version reporting. An update waits for a safe shift boundary and preserves queued sales. |

Core records. Merchant → branch → register → shift. Each product has one or more sellable SKUs with optional attributes and barcodes. Stock movements identify the branch, SKU, quantity and unit. Receipt lines preserve prices and taxes. Returns reference original lines and remaining returnable quantity. Link payment attempts, settlements and transfer records. Keep subscription and operator access records separate.

Consistency rules. Store money in integer minor units with currency and an explicit rounding rule. Snapshot tax, price and allocated discounts on each sale line. Commit the cash sale, stock movement and upload event in one local transaction before printing. The server validates the register and tenant, deduplicates by operation ID and acknowledges only after a durable commit. Reprints use the saved receipt. Correct committed records with linked adjustments. The synchronized cloud ledger drives consolidated reports.

### 6. Hard cases that determine whether stores can trust the product

| Case | Required behaviour |
| --- | --- |
| Internet drops mid-shift | Allow eligible cash sales from the local catalog. Display pending uploads. After restart and repeated reconnects each receipt reaches the server once. Owner dashboard shows stale registers. |
| Digital payment times out | Show pending and retain provider reference. Query authoritative status and verify callbacks. A second tender requires a deliberate resolution path. Late success after alternate payment creates a visible overpayment case. |
| Printer fails after payment | Keep the committed sale and give a reprint option. Never charge or deduct stock twice. |
| Shopper exchanges a discounted item | Use original line discount and tax, apply return policy, classify returned stock as sellable or damaged, and collect/refund the difference. Cap cumulative returned quantity. |
| Same receipt presented at two branches | Authorize the return centrally and reserve the remaining returnable quantity atomically. Queue a request for manager review while offline. |
| Stock transfer is short | Dispatch ten, receive nine, keep one in transit or dispute. Require a documented adjustment to resolve the balance. |
| Bank deposit spans multiple days | Match gross payments, refunds, fees and net payout by reference. Leave unexplained differences open for investigation across shift close. |
| Device is lost or replaced | Revoke the device, restore acknowledged records on the replacement and reconcile the last synced receipt with merchant records. A destroyed device can lose unsynced sales; establish the pilot’s local backup method and measure that exposure. |

### 7. India and US rollout

| Area | India pilot | US pilot |
| --- | --- | --- |
| Payment | Cash and one merchant-owned UPI integration, status lookup, callback verification, refund and settlement import. Validate live and sandbox access. | Cash and one supported card terminal using merchant-owned processing. Test approved, declined, interrupted, refunded and settled transactions. |
| Tax and receipts | Capture merchant registration status and applicable invoice fields. Have the pilot accountant approve tax-inclusive pricing, tax breakup, discount, exchange and credit-note samples. Add e-invoicing before onboarding merchants whose workflow requires it. | Choose one state and locality. Integrate and validate product taxability, exemptions, pickup and original-tax refunds for that jurisdiction before live use. |
| Accounting | Start with a reconciled CSV approved by the accountant. Confirm a sample import before selling a Tally integration. | Validate daily posting and refunds with a pilot bookkeeper. Confirm a working import or connector before selling QuickBooks support. |
| Hardware and service | Test the merchant’s actual PC, receipt printer, scanner and power-loss recovery. Agree local service hours. | Select devices supported by the US processor. Confirm replacement process, service hours and a local pilot contact. |

Both markets reuse the merchant, catalog, checkout, permissions and stock model. Each launch requires sample receipts, a test merchant, provider approval, a reconciled settlement and a support owner.

### 8. Delivery schedule and owners

Planning estimate for two full-time engineers, a founder/product lead with merchant access, part-time design and QA, and access to a merchant accountant. Twelve weeks estimates one controlled pilot on one country integration. Schedule each market using its provider and hardware readiness. Provider approvals, device availability and migration quality are external dependencies.

| Weeks | Accountable owner | Deliverable and exit test |
| --- | --- | --- |
| 1–2 | Founder and tech lead | Collect pilot samples and confirm hardware, tender and cutover owner. Deliver the workspace, backend and local data setup, web and Windows counter shells, then CI and the foundation handoff. A fresh Windows checkout runs the apps and smoke checks with two synthetic merchant fixtures. |
| 3–4 | Backend engineer | Provision two merchants from the ERA console, invite owners, pair devices, import catalogs and opening stock. Same barcode can have different prices for the two merchants. Access and exports are isolated. |
| 5–6 | Counter engineer | Scan, discount, take cash, print, reprint and close. Complete an offline cash sale, restart, sync twice and verify one receipt and stock movement. |
| 7–8 | Both engineers | Integrate digital payments, refunds, exchanges and settlement review. Replay delayed callbacks and partial refunds. Owner can explain the difference between sales, confirmed payments and deposits. |
| 9–10 | Product lead and QA | Finish receiving, counts, reports and accountant export. Rehearse restore, train two staff and run parallel closes. Complete two-store tests here if a branch launch is contracted; re-estimate if needed. |
| 11–12 | Founder and support owner | Activate the pilot after sign-off, staff the first closes, resolve discrepancies and review paid continuation. Roll out to the next store only after retesting fixes. |

The [Codex build plan](ERA-POS-Codex-Build-Plan.md#foundation-for-weeks-12) defines the folder structure and exit checks for each foundation phase. Engineering verifies, commits and pushes each phase before starting the next one. Each commit message contains only the phase implementation subject.

Dependency fallback. If provider approval is late, continue counter, import and stock tests using the sandbox. A merchant willing to use an existing standalone terminal may test manually recorded tenders with an explicit unverified status. Advertise automated reconciliation only after a live end-to-end settlement test.

Budgeting. The baseline assumes about 24 engineer-weeks plus design, QA, product and onboarding time. Price those weeks at the team’s actual loaded rates, then add hardware, provider onboarding, hosting/backups, signing, field visits and pilot support. A founder should track one-time build cost separately from recurring cost per active location.

### 9. Release and commercial acceptance

Engineering sign-off: Two merchants cannot access each other’s data through UI, API or export. Checkout survives restart. Retries, refunds and reprints preserve financial and stock totals. Restore on a replacement machine works with the agreed recovery point.

Merchant sign-off: The owner approves opening stock, a sample invoice, exchange, daily close and export. A second cashier can operate the counter independently. The support contact can recover a printer failure.

Operational sign-off: A named person monitors payment discrepancies, sync backlog and failed backups. Establish an escalation contact, update rollback procedure and export process. Capture baseline close time and support effort.

Pilot decision: Target three paid stores, a 30% reduction in median close time against each store’s baseline, zero unexplained duplicate or missing transactions, and two renewals at the quoted price. These are proposed targets, not forecasts. Track the net monthly contribution after support, infrastructure and referral fees.

First backlog item: From the ERA console, onboard two independent merchants using the same release. Import one real catalog, complete an offline cash sale, print the receipt, reconnect twice and verify the correct stock and sales exclusively on that owner’s dashboard.

### 10. ERA platform admin console

ERA staff sign in to an internal console. Its home page answers three questions: which stores need help going live, which counters need attention today, and which subscriptions need action? Keep the merchant name, country and environment visible on every merchant-specific action. The following screens form the proposed development backlog. Pilot means a functional, manually operated workflow. Scale means automation after the paid pilot.

#### Merchant accounts and onboarding

| Screen | What staff see and do | Completion and exception behaviour |
| --- | --- | --- |
| Operations home · Pilot | Queues for incomplete onboarding, failed imports, stale registers, open incidents and upcoming renewals. Filter by country, owner and age. Select any count to open its underlying records. | Show last refresh and assigned operator. A counter with an unknown status is distinguishable from a healthy counter. |
| Merchant directory · Pilot | Search by business name, merchant ID, owner contact or branch. Filter by plan, country, account status and onboarding stage. Create a trial, assign account owner or open merchant details. | Warn on matching contact or business details before creation. Retrying the same request creates one account. |
| Merchant details · Pilot | Tabs for business profile, contacts, branches, devices, subscription, onboarding, tickets and activity. Store legal and display names separately. Verify owner before transferring ownership. On Create store and Edit store, an authorized ERA admin sets the store type per branch. Choices include General / Mixed retail, Apparel & footwear, Stationery, Home goods and Packaged grocery. Country is a separate field. Store type suggests catalog defaults within the shared POS. | Changing contact details preserves prior account history. Owner transfer requires the designated approval and expires existing privileged sessions as appropriate. Test changing a store from Apparel to Mixed retail. Preserve existing SKUs, attributes, stock, receipts, tax settings and staff access. Record the operator, time and prior/new type. Reject unauthorized edits. |
| Onboarding worklist · Pilot | Assign each step: owner accepts invitation, profile confirmed, catalog mapped, opening stock approved, register paired, receipt tested, first close reviewed. Attach evidence, owner and due date. | A failed step shows the reason and responsible person. Going live records who accepted opening balances and when. |
| Import centre · Pilot | Upload source file, map columns, preview duplicate SKU/barcodes, validate row errors, download rejected rows, reconcile totals and commit an approved batch. | Re-uploading an identical batch cannot double opening stock. After trading begins, corrections create auditable adjustments. |
| Branches and registers · Pilot | Add branch within purchased allowance, set timezone and business day, generate or expire pairing code, view device version, reassign replacement and revoke lost register. | Pairing code is single-use. For replacement, show last acknowledged receipt and pending-data exposure. Never reassign historical receipts. |
| Commercial pipeline · Scale | Track lead, demo, trial, paid activation and lost reason. Link the CRM record to the merchant created on conversion. | Keep demo transactions separate from live reports. Measure conversion and time from trial to first live sale. |

#### Plans, billing and subscription operations

| Screen | Fields and actions | Business rule |
| --- | --- | --- |
| Plans and entitlements · Pilot | Country, currency, version, billing cycle, location/register allowance, features, effective date and commercial override expiry. Preview a merchant’s effective entitlements. | A published price change creates a new version. Show which contracts move to the new price and when. |
| Subscription detail · Pilot | Trial, active, past due, grace, suspended and cancelled states. Display paid-through date, next renewal, invoice balance and branches affected. Allow authorized renewal, scheduled downgrade or cancellation. | Downgrading below current branch count opens a selection task for the owner. Preserve historical data and queued sales. Define offline expiry behaviour in the merchant agreement. |
| ERA invoices and collections · Pilot | Issue an invoice for software, record manual receipt with reference, allocate partial payments, show outstanding balance, issue a linked credit and export a statement. | Invoices keep their issued currency and amounts. Corrections are traceable. ERA subscription receipts never appear in the retailer’s checkout totals. |
| Renewal queue · Pilot | Filter invoices due, overdue, promised payment and disputed. Assign follow-up and log contact. Preview notices. | A disputed invoice can pause automated reminders. Repeated payment callbacks allocate the same payment once. Automated collection and retries are Scale. |
| Financial approvals · Pilot | Request a billing credit, override, extended trial or exceptional discount with reason, amount, requester and expiry. Finance approves or rejects. | Propose dual approval for material credits and privileged overrides. Founder sets thresholds. In a one-person pilot, log exceptions for retrospective review. |
| Revenue reports · Scale | Active paying locations, recurring software revenue by currency, trials converted, churn, outstanding receivables and credits. Drill down to subscription and invoice records. | Exclude demo accounts, one-time setup fees and shopper sales from recurring revenue. Display INR and USD separately unless an exchange-rate policy is configured. |

#### Support, reliability and platform controls

| Screen | Operator workflow | Required control |
| --- | --- | --- |
| Support desk · Pilot | Open a ticket against merchant, branch, register and affected receipt reference. Record severity, assignee, symptoms, reproduction notes, next update and resolution. | A checkout outage takes priority over a report request. Record merchant confirmation or an explicit reason for closure. |
| Support access · Pilot | Request a time-limited, branch-scoped session linked to a ticket. Record merchant authorization, permitted views, expiry and termination. | Default diagnostic view exposes device health. Finance, shopper details and sensitive settings require separate permission. Audit both operator and merchant context. |
| Device and sync monitor · Pilot | Show last heartbeat, last acknowledged event, app version, oldest queued event where reported and last error. Assign incident, inspect redacted diagnostics and verify recovery. | An offline device’s current queue depth is unknown. Show last observed value and timestamp. A replay must respect operation IDs. |
| Integration health · Pilot | See provider connection state, last successful callback or import, failed events and affected merchant. Rotate connection through an authorized setup flow. | Mask secret values, distinguish sandbox from live and audit config changes. Retries are idempotent. |
| Release centre · Pilot manual, Scale automated | Track installed versions, release notes, test cohort, target registers and rollout failures. Pause distribution and record recovery steps. | Test with offline queues and backward-compatible schema changes. Block disruptive update installation during an active sale. |
| Staff and permissions · Pilot | Invite ERA users, assign roles and regions, require strong sign-in for privileged users, revoke sessions and review active access. | Sales can manage trials. Finance can post subscription receipts. Support can diagnose a register. Release operators can deploy software. Each action needs its own server-side authorization. |
| Audit and exports · Pilot | Filter events by actor, merchant, branch, time and action. Owner data exports have scope, job status, expiry and download history. | Log privileged changes with prior/new values where appropriate, redact secrets, and limit export downloads to the authorized scope. |
| Closure and recovery · Pilot manual | Schedule offboarding, issue owner export, track outstanding sync and invoices, revoke devices and record retention/deletion tasks. Assign restore drills and document the last verified recovery point. | Cancellation and deletion are distinct actions. A restore drill uses a controlled environment and verifies receipt and stock totals before any production recovery. |

### 11. Store owner and branch admin

The merchant portal opens on the owner’s selected business date and branch. A single-shop owner may hold all merchant roles. A cashier accessing the same register receives only their assigned actions.

| Screen | Owner or manager controls | Acceptance example |
| --- | --- | --- |
| Owner home | Net sales, returns, tender mix, expected cash, settlement exceptions, stock alerts and last register sync. Compare branches and drill to receipt or event. | An offline register makes the branch total visibly provisional. |
| Business settings | Store identity, logo, receipt fields, currency, timezone, tax profile, exchange window, receipt numbering and preview. Restrict changes to authorized owner/finance roles. | A new receipt footer appears on future sales. An old receipt reprints with its original details. |
| People and approvals | Invite managers and accountants, assign branches, set cashier discount limits and refund permissions, disable staff and review override requests. | Manager approves a discount on their own branch with a reason. Another branch’s manager cannot approve it. |
| Catalog and pricing | Style, size, colour, SKU, barcode, cost, selling price, branch override, label print, bulk update preview and archive. | Updating the price of size M leaves other variants and historical sale lines intact. |
| Suppliers and receiving | Supplier profile, delivery reference, received quantities, discrepancies, cost and receiving history. Add purchase orders and supplier credits in the expansion release. | Receiving the same delivery twice prompts review. Damaged pieces stay out of sellable stock. |
| Inventory and transfers | On-hand, available and in-transit stock, count sheets, variance approval, dispatch, receipt and discrepancy owner. | If ten pieces are sent and nine arrive, both managers see one piece awaiting resolution. |
| Sales and returns | Search by receipt, register or date. Inspect sale lines, tax, discounts and payments. Reprint, approve exchange, record return reason and initiate eligible refund. | Partial return cannot exceed the original quantity or value remaining. Keep provider refund status visible until resolved. |
| Shift and cash close | Opening float, cash additions/removals, blind count, expected amount, difference, closing notes and supervisor approval. | Cash shortage records the difference and approver. Reopening a close creates an audit event. |
| Settlement and accountant centre | Import provider statement, match payments/fees/refunds, assign unmatched items, export daily journals and inspect posting history. | A payout arriving tomorrow can clear today’s pending entry without changing today’s sale. |
| Devices, subscription and help | See paired counters, setup test, invoices from ERA, renewal date, paid limits, new branch request, ticket creation and support-session approval or revocation. | Owner can revoke support access immediately and download their own subscription invoice. |
| Customer records and promotions · Expansion | Optional customer account, contact preferences, receipts, store credit and loyalty history. Owner defines offer dates, eligible items and stacking rules. | Anonymous checkout remains available. A returned item reverses associated rewards according to policy. |

### 12. Admin engineering and rollout gates

Data and API boundaries. Keep ERA operators, tenant memberships, plan versions, subscription changes, entitlement grants, subscription invoices, payment allocations, approval requests, support sessions, import jobs, register assignments, releases and audit events as identifiable records. Resolve merchant and branch authorization on every read, write, export and background job. Record effective time on commercial changes. Queue provider and email side effects only after the initiating transaction commits.

Admin screen behaviour. List screens need search, filters, pagination, meaningful empty states and an explicit loading/error state. Mutation screens should show the object affected, the requested action, any effective date and the reason. A stale edit prompts refresh before overwriting a newer decision. Disabled actions should tell the operator which role, account state or dependency is missing. Exports and imports show progress, per-row failures and a resumable outcome.

Proposed delivery sequence. During weeks 1–4 build operator roles, merchant directory, provisioning, invitations, imports, plan assignment, register pairing and audit. During weeks 5–8 add health monitoring, support tickets and assisted billing. During weeks 9–12 rehearse renewals, offboarding, recovery, support authorization and multi-merchant isolation. Automated collections, advanced revenue analytics, CRM conversion and fleet-wide rollout automation need a separate estimate. The original 12-week assumption covers the manually operated pilot only.

Admin acceptance scenarios before the first paid store

A sales operator provisions two merchant trials with identical barcodes. Neither merchant can retrieve the other’s products, exports or invoices by changing a link.

A finance operator applies a partial subscription payment and then its remaining balance. A retried posting keeps the invoice paid once. A support operator has no posting permission.

A cashier keeps a queued cash sale during an outage at renewal. After reconnection, ownership, receipt identity and the sale survive the entitlement update.

A support operator opens a ticket for a printer outage, obtains time-limited access and resolves it. Revocation ends the session and the audit trail identifies the operator.

A branch manager tries to change company-wide tax configuration and is denied. The owner changes a receipt setting and both a new receipt and historical reprint display correctly.

An owner schedules closure. ERA delivers the scoped export, reconciles outstanding sync, records revocation and keeps the retention decision separate from billing status.
