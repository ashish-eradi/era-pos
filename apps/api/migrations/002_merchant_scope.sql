CREATE TABLE branches (
    merchant_id text NOT NULL REFERENCES merchants(id),
    id text NOT NULL,
    name text NOT NULL,
    timezone text NOT NULL,
    PRIMARY KEY (merchant_id, id)
);

CREATE TABLE memberships (
    merchant_id text NOT NULL REFERENCES merchants(id),
    id text NOT NULL,
    subject_id text NOT NULL,
    role text NOT NULL CHECK (role IN ('owner', 'manager', 'cashier', 'accountant')),
    active boolean NOT NULL DEFAULT true,
    PRIMARY KEY (merchant_id, id),
    UNIQUE (merchant_id, subject_id)
);

CREATE TABLE branch_assignments (
    merchant_id text NOT NULL,
    membership_id text NOT NULL,
    branch_id text NOT NULL,
    PRIMARY KEY (merchant_id, membership_id, branch_id),
    FOREIGN KEY (merchant_id, membership_id) REFERENCES memberships(merchant_id, id),
    FOREIGN KEY (merchant_id, branch_id) REFERENCES branches(merchant_id, id)
);

CREATE TABLE membership_sessions (
    token_digest text PRIMARY KEY,
    merchant_id text NOT NULL,
    membership_id text NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    FOREIGN KEY (merchant_id, membership_id) REFERENCES memberships(merchant_id, id)
);

CREATE TABLE entitlements (
    merchant_id text PRIMARY KEY REFERENCES merchants(id),
    plan_code text NOT NULL,
    register_limit integer NOT NULL CHECK (register_limit >= 0)
);

CREATE TABLE registers (
    merchant_id text NOT NULL,
    id text NOT NULL,
    branch_id text NOT NULL,
    name text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
    PRIMARY KEY (merchant_id, id),
    UNIQUE (merchant_id, branch_id, id),
    FOREIGN KEY (merchant_id, branch_id) REFERENCES branches(merchant_id, id)
);

CREATE TABLE catalog_barcodes (
    merchant_id text NOT NULL REFERENCES merchants(id),
    barcode text NOT NULL,
    sku text NOT NULL,
    PRIMARY KEY (merchant_id, barcode)
);

CREATE TABLE merchant_audit (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    merchant_id text NOT NULL,
    membership_id text NOT NULL,
    branch_id text NOT NULL,
    register_id text NOT NULL,
    action text NOT NULL,
    reason text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (merchant_id, membership_id) REFERENCES memberships(merchant_id, id),
    FOREIGN KEY (merchant_id, branch_id, register_id) REFERENCES registers(merchant_id, branch_id, id)
);

CREATE TABLE merchant_exports (
    merchant_id text NOT NULL,
    id text NOT NULL,
    membership_id text NOT NULL,
    requested_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    result jsonb,
    PRIMARY KEY (merchant_id, id),
    FOREIGN KEY (merchant_id, membership_id) REFERENCES memberships(merchant_id, id),
    CHECK ((completed_at IS NULL) = (result IS NULL))
);

CREATE INDEX merchant_exports_pending ON merchant_exports (requested_at, merchant_id, id)
    WHERE completed_at IS NULL;
