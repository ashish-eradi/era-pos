ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_direction;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_direction CHECK (
    (kind = 'opening' AND quantity >= 0)
    OR (kind IN ('cash_sale','exchange_sale') AND quantity < 0)
    OR (kind IN ('return','return_damaged') AND quantity > 0)
);

CREATE TABLE sale_returns (
    merchant_id text NOT NULL,
    branch_id text NOT NULL,
    id uuid NOT NULL,
    register_id text NOT NULL,
    shift_id uuid NOT NULL,
    sale_register_id text NOT NULL,
    sale_id uuid NOT NULL,
    digest text NOT NULL,
    reason text NOT NULL,
    receipt jsonb NOT NULL,
    status text NOT NULL DEFAULT 'requested'
        CHECK (status IN ('requested','pending_refund','complete','failed','cancelled')),
    approved_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    PRIMARY KEY (merchant_id,id),
    FOREIGN KEY (merchant_id,branch_id,register_id) REFERENCES registers(merchant_id,branch_id,id),
    FOREIGN KEY (merchant_id,sale_register_id,sale_id) REFERENCES cash_sales(merchant_id,register_id,operation_id),
    FOREIGN KEY (merchant_id,approved_by) REFERENCES memberships(merchant_id,id)
);
CREATE INDEX sale_returns_receipt ON sale_returns (merchant_id,sale_register_id,sale_id);
