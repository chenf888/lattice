-- 0003_tab_cursor：tabs_session 增加编辑器光标位置列（阶段三编辑器状态持久化）

ALTER TABLE tabs_session ADD COLUMN cursor_from INTEGER;
ALTER TABLE tabs_session ADD COLUMN cursor_to INTEGER;
