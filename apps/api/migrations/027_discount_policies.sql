CREATE TABLE discount_policies (
  merchant_id text NOT NULL REFERENCES merchants(id),
  id uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  policy jsonb NOT NULL,
  PRIMARY KEY(merchant_id,id)
);
CREATE TABLE register_discount_policies (
  merchant_id text NOT NULL, register_id text NOT NULL, policy_id uuid NOT NULL,
  downloaded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  PRIMARY KEY(merchant_id,register_id,policy_id),
  FOREIGN KEY(merchant_id,policy_id) REFERENCES discount_policies(merchant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(merchant_id,register_id) REFERENCES registers(merchant_id,id) ON DELETE CASCADE
);
CREATE INDEX discount_policy_latest ON discount_policies(merchant_id,published_at DESC);
