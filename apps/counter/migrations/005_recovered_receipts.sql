CREATE TABLE recovered_receipts (
  merchant_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  register_id TEXT NOT NULL,
  id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  envelope TEXT NOT NULL,
  PRIMARY KEY (merchant_id,branch_id,register_id,id)
);
CREATE INDEX recovered_receipts_history ON recovered_receipts (merchant_id,branch_id,occurred_at DESC);
