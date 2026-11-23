CREATE TABLE cash_shifts (
  id TEXT PRIMARY KEY,
  register_id TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  float_minor INTEGER NOT NULL CHECK (float_minor >= 0),
  closed_at TEXT,
  counted_minor INTEGER,
  expected_minor INTEGER
);
CREATE UNIQUE INDEX one_open_cash_shift ON cash_shifts (register_id) WHERE closed_at IS NULL;

CREATE TABLE cash_receipts (
  id TEXT PRIMARY KEY,
  register_id TEXT NOT NULL,
  shift_id TEXT NOT NULL REFERENCES cash_shifts(id),
  total_minor INTEGER NOT NULL,
  envelope TEXT NOT NULL
);

CREATE TABLE cash_outbox (
  id TEXT PRIMARY KEY REFERENCES cash_receipts(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','rejected')),
  error TEXT
);
