-- 0002_connection_flags：规格 1 的只读开关与分组（只增列）
ALTER TABLE connections ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE connections ADD COLUMN group_name TEXT;
