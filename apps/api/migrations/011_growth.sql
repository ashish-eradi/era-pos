CREATE TABLE merchant_webhooks (
  merchant_id text PRIMARY KEY REFERENCES merchants(id) ON DELETE CASCADE,
  url text NOT NULL, signing_key text NOT NULL
);
CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id text NOT NULL REFERENCES merchant_webhooks(merchant_id) ON DELETE CASCADE,
  event text NOT NULL, payload jsonb NOT NULL, attempts integer NOT NULL DEFAULT 0,
  next_attempt timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_due ON webhook_deliveries(next_attempt);
ALTER TABLE trials ALTER COLUMN operator_id DROP NOT NULL;
CREATE TABLE signup_plans (
  code text PRIMARY KEY, currency text NOT NULL CHECK(currency IN ('USD','INR')),
  amount integer NOT NULL CHECK(amount>0), days integer NOT NULL CHECK(days>0),
  branches integer NOT NULL CHECK(branches>0), registers integer NOT NULL CHECK(registers>0),
  available boolean NOT NULL DEFAULT true
);
CREATE TABLE merchant_signups (
  email text PRIMARY KEY, id uuid UNIQUE NOT NULL DEFAULT gen_random_uuid(), code_hash text UNIQUE NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(), session_hash text UNIQUE, session_expires timestamptz,
  name text, plan jsonb, link_id text UNIQUE, next_check timestamptz DEFAULT now(),
  merchant_id text REFERENCES merchants(id), member_id text
);
CREATE FUNCTION queue_merchant_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO webhook_deliveries(merchant_id,event,payload)
    SELECT NEW.merchant_id,TG_ARGV[0],to_jsonb(NEW) - 'digest'
    FROM merchant_webhooks WHERE merchant_id=NEW.merchant_id;
  RETURN NEW;
END $$;
CREATE TRIGGER sale_webhook AFTER INSERT ON cash_sales FOR EACH ROW EXECUTE FUNCTION queue_merchant_event('sale.created');
CREATE TRIGGER close_webhook AFTER INSERT ON shift_closes FOR EACH ROW EXECUTE FUNCTION queue_merchant_event('shift.closed');

CREATE TABLE branch_shift_commands (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, request_id uuid NOT NULL,
  merchant_id text NOT NULL, branch_id text NOT NULL, register_id text NOT NULL,
  shift_id uuid NOT NULL, action text NOT NULL CHECK(action IN ('open','close')),
  amount integer NOT NULL CHECK(amount >= 0), applied_at timestamptz,
  UNIQUE(merchant_id,register_id,request_id),
  FOREIGN KEY (merchant_id,branch_id,register_id) REFERENCES registers(merchant_id,branch_id,id) ON DELETE CASCADE
);
