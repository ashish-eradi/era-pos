CREATE TABLE merchants (
    id text PRIMARY KEY,
    name text NOT NULL,
    country_code text NOT NULL CHECK (country_code IN ('IN', 'US'))
);
