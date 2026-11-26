ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_direction;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_direction CHECK (
    (kind = 'opening' AND quantity >= 0)
    OR (kind IN ('cash_sale','exchange_sale','transfer_out') AND quantity < 0)
    OR (kind IN ('return','return_damaged','delivery','transfer_in') AND quantity > 0)
    OR (kind = 'stock_count' AND quantity <> 0)
);
CREATE TABLE stock_transfers (
  merchant_id text NOT NULL,
  id uuid NOT NULL,
  origin text NOT NULL,
  destination text NOT NULL CHECK (destination <> origin),
  reference text NOT NULL,
  digest text NOT NULL,
  lines jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('in_transit','partial','received','short')),
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_by text NOT NULL,
  shortage_note text,
  closed_by text,
  PRIMARY KEY (merchant_id,id),
  UNIQUE (merchant_id,origin,reference),
  FOREIGN KEY (merchant_id,origin) REFERENCES branches(merchant_id,id),
  FOREIGN KEY (merchant_id,destination) REFERENCES branches(merchant_id,id),
  FOREIGN KEY (merchant_id,dispatched_by) REFERENCES memberships(merchant_id,id),
  FOREIGN KEY (merchant_id,closed_by) REFERENCES memberships(merchant_id,id)
);
CREATE INDEX stock_transfers_destination ON stock_transfers(merchant_id,destination,created_at);
CREATE TABLE stock_transfer_receipts (
  merchant_id text NOT NULL,
  transfer_id uuid NOT NULL,
  reference text NOT NULL,
  lines jsonb NOT NULL,
  received_by text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id,transfer_id,reference),
  FOREIGN KEY (merchant_id,transfer_id) REFERENCES stock_transfers(merchant_id,id),
  FOREIGN KEY (merchant_id,received_by) REFERENCES memberships(merchant_id,id)
);
