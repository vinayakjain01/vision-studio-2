-- schema.sql's CREATE TABLE IF NOT EXISTS is a no-op against an existing
-- database, so an already-created `products` table needs this ALTER
-- separately. See schema.sql's own column comment for what it's for.
ALTER TABLE products ADD COLUMN shot_type_override TEXT;
