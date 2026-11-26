CREATE TABLE customers (
  merchant_id text NOT NULL,
  branch_id text NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  email text,
  PRIMARY KEY (merchant_id, branch_id, code),
  FOREIGN KEY (merchant_id, branch_id) REFERENCES branches(merchant_id, id)
);
CREATE INDEX cash_sales_customer_history ON cash_sales
  (merchant_id, branch_id, (receipt->>'customerCode'), occurred_at DESC)
  WHERE receipt ? 'customerCode';
