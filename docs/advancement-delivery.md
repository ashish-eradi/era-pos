# Pilot advancement delivery

## Immediate sprint

| Deliverable | Implementation | Verification |
|---|---|---|
| Cash lifecycle, UPI and returns | Vitest starts the API, worker, PostgreSQL fixtures and simulated payment provider. The cash scenario uses the actual counter database and synchronization code. | Build all workspaces, set `DATABASE_URL` to the test database, then run `npm run test:integration`. |
| Recoverable rendering errors | Shared React boundary around both renderers with a workspace reload action. | Web and counter type checks and production builds. |
| Five request schemas | Validate invitation acceptance, activation, pairing recovery, device catalog download and cash-sale envelopes. Existing receipt checks still produce per-operation acknowledgements. | The integration suite exercises these endpoints through their normal clients. |
| Merchant catalog view | Existing editable table loads on entry and supports SKU, product and barcode search, attribute filters and sorting. | `npm run smoke:web` exercises branch selection, catalog load and filtering in Chromium. |
| Keyboard checkout and sale parking | F1–F4 select a workspace, F5 focuses search, F8 opens a shift, F9 submits a valid cash form, F10 starts blind close and Escape offers to clear the cart. Parked lines use SQLite and retain their operation ID until checkout commits. | `npm run smoke:counter` exercises the renderer. The integration suite checks the resulting receipt, stock and draft removal. |
| Offline queue follow-up | Register-scoped retry, timestamps, transport errors and visible pending or rejection messages. | The counter smoke checks the stored failed attempt after restart. The integration suite verifies targeted retry. |

## Remaining phase work

| Phase | Delivery sequence | Completion evidence |
|---|---|---|
| 1. Pilot reliability | Measure coverage in the API and counter processes, add uncovered error and replay cases, expand request schemas and limit pairing attempts. Use the existing 15-minute heartbeat endpoint and minute polling for the operator alert. | Coverage report for each named module, throttling tests and a register-disconnect rehearsal. |
| 2. Counter workflow | Complete receipt date and ID search, line deletion and quantity controls, touch sizing, optional sound, loading feedback and dark mode. | Cashier completes a sale, parks another, restarts offline, resumes it and finds both receipts. |
| 3. Merchant operations | Extend the existing versioned catalog API with barcode and attribute changes, single-item creation, archival and atomic bulk pricing. Extend inventory references, return decisions and reporting drilldowns. | Two branches retain isolated catalogs. Old receipts preserve their original lines. Tender totals and product reports reconcile to daily close. |
| 4. Production readiness | Preserve the current database-backed sessions while implementing credential migration, refresh and revocation. Add origin controls, query measurement, restore testing, staging deployment and shift-aware signed updates. | Existing invitations and devices continue to work. Staging demonstrates session revocation, backup restore and update rollback. |
| 5. Multi-branch operations | Build dispatch and receipt transactions, discrepancy review, overdue-transfer tracking and cross-branch return reservations. Reuse branch shift commands and paid signup already in service. | Two real branch identities reconcile dispatched, received and damaged stock under retries and concurrent returns. |
| 6. Market readiness | Configure pilot jurisdictions and tax providers, store sale-time tax details for refunds, verify printer profiles, and map accounting postings with external idempotency keys. | Provider sandbox invoices, matching original-tax refunds, physical printer output and accountant-reviewed exports and postings. |

Staging promotion needs a deployment target and release credentials. Market verification needs the pilot jurisdictions, provider sandbox accounts, printer models and accounting test company. Pricing and the live signup sender remain deferred.
