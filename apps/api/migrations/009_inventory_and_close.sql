ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_direction;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_direction CHECK (
    (kind = 'opening' AND quantity >= 0)
    OR (kind IN ('cash_sale','exchange_sale') AND quantity < 0)
    OR (kind IN ('return','return_damaged','delivery') AND quantity > 0)
    OR (kind = 'stock_count' AND quantity <> 0)
);
CREATE INDEX stock_movements_sku ON stock_movements (merchant_id,branch_id,sku);

CREATE TABLE inventory_documents (
    merchant_id text NOT NULL,
    branch_id text NOT NULL,
    id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('delivery','count')),
    reference text NOT NULL,
    digest text NOT NULL,
    lines jsonb NOT NULL,
    entered_by text NOT NULL,
    approved_by text,
    approval_note text,
    approved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (merchant_id,branch_id,id),
    UNIQUE (merchant_id,branch_id,kind,reference),
    FOREIGN KEY (merchant_id,branch_id) REFERENCES branches(merchant_id,id),
    FOREIGN KEY (merchant_id,entered_by) REFERENCES memberships(merchant_id,id),
    FOREIGN KEY (merchant_id,approved_by) REFERENCES memberships(merchant_id,id)
);

CREATE TABLE shift_closes (
    merchant_id text NOT NULL,
    branch_id text NOT NULL,
    register_id text NOT NULL,
    id uuid NOT NULL,
    opened_at timestamptz NOT NULL,
    closed_at timestamptz NOT NULL CHECK (closed_at >= opened_at),
    float_minor bigint NOT NULL CHECK (float_minor >= 0),
    counted_minor bigint NOT NULL CHECK (counted_minor >= 0),
    expected_minor bigint NOT NULL,
    approved_by text,
    approval_note text,
    approved_at timestamptz,
    digest text NOT NULL,
    PRIMARY KEY (merchant_id,register_id,id),
    FOREIGN KEY (merchant_id,branch_id,register_id) REFERENCES registers(merchant_id,branch_id,id),
    FOREIGN KEY (merchant_id,approved_by) REFERENCES memberships(merchant_id,id)
);
CREATE INDEX shift_closes_branch_time ON shift_closes (merchant_id,branch_id,closed_at);
CREATE INDEX cash_sales_shift ON cash_sales (merchant_id,register_id,(receipt->>'shiftId'));
ALTER TABLE upi_refunds ADD COLUMN resolved_at timestamptz;
