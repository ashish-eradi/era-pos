ALTER TABLE merchants ADD COLUMN legal_name text;
ALTER TABLE branches ADD COLUMN store_type text NOT NULL DEFAULT 'mixed'
    CHECK (store_type IN ('mixed', 'apparel', 'stationery', 'home_goods', 'packaged_grocery'));
ALTER TABLE entitlements ADD COLUMN branch_limit integer NOT NULL DEFAULT 1 CHECK (branch_limit >= 0);
ALTER TABLE registers ADD COLUMN device_id uuid;
ALTER TABLE registers ADD COLUMN activated_at timestamptz;
ALTER TABLE registers ADD COLUMN pairing_digest text;
CREATE UNIQUE INDEX registers_active_device ON registers (device_id) WHERE status = 'active';

CREATE TABLE platform_operators (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    role text NOT NULL CHECK (role IN ('admin', 'support'))
);
CREATE TABLE platform_sessions (
    digest text PRIMARY KEY,
    operator_id uuid NOT NULL REFERENCES platform_operators(id),
    expires_at timestamptz NOT NULL
);
CREATE TABLE trials (
    merchant_id text PRIMARY KEY REFERENCES merchants(id),
    operator_id uuid NOT NULL REFERENCES platform_operators(id),
    request_id uuid NOT NULL UNIQUE,
    request_hash text NOT NULL,
    owner_email text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE invitations (
    digest text PRIMARY KEY,
    merchant_id text NOT NULL REFERENCES merchants(id),
    branch_id text,
    email text NOT NULL,
    role text NOT NULL CHECK (role IN ('owner', 'manager', 'cashier', 'accountant')),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    FOREIGN KEY (merchant_id, branch_id) REFERENCES branches(merchant_id, id),
    CHECK ((role = 'owner') = (branch_id IS NULL))
);
CREATE UNIQUE INDEX invitations_open_owner ON invitations (merchant_id) WHERE role = 'owner' AND consumed_at IS NULL;

CREATE TABLE activation_codes (
    digest text PRIMARY KEY,
    merchant_id text NOT NULL,
    branch_id text NOT NULL,
    register_id text NOT NULL,
    membership_id text NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    FOREIGN KEY (merchant_id, branch_id, register_id) REFERENCES registers(merchant_id, branch_id, id),
    FOREIGN KEY (merchant_id, membership_id) REFERENCES memberships(merchant_id, id)
);
CREATE UNIQUE INDEX activation_codes_open ON activation_codes (merchant_id, register_id) WHERE consumed_at IS NULL;

CREATE TABLE onboarding_audit (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    merchant_id text NOT NULL REFERENCES merchants(id),
    branch_id text,
    operator_id uuid REFERENCES platform_operators(id),
    membership_id text,
    action text NOT NULL,
    details jsonb NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (merchant_id, branch_id) REFERENCES branches(merchant_id, id),
    FOREIGN KEY (merchant_id, membership_id) REFERENCES memberships(merchant_id, id),
    CHECK ((operator_id IS NULL) <> (membership_id IS NULL))
);
