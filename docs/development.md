# Windows development

Install Node.js 22.16.0 and npm 11.5.2. Run from PowerShell at the repository root.

```powershell
npm.cmd ci
npm.cmd run lint
npm.cmd run typecheck
```

Use the ignored `.env` file for machine-specific settings. `.env.example` lists local defaults.

## Architecture decisions

- Use npm workspaces with one committed lockfile and a shared strict TypeScript configuration. Each app owns its compiler and runtime settings.
- Run local PostgreSQL with Docker Compose. The API owns versioned SQL migrations. The worker uses a separate entry point in the same workspace.
- Keep SQLite and its migrations in the counter main process. The React renderer talks to it through a typed preload bridge.
- Keep merchant and platform routes in one React app. The API owns authorization. Share versioned payload schemas through `packages/contracts`.
