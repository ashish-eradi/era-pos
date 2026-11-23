CREATE TABLE local_returns (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES cash_shifts(id),
  draft TEXT NOT NULL,
  receipt TEXT
);
