ALTER TABLE branch_catalog ADD COLUMN unit text NOT NULL DEFAULT 'pcs' CHECK (unit IN ('pcs','kg','g','L','ml')),
  ADD COLUMN allow_decimal boolean NOT NULL DEFAULT false;
ALTER TABLE stock_movements ALTER COLUMN quantity TYPE numeric(16,3);
