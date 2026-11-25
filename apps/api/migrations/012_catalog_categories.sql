ALTER TABLE branch_catalog ADD COLUMN category text;
ALTER TABLE merchants ADD COLUMN receipt_address text NOT NULL DEFAULT '',
  ADD COLUMN receipt_gstin text NOT NULL DEFAULT '';
