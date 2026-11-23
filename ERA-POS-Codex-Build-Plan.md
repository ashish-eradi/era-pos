# ERA POS build plan for Codex

## First release decision

ERA POS launches as a general retail POS for independent stores in India and the United States. Recruit across store types, including stationery, home goods, packaged grocery, apparel and footwear. Select pilot stores by the workflows they need and the hardware ERA can support. Every store can import a catalog, receive stock, scan or search an item, take payment, issue a receipt, process a return and reconcile the shift. A notebook can have a single SKU, a T-shirt can have size and colour variants, and a packaged grocery item can have a pack barcode. Demonstrate each through the same checkout and stock ledger.

Estimate 12 weeks for one controlled pilot with two engineers and part-time QA and design. Schedule each country by merchant, hardware and provider readiness. Validate the Indian and US integrations independently.

## Foundation for weeks 1–2

The repository starts with the two planning documents. Deliver work package 02 in the four phases below before starting work package 03. Merchant discovery in work package 01 can run in parallel. Use one TypeScript workspace, one lockfile and one backend deployment initially. Run the API and worker as separate local processes from the same backend codebase.

```text
era-pos/
  apps/
    counter/
      src/main/            Electron lifecycle, SQLite, device and print adapters
      src/preload/         Typed bridge for allowed counter operations
      src/renderer/        React cashier interface
      migrations/          Versioned SQLite migrations
    web/
      src/merchant/        Owner and branch staff interface
      src/platform/        ERA operations interface
    api/
      src/modules/         NestJS domain modules and HTTP endpoints
      src/worker/          Background job entry point and handlers
      migrations/          Versioned PostgreSQL migrations
  packages/
    contracts/             Versioned payload schemas and compatibility fixtures
  fixtures/                Synthetic merchants and repeatable seed data
  tests/smoke/              Process and application smoke checks
  docs/                    Setup, architecture decisions and verification
  .github/workflows/        Pull request and push verification
```

Create each directory when its phase adds code or documentation. Authorize merchant and platform operations in the API. Keep Electron renderer access to SQLite and operating system capabilities behind the preload bridge and main process. Keep PostgreSQL and SQLite migrations owned by their respective apps.

| Phase | Deliverable | Exit check | Commit message |
|---|---|---|---|
| 1. Workspace and conventions | Add root workspace configuration, pinned toolchain, lockfile, shared TypeScript and verification scripts, environment example, ignore rules and a Windows setup guide. Record decisions for package management, database tooling and app boundaries. | Follow the setup guide from a clean checkout and run the root install, lint and type-check commands. Confirm local configuration and database files stay out of Git. | `Set up the ERA POS workspace` |
| 2. Backend and local data | Scaffold NestJS API and worker entry points, configure local PostgreSQL with versioned migrations and seed two synthetic merchants. Add a versioned health response in the contracts package. | Apply migrations to a fresh database, rerun the seed without duplicating fixtures, verify API readiness with PostgreSQL and start the worker. | `Add the API and local data foundation` |
| 3. Web and Windows counter | Scaffold the React web shell and Electron counter. Add a typed preload bridge and SQLite initialization with versioned migrations. Wire each app to the development scripts. | Load the web shell, open the counter on Windows, and confirm SQLite initializes and reopens the same database after a restart. | `Add the web and Windows counter shells` |
| 4. CI and foundation handoff | Run locked installs, lint, type-check, builds and smoke checks in CI. Cover PostgreSQL startup and fixture seeding, and exercise Electron and SQLite on Windows. Document exact commands and validation results. | Verify CI passes on the pushed phase commit and reproduce the documented setup from a clean Windows checkout. | `Verify the foundation in CI` |

After each implementation phase, run its exit checks, review and stage the phase changes, and create a commit with the listed subject as the entire message. Omit attribution, co-author and sign-off trailers. Push that commit to `origin/team/ed`, confirm the branch points to it and record the commit SHA and checks. Once CI exists, verify its result before starting the next phase. If a push fails, resolve it before continuing. Apply the same checkpoint to each subsequent implementation phase.

Foundation completion means the development entry points are runnable, the two synthetic merchants seed repeatably, and CI verifies the setup. Work package 03 adds tenant authorization, audit and entitlement behavior plus the business contracts for money and sync.

## Where the code belongs

| Proposed repository area | Responsibility | Review owner |
|---|---|---|
| apps/counter | Electron, React, TypeScript and SQLite. Device pairing, cashier shift, local catalog, checkout, print and durable sync queue | Counter engineer |
| apps/web | Responsive React merchant portal and separately authorized ERA operations console | Engineer responsible for the underlying workflow |
| apps/api | NestJS API and worker entry points, PostgreSQL, merchant lifecycle, inventory ledger, sync acknowledgement, provider events and exports | Backend engineer |
| packages/contracts | Versioned API payloads, operation IDs, currency, timestamps, receipt snapshots and compatibility fixtures | Both engineers for contract changes |
| docs and test fixtures | Decisions, demo scripts, synthetic merchants, device matrix and release evidence | Product lead and QA |

Commit cash sale, stock movement and outbound event together in SQLite. Acknowledge a sync operation after the cloud transaction commits. Keep store tenders and ERA subscription collections in separate records.

## Dependency-ordered work board

Each ID is a work package. Split packages into PRs small enough to demonstrate one behavior. A dependency lists the earliest prerequisite for integration.

| ID / window | Depends on | Implementation and human owner | Evidence required to accept |
|---|---|---|---|
| 01 · W1 | — | Founder observes a shift and close. Collect anonymized single-SKU and variant catalogs, invoice, exchange and payout examples, hardware models, tender mix and baseline close time. Request provider access. | Merchant confirms the workflow and names the person who signs off at cutover. |
| 02 · W1–2 | — | Engineering lead inventories repo, records stack decisions, creates runnable development setup, CI and two synthetic merchant fixtures. | A fresh checkout starts with documented commands. CI builds and runs a smoke test. |
| 03 · W2–3 | 02 | Backend builds merchant, branch, membership, register, audit and entitlement model. Agree sync request, acknowledgement, replay and money contracts with counter engineer. | Two merchants can share a barcode. API, worker and export operations resolve the correct merchant. |
| 04 · W3–4 | 03 | ERA operator creates trial, assigns plan and limits, invites owner and sees onboarding progress. Authorized ERA admin sets store type on branch creation and can edit it later. Store country separately and use type to suggest catalog defaults in the shared POS. Owner assigns branch roles and pairs a device. | Expired or reused activation code fails. Register limit is enforced. Audit shows who activated the device. Change Apparel to Mixed retail on one branch: existing SKUs, receipts, stock and country settings survive, other branches are unaffected, and the change is audited. Reject unauthorized edits. |
| 05 · W3–4 | 01,03 | Merchant admin previews CSV errors, confirms opening stock and publishes the catalog with optional variant attributes to paired counter. | Import and sell a notebook, a packaged grocery item and a size-specific shirt. Repeat import produces identical totals. Same barcode has distinct prices for two merchants. |
| 06 · W4–6 | 04,05 | Counter engineer delivers open shift, scan, authorized discount, offline cash sale, receipt, reprint and blind close. Backend delivers sync and owner sales drill-down. | With two units on hand, sell one offline, restart, reprint and reconnect twice. Exactly one sale, one stock decrement and one unit remaining. Second merchant sees none of it. |
| 07 · W5–8 | 04,06 for live diagnostics | ERA support builds stale-device queue, incident assignment, ticket history, scoped expiring support access. Owner can revoke access. | Offline register appears stale. Revocation ends access. Ticket records operator, reason and outcome. |
| 08 · W7–8 | 06, provider sandbox | Payments engineer integrates the pilot tender (merchant UPI in India or a supported terminal in the US), status lookup, verified callbacks, partial refunds, settlement import and exception review. | Delayed success after alternate tender opens an overpayment case. Duplicate callback and statement import preserve totals. Match gross, refunds, fees and net deposit. |
| 09 · W7–9 | 06,08 for digital refunds | Counter and merchant admin add receipt-linked returns, exchanges, damaged stock, manager approval and original tax/discount snapshots. | Two partial returns cannot exceed quantity sold. Exchange difference and stock disposition agree with the receipt. |
| 10 · W8–10 | 05,06,08 | Branch manager receives stock, counts and approves discrepancies. Owner reviews close and provisional totals. Accountant downloads dated branch export. | Duplicate delivery is flagged. Closing shortage has approver. Accountant reconciles one day across receipts, shifts and settlements. |
| 11 · W6–10 | 04,06 | ERA finance records subscription invoices, partial payments, renewal, grace and closure. Operations handles merchant export, pending sync and device revocation. | Retried partial payment posts once. Renewal during outage preserves queued sale. Support role cannot post payment. Closed tenant receives scoped export. |
| 12 · W9–12 | 06–11 | Release owner tests signed installer, update at shift boundary, backup, restore, rollback, hardware failure and first parallel closes. Founder handles training and paid continuation. | Restore acknowledged records to a replacement PC. Document unsynced exposure. Two cashiers independently complete shift. Merchant and accountant accept sample records; live payout reconciles. |

## After the single-store gate

**Second branch.** Build dispatch, in-transit stock, receipt and discrepancy resolution, stock lookup with last-sync time and centrally authorized cross-store returns. Dispatch ten and receive nine. One unit remains traceable. Two branches attempting the last return concurrently can authorize only one. Re-estimate if a two-store pilot is contracted for the initial window.

**First US store.** Select the merchant, state and locality, processor and supported terminal. Reuse checkout and stock contracts. Implement the local tax and receipt adapter, exemptions, original-tax refunds and bookkeeper export. Test approval, decline, interruption, refund and settlement on the chosen terminal. Gate launch on local sample approval, reconciled payout, trained staff and support coverage.

**Expansion queue.** Prioritize additional devices, self-service billing, automated collections, loyalty, purchase orders, accounting connectors and other retail verticals using paid demand and measured support effort.

## How to coordinate each Codex session

1. Founder or product lead selects one ready ticket and supplies the merchant example and pass condition. Put unresolved store policy decisions in the issue so Codex can identify the affected behavior.
2. Give one person ownership of the ticket, branch and PR. The backend engineer owns cloud migrations. The counter engineer owns SQLite migrations. When both sides need a contract, merge its versioned fixture first; each side can then build against the same example.
3. Codex reads AGENTS.md and existing code, implements through the normal UI or API, runs relevant checks and records exact results. Track tickets as Ready → In progress → In review → Accepted. Record external blockers with an owner and the work that can proceed.
4. The reviewer replays the acceptance example from a clean fixture. For a financial or stock change, compare before/after records and replay the operation. For admin work, demonstrate an allowed role and a denied role.
5. Merge accepted work, demo the integrated flow each week and record the commit, test evidence, unresolved risks and next ready ticket in the board. Founder or merchant accepts workflow behavior. Engineering accepts code and deployability.

### Paste into Codex for the first implementation session

> Start work package 02 with Phase 1 in the foundation plan. Inspect the working tree and read AGENTS.md if present. Complete the phase exit check, commit with the listed subject only, and push and verify the commit before proceeding. Repeat for each foundation phase. Report the pushed SHAs, verification results and any remaining blockers for work package 03.

### Reusable ticket prompt

> Implement ERA POS ticket [ID] on [branch]. Read AGENTS.md, the accepted dependency PRs and [contract or fixture]. The actor is [role] at [merchant and branch]. Starting from [fixture], perform [action]. Expected visible outcome is [result]; expected persisted changes are [records and quantities]. Exercise [retry, denied role, outage or other relevant failure]. Deliver one reviewable PR with setup, demo steps, actual checks run and remaining limitations. Escalate unresolved merchant policy to [owner].

## Pilot decision

Track baseline and pilot median close time, missing or duplicate sales, outstanding settlement differences, support minutes per location and paid renewals. The software plan proposes three paid stores, 30% faster median close, zero unexplained duplicate or missing transactions and two renewals as commercial validation targets. The first store can go live after its own engineering, operational and merchant acceptance gates; subsequent stores supply the remaining commercial evidence.
