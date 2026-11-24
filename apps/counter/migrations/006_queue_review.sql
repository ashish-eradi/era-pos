ALTER TABLE cash_receipts ADD COLUMN rejection_reason TEXT;
ALTER TABLE cash_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
