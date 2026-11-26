CREATE TABLE receipt_deliveries (
  merchant_id text NOT NULL, register_id text NOT NULL, operation_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email','sms')), recipient_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('sending','accepted','retry')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(merchant_id,register_id,operation_id,channel,recipient_hash),
  FOREIGN KEY(merchant_id,register_id,operation_id) REFERENCES cash_sales ON DELETE CASCADE
);
