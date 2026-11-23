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

The dev web server proxies API requests to port 3001. Deploy the built web app with a same-origin HTTPS reverse proxy for `/v1`. The counter defaults to the local API. For a remote API, set `ERA_API_ORIGIN` in the counter process environment to its HTTPS origin. Device authentication for sales sync and replacement recovery are future work. Browser sessions stay in memory. After a reload or expiration, use a fresh invitation for the same role and address.

## Architecture decisions

- Use npm workspaces with one committed lockfile and a shared strict TypeScript configuration. Each app owns its compiler and runtime settings.
- Run local PostgreSQL with Docker Compose. The API owns versioned SQL migrations. The worker uses a separate entry point in the same workspace.
- Keep SQLite and its migrations in the counter main process. The React renderer talks to it through a typed preload bridge.
- Keep merchant and platform routes in one React app. The API owns authorization. Share versioned payload schemas through `packages/contracts`.
