# Windows development

Install Node.js 22.16.0 and npm 11.5.2. Run from PowerShell at the repository root.

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run lint
npm.cmd run typecheck
```

Use the ignored `.env` file for machine-specific settings. `.env.example` lists local defaults.

## Run the backend

Start Docker Desktop, then run the following commands from the repository root. Use the seed command with a local development database.

```powershell
Copy-Item .env.example .env
docker compose up -d --wait postgres
npm.cmd run build
npm.cmd run migrate -w @era/api
npm.cmd run seed -w @era/api
npm.cmd run start -w @era/api
```

In a second terminal, run `npm.cmd run worker -w @era/api` and look for `Worker ready`. In a third terminal, run `Invoke-RestMethod http://localhost:3001/v1/health` and expect version `1` and status `ok`. Rerun the seed command and use `docker compose exec -T postgres psql -U era -d era_pos -c "SELECT id, name FROM merchants ORDER BY id"` to verify the two fixture records.

Stop the API and worker with Ctrl+C. Run `docker compose down` to stop PostgreSQL and keep its data volume.

## Run the web and counter shells

```powershell
npm.cmd run dev:web
npm.cmd run build -w @era/contracts
npm.cmd run build -w @era/counter
npm.cmd run start:counter
```

Run the web and counter commands in separate terminals. Open the URL printed by Vite to switch between the merchant and operations shells. The counter displays the local SQLite schema version after startup. Quit and reopen it to reuse the database in Electron’s user data directory.

## Verify a fresh checkout

Run these commands from a fresh Windows checkout with Docker Desktop running. The backend smoke check uses the local development database. The counter smoke check creates and removes its own temporary Electron profile.

```powershell
Copy-Item .env.example .env
docker compose up -d --wait postgres
npm.cmd ci
npm.cmd run lint
npm.cmd run build
npm.cmd run typecheck
npm.cmd run smoke:api
npm.cmd run smoke:counter
```

The API smoke check applies the migrations twice, seeds twice, verifies the fixture records and starts the API and worker. The counter smoke check starts the built Windows app twice, verifies the renderer receives the schema version through preload, and checks that a SQLite setting survives the restart.

The Foundation workflow runs the PostgreSQL smoke check on Ubuntu and the Electron smoke check on Windows. Its two jobs appear on pushes to `team/ed` and on pull requests.

## Merchant scope and sync contracts

Merchant routes under `/v1/merchants/:merchantId` require an active membership and an unexpired, unrevoked bearer session for that merchant. Store only the SHA-256 digest of a random 32-byte base64url token. The API smoke check provisions short-lived sessions in synthetic records.

Owners see all branches, can reserve a register within the merchant allowance, and can request and retrieve a merchant export. Other roles see their assigned branches. A register reservation starts in `pending` and records the actor, branch, register and reason in the same database transaction. Export jobs use the merchant ID from the stored job to select branches and barcode assignments. The API checks the merchant again when retrieving the result.

See `packages/contracts/fixtures/sync-v1.json` for the version 1 envelope and acknowledgements. Use an RFC 3339 UTC timestamp with milliseconds and generate the operation UUID once, when the local operation and outbox entry commit. Keep the original envelope on retry. The cloud must verify the authenticated register belongs to the merchant and branch before applying the operation. Deduplicate by merchant, register and operation ID. Return the original commit timestamp on a matching replay and reject a changed envelope for an existing key. Send a committed acknowledgement only after the database transaction commits. Keep the operation queued after transient errors and surface rejected operations for review.

Money uses safe integer minor units. INR and USD use two decimal places. Apply round-half-away-from-zero when a calculation must convert a fractional minor unit into a payable line value, and sum the rounded line values. Payment and receipt calculations must use one currency per transaction. Checkout will define its operation-specific payload and apply the contracts.

## Run assisted onboarding

Apply migrations and start the API, then run `npm.cmd run create-operator -w @era/api -- "Pilot operator"` from a trusted terminal. The command creates an admin session valid for eight hours and prints its token once. Open ERA operations in the web app and paste the token to create a trial, set allowances, add a branch and issue the owner invitation. Share the code privately. Invitations are single-use and expire after 24 hours.

Open the merchant workspace in a separate tab. Accept the invitation, invite staff to a specific branch or reserve a register and generate an activation code. Enter that code in the Windows counter within 10 minutes. Restart the counter to verify pairing persists. If the activation response is interrupted, retry on the same counter to recover the completed pairing. Refresh the operations console to see owner acceptance and paired register counts.

The dev web server proxies API requests to port 3001. Deploy the built web app with a same-origin HTTPS reverse proxy for `/v1`. The counter defaults to the local API. For a remote API, set `ERA_API_ORIGIN` in the counter process environment to its HTTPS origin. Device authentication for sales sync and replacement recovery are future work. The merchant workspace restores its local session after a reload. End local session clears it from this browser. After expiration, use a fresh invitation for the same role and address.

## Configure GST and receipt printing

Owners can set the business identity, PNG logo, printed text, category GST percentages and inclusive pricing in **Receipt settings**. Assign HSN codes in **Catalog**, then download the updated catalog on each counter. Use the rates applicable to the store's goods. For a taxable sale, confirm the place of supply and enter buyer details when required. The sale stores its invoice number, prices, tax rules and branding for reprints and returns. This flow covers ordinary retail sales under forward charge. IRN generation, e-invoicing integration and special supplies are outside this implementation.

For a network ESC/POS printer, set `ERA_PRINTER_HOST` before launching Electron. `ERA_PRINTER_PORT` defaults to 9100. Set `ERA_PRINTER_WIDTH` to 58 or 80 in millimetres, or set it to `auto` and specify the installed queue via `ERA_PRINTER_NAME` to read its driver-reported paper size. Enable `ERA_PRINTER_DRAWER=1` for a pulse on the first cash-sale print action. A reprint or UPI receipt does not open the drawer. Without a network host the counter uses the operating system print dialog. The simulated printer test runs with `node_modules/.bin/electron tests/smoke/thermal.mjs` after building the counter.

## Publish a branch catalog

In the merchant workspace, open **Import catalog and opening stock** for the branch and preview `fixtures/catalog.csv`. Keep the header order. Supply integer minor-unit prices, optional opening quantities and optional JSON attributes with text values. Keep leading zeroes in barcodes by exporting them as text. Fix any preview issues, then confirm to publish the version. Repeating the same import returns its original version and leaves stock unchanged. A later import can add SKUs or update price and attributes. Leave opening stock blank to keep a prior quantity.

On the paired Windows counter, select **Download catalog**. For a counter paired before catalog access was added, generate a catalog access code for the active register and enter it on the same device. The counter caches the latest catalog in SQLite and can search it offline by product, SKU or barcode. The catalog shows the most recently downloaded stock quantity.

## Run cash checkout

Open a shift with an opening cash amount in minor units. Scan a barcode followed by Enter or search and add an item. Enter tendered cash and complete the sale. SQLite saves the receipt, reduces local stock and queues sync in one transaction. Use **Print receipt** or **Reprint receipt** to open the Windows print dialog from the saved sale. The receipt uses the catalog price captured at checkout. Tax calculation, legally formatted invoices and printer hardware certification remain later pilot work.

For a discount, give the merchant owner the sale ID and amount. The owner authorizes it for that register in the merchant workspace and returns an approval code to the cashier. The counter verifies the code online before accepting discounted cash. Standard cash sales can continue offline.

To close the shift, enter counted cash before viewing the expected amount and variance. Shifts and close counts are kept on the register. The counter retries queued cash sales when it comes online and periodically while sales are pending. **Sync sales** also checks manually. Rejected sales remain stored for review. Catalog updates wait for local sales to sync so a download cannot overwrite pending stock decrements. Owners can open **Register sales** in the web workspace to view the latest 100 synchronized receipts.

## Run the India UPI pilot

Set the API environment variable `ERA_RAZORPAY_ACCOUNTS` to a JSON object keyed by the ERA merchant ID. Each entry has `keyId`, `keySecret`, and `webhookSecret` for that merchant's Razorpay account. Use Razorpay test keys during setup and keep credentials in the server secret store. Configure the merchant webhook at `/v1/payments/razorpay/<merchantId>/webhook` for payment-link paid, expired and cancelled events. The API verifies the original raw body and checks current link status before updating a payment.

At an India counter, start UPI for a full-price cart and share the hosted payment link with the customer. Check status, then record the paid sale. If the link is unresolved and the customer chooses cash, confirm the cash fallback at the counter. ERA preserves the original payment attempt. A late UPI success appears as an overpayment in the merchant workspace. The owner can request a partial refund, check its status, and record the review outcome.

For settlement import, normalize the provider statement into `payment_id,gross,refunds,fees` CSV with integer paise. Enter the bank settlement reference and actual deposited amount. The review shows the gross, refunds, fees, deposit difference, and unmatched payments. A repeated reference with the same statement returns the original result. This pilot workflow uses a manual statement import and a hosted link. Provider access and settlement testing against an actual merchant account are required before rollout.

[Razorpay UPI Payment Link API](https://razorpay.com/docs/api/payments/payment-links/create-upi)

## Diagnose a stale register

Run `npm.cmd run create-operator -w @era/api -- "Pilot support" support` in a trusted terminal after applying migrations. Paste the short-lived token into **ERA support**. Paired counters report app version and queue counts about once a minute. A register appears stale after three minutes without a heartbeat. The queue shows the last observation and last acknowledged sale. Counts from an offline register describe the last report received.

Open an incident for a stale register and assign it to yourself. In the merchant workspace, the owner can load the incident under **Support incidents and access** and grant up to 60 minutes of diagnostics for that register. The operator can then load the reported queue, app version and sync timestamps. Each read is audited. Revoking a grant or resolving the incident disables further diagnostic requests. Record a reason, updates as needed, and the outcome when resolving. Keep incident messages focused on device symptoms and recovery steps.

## Architecture decisions

- Use npm workspaces with one committed lockfile and a shared strict TypeScript configuration. Each app owns its compiler and runtime settings.
- Run local PostgreSQL with Docker Compose. The API owns versioned SQL migrations. The worker uses a separate entry point in the same workspace.
- Keep SQLite and its migrations in the counter main process. The React renderer talks to it through a typed preload bridge.
- Keep merchant and platform routes in one React app. The API owns authorization. Share versioned payload schemas through `packages/contracts`.

### Cashier shifts and customer receipts

In **Team and registers**, the owner sets a six-digit PIN for each cashier. On the paired counter, choose **Refresh staff** while online. The register caches the branch roster for offline unlock. Closing a shift or leaving the counter idle for five minutes locks it. Use **Lock counter** for a handover.

For a split sale, enter the cash portion and start the UPI payment for the balance. After provider confirmation, collect the cash and record the sale. Reopening the register restores the pending payment. Returns refund the available cash portion first and route the remaining amount through the UPI provider.

Open **Register → Open customer display** for the customer screen. From a synced receipt, the cashier can send a copy at the customer's request. For email, configure `ERA_RESEND_KEY` and `ERA_RECEIPT_FROM` (or `ERA_SIGNUP_FROM`) on the API. For SMS, configure `ERA_TWILIO_ACCOUNT`, `ERA_TWILIO_TOKEN` and `ERA_SMS_FROM`. Use an international phone number including the country code.

### Receipt returns and exchanges

Sync the original sale, open a shift, and request a return on the counter using the receipt ID and SKU. An owner or assigned manager approves it in the merchant workspace. The counter checks the result and can print the completed return. For a cash difference, the cashier handles cash on completion. If a UPI refund response is delayed, use **Check provider refund** on the original request. A shift with an unresolved return stays open. Download the catalog after syncing to pick up current stock.

A counter can accept a synced receipt from another branch of the same merchant. The receiving branch must carry the returned SKUs. Its owner or assigned manager approves the request, its register handles the cash difference, and its inventory receives the goods. UPI refunds follow the original payment. If two registers used the same receipt ID, enter the original register ID from the receipt.

Returns use the original sale prices and captured taxes and allocate discounts in minor units across partial quantities. Damaged items are recorded separately from sellable stock.

### Inventory and daily close

The branch inventory accepts supplier deliveries by reference and stock counts by SKU. An owner or assigned manager approves count variances. If sellable stock moves before approval, take a fresh count. Damaged returns appear separately.

A closed shift syncs after its sales. The server uses synced cash receipts and completed cash returns and exchanges to calculate expected cash. An owner or assigned manager records a reason for a difference. Owners, assigned managers and assigned accountants can download a dated branch CSV in the branch timezone. It includes sales, returns, cash closes, matched settlement lines, provider refunds and register sync status. Settlement lines keep their import timestamp and provider reference.

### ERA billing and merchant closure

Create an operator with the `finance` role to issue ERA invoices, record manual payments by bank reference and renew a fully paid invoice. The subscription dates are UTC calendar dates. Billing status appears in the merchant workspace and the operations console. Renewal and grace keep existing register credentials and offline queues intact.

An `admin` operator starts closure from the billing console. Stop checkout, close and sync all shifts, and check pending and rejected records before revoking each device. For an unreachable device, record the reason and unsynced data risk. Resolve pending returns before revocation. After all devices are revoked, finalize closure and give the merchant owner time to download the generated archive. Merchant sessions remain available for history and export.
