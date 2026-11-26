ALTER TABLE customers ADD COLUMN phone text CHECK (phone ~ '^\+?[0-9]{7,15}$');
