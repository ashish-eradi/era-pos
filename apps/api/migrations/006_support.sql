CREATE TABLE register_health (
    merchant_id text NOT NULL,
    branch_id text NOT NULL,
    register_id text NOT NULL,
    observed_at timestamptz NOT NULL,
    app_version text NOT NULL,
    pending_count integer NOT NULL CHECK (pending_count >= 0),
    rejected_count integer NOT NULL CHECK (rejected_count >= 0),
    oldest_pending_at timestamptz,
    PRIMARY KEY (merchant_id, register_id),
    FOREIGN KEY (merchant_id, branch_id, register_id) REFERENCES registers(merchant_id, branch_id, id)
);
CREATE TABLE support_tickets (
    id uuid PRIMARY KEY,
    merchant_id text NOT NULL,
    branch_id text NOT NULL,
    register_id text NOT NULL,
    assignee uuid REFERENCES platform_operators(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    UNIQUE (merchant_id, branch_id, id),
    FOREIGN KEY (merchant_id, branch_id, register_id) REFERENCES registers(merchant_id, branch_id, id)
);
CREATE INDEX support_tickets_merchant ON support_tickets (merchant_id, created_at DESC);
CREATE TABLE support_grants (
    id uuid PRIMARY KEY,
    merchant_id text NOT NULL,
    branch_id text NOT NULL,
    ticket_id uuid NOT NULL,
    operator_id uuid NOT NULL REFERENCES platform_operators(id),
    membership_id text NOT NULL,
    reason text NOT NULL,
    granted_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    FOREIGN KEY (merchant_id, branch_id, ticket_id) REFERENCES support_tickets(merchant_id, branch_id, id),
    FOREIGN KEY (merchant_id, membership_id) REFERENCES memberships(merchant_id, id)
);
CREATE INDEX support_grants_ticket ON support_grants (ticket_id, operator_id, expires_at);
CREATE TABLE support_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    merchant_id text NOT NULL,
    branch_id text NOT NULL,
    ticket_id uuid NOT NULL,
    operator_id uuid REFERENCES platform_operators(id),
    membership_id text,
    kind text NOT NULL CHECK (kind IN ('opened','assigned','noted','resolved','granted','revoked','diagnostics_viewed')),
    message text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (merchant_id, branch_id, ticket_id) REFERENCES support_tickets(merchant_id, branch_id, id),
    FOREIGN KEY (merchant_id, membership_id) REFERENCES memberships(merchant_id, id),
    CHECK ((operator_id IS NULL) <> (membership_id IS NULL))
);
CREATE INDEX support_events_ticket ON support_events (ticket_id, id);
