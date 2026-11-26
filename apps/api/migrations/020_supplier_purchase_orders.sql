CREATE TABLE purchase_orders (
  merchant_id text NOT NULL,
  branch_id text NOT NULL,
  id uuid NOT NULL,
  reference text NOT NULL,
  supplier text NOT NULL,
  currency text NOT NULL CHECK (currency IN ('INR','USD')),
  digest text NOT NULL,
  lines jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('open','partial','received','cancelled')),
  entered_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_by text,
  cancelled_at timestamptz,
  PRIMARY KEY (merchant_id,branch_id,id),
  UNIQUE (merchant_id,branch_id,reference),
  FOREIGN KEY (merchant_id,branch_id) REFERENCES branches(merchant_id,id),
  FOREIGN KEY (merchant_id,entered_by) REFERENCES memberships(merchant_id,id),
  FOREIGN KEY (merchant_id,cancelled_by) REFERENCES memberships(merchant_id,id)
);
ALTER TABLE inventory_documents ADD COLUMN purchase_order_id uuid,
  ADD FOREIGN KEY (merchant_id,branch_id,purchase_order_id) REFERENCES purchase_orders(merchant_id,branch_id,id),
  ADD CHECK (purchase_order_id IS NULL OR kind='delivery');
