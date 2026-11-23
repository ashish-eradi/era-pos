CREATE TABLE upi_attempts (
  merchant_id text NOT NULL,
  branch_id text NOT NULL,
  register_id text NOT NULL,
  operation_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  link_id text,
  short_url text,
  payment_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','expired','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  review_note text,
  reviewed_by text,
  PRIMARY KEY (merchant_id, register_id, operation_id),
  UNIQUE (merchant_id, operation_id),
  UNIQUE (merchant_id, link_id),
  UNIQUE (merchant_id, payment_id),
  FOREIGN KEY (merchant_id, branch_id, register_id) REFERENCES registers(merchant_id, branch_id, id),
  FOREIGN KEY (merchant_id, reviewed_by) REFERENCES memberships(merchant_id, id)
);
CREATE TABLE upi_events (
  merchant_id text NOT NULL REFERENCES merchants(id),
  event_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, event_id)
);
CREATE TABLE upi_refunds (
  merchant_id text NOT NULL,
  register_id text NOT NULL,
  operation_id uuid NOT NULL,
  id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  provider_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','failed')),
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id,id),
  FOREIGN KEY (merchant_id,register_id,operation_id) REFERENCES upi_attempts(merchant_id,register_id,operation_id),
  FOREIGN KEY (merchant_id,requested_by) REFERENCES memberships(merchant_id,id)
);
CREATE TABLE upi_settlements (
  merchant_id text NOT NULL REFERENCES merchants(id),
  reference text NOT NULL,
  digest text NOT NULL,
  statement jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id,reference)
);
