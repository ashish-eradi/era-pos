ALTER TABLE branch_catalog ADD COLUMN mrp_minor integer CHECK (mrp_minor BETWEEN 0 AND 1000000000);
