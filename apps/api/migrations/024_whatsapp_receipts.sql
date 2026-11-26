ALTER TABLE receipt_deliveries DROP CONSTRAINT receipt_deliveries_channel_check;
ALTER TABLE receipt_deliveries ADD CHECK (channel IN ('email','sms','whatsapp'));
