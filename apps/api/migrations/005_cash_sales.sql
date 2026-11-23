ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_kind_check;
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_quantity_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_direction
    CHECK ((kind = 'opening' AND quantity >= 0) OR (kind = 'cash_sale' AND quantity < 0));

CREATE TABLE cash_sales (
    merchant_id text NOT NULL,
    branch_id text NOT NULL,
    register_id text NOT NULL,
    operation_id uuid NOT NULL,
    occurred_at timestamptz NOT NULL,
    committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    digest text NOT NULL,
    receipt jsonb NOT NULL,
    PRIMARY KEY (merchant_id, register_id, operation_id),
    FOREIGN KEY (merchant_id, branch_id, register_id) REFERENCES registers(merchant_id, branch_id, id)
);
CREATE INDEX cash_sales_merchant_time ON cash_sales (merchant_id, occurred_at DESC, operation_id);

CREATE TABLE cash_discount_approvals (
    merchant_id text NOT NULL,
    branch_id text NOT NULL,
    register_id text NOT NULL,
    operation_id uuid NOT NULL,
    membership_id text NOT NULL,
    digest text NOT NULL,
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    PRIMARY KEY (merchant_id, register_id, operation_id),
    FOREIGN KEY (merchant_id, branch_id, register_id) REFERENCES registers(merchant_id, branch_id, id),
    FOREIGN KEY (merchant_id, membership_id) REFERENCES memberships(merchant_id, id)
);
