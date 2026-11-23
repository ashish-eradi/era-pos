CREATE TABLE branch_catalog (
    merchant_id text NOT NULL,
    branch_id text NOT NULL,
    sku text NOT NULL,
    product text NOT NULL,
    barcode text NOT NULL,
    price_minor integer NOT NULL CHECK (price_minor >= 0),
    attributes jsonb NOT NULL CHECK (jsonb_typeof(attributes) = 'object'),
    PRIMARY KEY (merchant_id, branch_id, sku),
    UNIQUE (merchant_id, branch_id, barcode),
    FOREIGN KEY (merchant_id, branch_id) REFERENCES branches(merchant_id, id),
    FOREIGN KEY (merchant_id, barcode) REFERENCES catalog_barcodes(merchant_id, barcode)
);
CREATE TABLE stock_movements (
    merchant_id text NOT NULL,
    branch_id text NOT NULL,
    sku text NOT NULL,
    id uuid NOT NULL,
    kind text NOT NULL CHECK (kind = 'opening'),
    quantity integer NOT NULL CHECK (quantity >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (merchant_id, branch_id, id),
    FOREIGN KEY (merchant_id, branch_id, sku) REFERENCES branch_catalog(merchant_id, branch_id, sku)
);
CREATE UNIQUE INDEX stock_opening_per_sku ON stock_movements (merchant_id, branch_id, sku) WHERE kind = 'opening';
CREATE TABLE catalog_imports (
    merchant_id text NOT NULL,
    branch_id text NOT NULL,
    digest text NOT NULL,
    membership_id text NOT NULL,
    version bigint NOT NULL CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (merchant_id, branch_id, digest),
    UNIQUE (merchant_id, branch_id, version),
    FOREIGN KEY (merchant_id, branch_id) REFERENCES branches(merchant_id, id),
    FOREIGN KEY (merchant_id, membership_id) REFERENCES memberships(merchant_id, id)
);
