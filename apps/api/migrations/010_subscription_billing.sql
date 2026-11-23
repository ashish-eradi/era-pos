ALTER TABLE platform_operators DROP CONSTRAINT platform_operators_role_check;
ALTER TABLE platform_operators ADD CONSTRAINT platform_operators_role_check CHECK (role IN ('admin','support','finance'));

CREATE TABLE subscriptions (
    merchant_id text PRIMARY KEY REFERENCES merchants(id),
    paid_through date,
    grace_until date,
    closure_started_at timestamptz,
    closed_at timestamptz,
    closure_export_id text,
    FOREIGN KEY (merchant_id,closure_export_id) REFERENCES merchant_exports(merchant_id,id),
    CHECK (grace_until IS NULL OR (paid_through IS NOT NULL AND grace_until >= paid_through)),
    CHECK ((closure_export_id IS NULL) = (closed_at IS NULL)),
    CHECK (closed_at IS NULL OR closure_started_at IS NOT NULL)
);

CREATE TABLE subscription_invoices (
    merchant_id text NOT NULL REFERENCES merchants(id),
    id uuid NOT NULL,
    reference text NOT NULL,
    currency text NOT NULL CHECK (currency IN ('INR','USD')),
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    due_date date NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    issued_by uuid NOT NULL REFERENCES platform_operators(id),
    renewed_at timestamptz,
    renewal_paid_through date,
    renewal_grace_until date,
    PRIMARY KEY (merchant_id,id),
    UNIQUE (merchant_id,reference)
);

CREATE TABLE subscription_payments (
    merchant_id text NOT NULL,
    invoice_id uuid NOT NULL,
    reference text NOT NULL,
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    recorded_by uuid NOT NULL REFERENCES platform_operators(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (merchant_id,reference),
    FOREIGN KEY (merchant_id,invoice_id) REFERENCES subscription_invoices(merchant_id,id)
);

CREATE TABLE subscription_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    merchant_id text NOT NULL REFERENCES merchants(id),
    operator_id uuid NOT NULL REFERENCES platform_operators(id),
    action text NOT NULL,
    details jsonb NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE merchant_exports ADD COLUMN kind text NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard','archive'));
