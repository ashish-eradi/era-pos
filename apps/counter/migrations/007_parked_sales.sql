CREATE TABLE parked_sales (
  register_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  lines TEXT NOT NULL,
  parked_at TEXT NOT NULL,
  PRIMARY KEY(register_id,operation_id)
);
