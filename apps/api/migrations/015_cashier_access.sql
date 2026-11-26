CREATE TABLE cashier_pins (
  merchant_id text NOT NULL,
  membership_id text NOT NULL,
  branch_id text NOT NULL,
  salt text NOT NULL,
  verifier text NOT NULL,
  PRIMARY KEY (merchant_id,branch_id,membership_id),
  FOREIGN KEY (merchant_id,membership_id) REFERENCES memberships ON DELETE CASCADE,
  FOREIGN KEY (merchant_id,branch_id) REFERENCES branches ON DELETE CASCADE
);
ALTER TABLE shift_closes ADD COLUMN opened_by_cashier text, ADD COLUMN closed_by_cashier text;
