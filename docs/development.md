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

## Architecture decisions

- Use npm workspaces with one committed lockfile and a shared strict TypeScript configuration. Each app owns its compiler and runtime settings.
- Run local PostgreSQL with Docker Compose. The API owns versioned SQL migrations. The worker uses a separate entry point in the same workspace.
- Keep SQLite and its migrations in the counter main process. The React renderer talks to it through a typed preload bridge.
- Keep merchant and platform routes in one React app. The API owns authorization. Share versioned payload schemas through `packages/contracts`.
