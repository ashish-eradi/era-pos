ALTER TABLE branch_catalog ADD COLUMN alert_threshold integer CHECK (alert_threshold >= 0);
CREATE INDEX IF NOT EXISTS cash_sales_branch_time ON cash_sales(merchant_id,branch_id,occurred_at);
