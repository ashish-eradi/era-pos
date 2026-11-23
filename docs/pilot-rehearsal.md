# Windows pilot release and recovery

## Prepare a release

Run from a Windows checkout after installing dependencies with `npm ci`.

- `npm run package:counter -- 0.1.0 --rehearsal` produces an unsigned x64 installer under `.npm-cache/releases/rehearsal/0.1.0` for an isolated Windows profile.
- `npm run package:counter -- 0.1.0` requires Windows Authenticode signing and verifies the installer signature before reporting the signed installer path. Provide the ERA release signing identity on the release machine, for example through the builder's `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` inputs.
- Install per Windows user. Before launching the counter, set the user's `ERA_API_ORIGIN` to the pilot HTTPS API. Keep the signed installer and its SHA-256 hash with the release record. Record the approved version, publisher thumbprint and target register in the pilot log.

## Install an update or roll back

1. Close the shift and resolve any active payment or return. From **Register maintenance**, select **Back up and quit for update**. Save the SQLite snapshot to a protected location. An unacknowledged sale or close remains in the snapshot and in the original profile.
2. Check the signed installer's SHA-256 with `Get-FileHash`, then use `Get-AuthenticodeSignature` to check that the status is `Valid` and that the signer matches the recorded ERA release identity. Run the installer under the same Windows user. Setup refuses to continue while the counter is running. Keep the existing application data.
3. Start the counter, check the register identity and receipts, then sync queued records before opening the next shift. Confirm the reported app version and queue counts in the support console.
4. For rollback, use the previous signed installer with a compatible SQLite schema and the same Windows profile. For an incompatible schema, preserve the current database and outbox first. Use the supported current binary to drain the outbox, then rehearse restore of the pre-update snapshot under the original Windows account. Escalate any remaining records to the release owner for reconciliation before restoring at the register.

## Recover after register loss

- For a same-PC recovery, close the counter and preserve its database and any SQLite sidecar files. Restore the saved SQLite snapshot as `counter.sqlite` into an isolated copy of the original Windows user's profile first. Check receipt IDs, queued records and the last close before restoring service. Windows encrypts the pairing credential for the original environment.
- For a replacement PC, revoke the old device in the ERA operations console. Reserve and pair a new register on the same branch. Download the current catalog and select **Recover synced branch receipts**. Check the last acknowledged receipt against the branch report and reprint it if needed.
- Compare the previous heartbeat's oldest pending time and queue size with the merchant's last receipts and cash count. If the old disk and backup are unavailable, unsynced sales and closes may be lost. Document the affected time range and reconcile with source records before resuming operation.
- To rehearse a PostgreSQL restore on the local Compose service, run `npm run build`, then `powershell -NoProfile -File scripts/rehearse-postgres.ps1`. The rehearsal uses temporary databases and verifies a restored receipt and the sellable stock balance. For a pilot restore, use the managed database backup process in a separate recovery environment, measure the recovery point and downtime, and get the branch owner to verify receipt and stock totals before switching over.

## Field checks before paid continuation

| Owner | Action and evidence |
| --- | --- |
| Release owner | Install the trusted signed build on the pilot Windows hardware. Exercise an update and rollback between shifts. Record the installed version, publisher and recovery outcome. |
| Branch manager | Disconnect and reconnect the scanner and printer. Use manual SKU search during scanner loss. Verify that a printer failure leaves the sale committed and the same receipt can be reprinted after recovery. |
| Two cashiers | Each independently opens, sells, returns an item with manager approval and submits a blind close. Reconcile both closes with the existing register for the agreed parallel period. |
| Merchant and accountant | Approve sample receipts, return records and branch CSV. Reconcile a live payout against gross payments, refunds, provider fees and the deposit. |
| Founder | Train the merchant's backup operator, share the support contact and hours, and record the merchant's paid continuation decision. |
