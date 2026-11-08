/**
 * 轻量 i18n：以中文为源键（zh = 原样返回，en 查词典），缺词条回退原文。
 * 语言设置 ui.language（system/zh/en），默认跟随系统。
 */

import { create } from "zustand";

import { api } from "@/lib/ipc";
import { SETTING_KEYS } from "@/lib/types";

export type Lang = "system" | "zh" | "en";

/** 英文词典（键 = 中文原文） */
const EN: Record<string, string> = {
  // 通用
  "取消": "Cancel",
  "关闭": "Close",
  "保存": "Save",
  "删除": "Delete",
  "刷新": "Refresh",
  "确认": "Confirm",
  "重试": "Retry",
  "全部": "All",
  "搜索": "Search",

  // 导航 / 标题
  "连接": "Connections",
  "工作台": "Workbench",
  "设置": "Settings",
  "ER 图": "ER Diagram",
  "执行历史": "Query History",
  "对象详情": "Object Details",
  "对象浏览器": "Object Browser",
  "SQL 工作台": "SQL Workbench",

  // TitleBar
  "折叠 / 展开侧边栏": "Toggle sidebar",
  "切换主题（当前：深色）": "Switch theme (current: dark)",
  "切换主题（当前：浅色）": "Switch theme (current: light)",
  "切换主题（当前：跟随系统）": "Switch theme (current: system)",
  "深色": "Dark",
  "浅色": "Light",
  "跟随系统": "System",

  // 侧边栏 / 对象树
  "暂无连接": "No connections",
  "在主页新建连接后，可在此浏览数据库对象": "Create a connection to browse database objects",
  "输入即过滤…": "Type to filter…",
  "过滤对象树": "Filter object tree",
  "隐藏系统对象": "Hide system objects",
  "显示系统对象": "Show system objects",
  "按名称升序": "Sort ascending",
  "按名称降序": "Sort descending",
  "折叠全部": "Collapse all",
  "尚无连接可浏览": "No connections to browse",
  "复制名称": "Copy name",
  "打开数据": "Open data",
  "生成 SELECT": "Generate SELECT",
  "查看 ER 图": "View ER diagram",
  "断开连接": "Disconnect",
  "加载失败，点击重试": "Load failed, click to retry",
  "已复制名称": "Name copied",
  "复制失败": "Copy failed",

  // 连接管理
  "连接名称不能为空": "Connection name is required",
  "新建连接": "New connection",
  "编辑连接": "Edit connection",
  "测试连接": "Test connection",
  "保存连接": "Save connection",
  "驱动": "Driver",
  "主机": "Host",
  "端口": "Port",
  "数据库": "Database",
  "用户名": "Username",
  "密码": "Password",
  "SSL 模式": "SSL mode",
  "颜色标签": "Color tag",
  "分组": "Group",
  "只读模式": "Read-only mode",
  "只读": "Read-only",
  "搜索连接…": "Search connections…",
  "分组：": "Group: ",
  "已连接": "Connected",
  "未连接": "Disconnected",
  "连接成功": "Connected successfully",
  "已断开": "Disconnected",
  "连接失败": "Connection failed",
  "删除连接": "Delete connection",
  "确认删除该连接？密码与收藏将一并移除": "Delete this connection? Saved password and favorite will be removed",
  "再次点击确认删除": "Click again to confirm",
  "编辑": "Edit",
  "连接…": "Connect…",
  "断开…": "Disconnect…",
  "数据库文件路径": "Database file path",
  "数据库文件路径不能为空": "Database file path is required",
  "留空 = 编辑时保留原密码": "Leave empty to keep the saved password",
  "测试成功": "Test succeeded",
  "网络不可达": "Network unreachable",
  "认证失败": "Authentication failed",
  "数据库不存在": "Database does not exist",
  "SSL 错误": "SSL error",
  "暂无连接，点击下方按钮创建": "No connections yet — create one below",
  "搜索或输入名称…": "Search by name…",

  // 编辑器工作台
  "选择连接…": "Select connection…",
  "运行全部": "Run all",
  "运行选中": "Run selection",
  "格式化 SQL": "Format SQL",
  "格式化失败": "Format failed",
  "EXPLAIN 选中 / 第一条语句": "EXPLAIN selection / first statement",
  "保存查询": "Save query",
  "没有可执行的 SQL": "No SQL to execute",
  "标签未绑定连接，请先在工具栏选择连接": "Tab has no connection — pick one in the toolbar",
  "标签未绑定连接": "Tab has no connection",
  "执行失败": "Execution failed",
  "取消失败": "Cancel failed",
  "查询执行中": "Query running",
  "新建查询标签": "New query tab",
  "管理连接": "Manage connections",
  "新建查询标签开始工作；从左侧对象树右键「打开数据」可直接浏览表": "Create a query tab, or right-click a table in the tree and choose Open data",
  "名称": "Name",
  "分组（可选）": "Group (optional)",
  "查询名称": "Query name",
  "如：月度订单统计": "e.g. Monthly orders",
  "如：报表": "e.g. Reports",
  "请填写查询名称": "Query name is required",
  "当前标签没有可保存的 SQL": "Active tab has no SQL to save",
  "未保存": "Unsaved",
  "调整编辑器与结果区高度": "Resize editor and results",
  "连接处于只读模式": "Connection is read-only",
  "该语句可能包含写操作。确认后仍会提交执行——后端会话为只读，写操作将被数据库拒绝。": "This statement may contain writes. It will still be submitted — the backend session is read-only, so writes will be rejected by the database.",
  "仍要执行": "Run anyway",

  // 结果面板
  "尚无结果集": "No results yet",
  "按 Ctrl/⌘+Enter 执行编辑器中的 SQL": "Press Ctrl/⌘+Enter to run the editor SQL",
  "结果": "Result",
  "完成": "OK",
  "错误": "Error",
  "已取消": "Cancelled",
  "等待": "Pending",
  "运行中": "Running",
  "添加筛选": "Add filter",
  "筛选列": "Filter column",
  "筛选操作符": "Filter operator",
  "筛选值": "Filter value",
  "移除筛选": "Remove filter",
  "已筛选：": "Filtered: ",
  " 行": " rows",
  "（已截断）": " (truncated)",
  "耗时": "Duration",
  "连接：": "Connection: ",
  "加载更多": "Load more",
  "按 2 倍行数上限重新执行（仅纯读取语句可用）": "Re-run with 2x row limit (read-only statements only)",
  "执行出错": "Execution failed",
  "未知错误": "Unknown error",
  "语句已执行，无结果集（影响行数：": "Statement executed, no result set (affected: ",
  "）": ")",
  "所有列已隐藏——在列头右键恢复": "All columns hidden — right-click a header to restore",
  "执行中…": "Running…",

  // 结果网格
  "自适应宽度": "Auto-fit width",
  "固定列": "Pin column",
  "取消固定": "Unpin column",
  "复制列名": "Copy column name",
  "隐藏列": "Hide column",
  "复制单元格": "Copy cell",
  "复制行": "Copy row",
  "复制为 CSV": "Copy as CSV",
  "复制为 JSON": "Copy as JSON",
  "复制为 INSERT…": "Copy as INSERT…",
  "筛选该值（=）": "Filter by this value (=)",
  "已复制": "Copied",
  "已复制行": "Row copied",
  "已复制为 CSV": "Copied as CSV",
  "已复制为 JSON": "Copied as JSON",
  "已复制为 INSERT": "Copied as INSERT",
  "复制为 INSERT 语句": "Copy as INSERT statement",
  "指定目标表名，列名取自结果集列头。": "Specify the target table; column names come from the result set.",
  "表名，如 users": "Table name, e.g. users",
  "点击查看详情": "Click for details",

  // 历史 / 保存
  "按连接过滤": "Filter by connection",
  "全部连接": "All connections",
  "刷新历史": "Refresh history",
  "清空历史": "Clear history",
  "确认清空全部执行历史？": "Clear all query history?",
  "已清空历史": "History cleared",
  "点击回填到当前标签": "Click to fill into the active tab",
  "暂无执行历史": "No query history",
  "执行 SQL 后会在这里记录": "Executed queries will appear here",
  "没有活动标签可回填": "No active tab to fill",
  "已回填到当前标签": "Filled into the active tab",
  "失败": "Failed",

  // 保存查询弹窗
  "保存到 saved_queries，可在快速打开（Ctrl/⌘+P）中检索": "Saved to saved_queries; find it via Quick Open (Ctrl/⌘+P)",
  "已保存「": "Saved \"",
  "」": "\"",

  // ER 图
  "选择数据库…": "Select database…",
  "选择 Schema…": "Select schema…",
  "重新加载": "Reload",
  "当前 Schema 没有表": "No tables in this schema",
  "选择其他连接或 Schema，或在对象树中右键连接「查看 ER 图」": "Pick another connection/schema, or right-click a connection in the tree and choose View ER diagram",
  "ER 图画布": "ER diagram canvas",
  "双击在对象树中定位": "Double-click to locate in the object tree",
  "表": "tables",
  "外键": "foreign keys",
  "拖拽移动 · Shift+拖拽框选 · 滚轮缩放 · 双击节点定位对象树": "Drag to move · Shift+drag to box-select · Scroll to zoom · Double-click to locate in tree",
  "导出 SVG 失败": "SVG export failed",
  "导出 PNG 失败": "PNG export failed",
  "加载中…": "Loading…",

  // 图表
  "结果可视化": "Visualize results",
  "柱状图": "Bar",
  "折线图": "Line",
  "饼图": "Pie",
  "渲染前": "Rendering first",
  " 行（截断）": " rows",
  "选择至少一个数值列（Y 轴）": "Pick at least one numeric column (Y axis)",

  // 导出
  "导出结果": "Export results",
  "按本次执行的 SQL 重新流式导出（不受网格行上限限制）；总是后台任务，可在托盘查看进度。": "Stream-exports by re-running the executed SQL (not limited by the grid cap); always a background task — check the tray for progress.",
  "格式": "Format",
  "编码": "Encoding",
  "行分隔": "Line separator",
  "目标表名（INSERT 用）": "Target table (for INSERT)",
  "行数上限（留空 = 不限）": "Row limit (empty = unlimited)",
  "列（全不选 = 全部；当前": "Columns (none selected = all; currently",
  "列）": " columns)",
  "无列信息（将导出执行产生的列）": "No column info (the executed columns will be exported)",
  "发起中…": "Starting…",
  "选择位置并导出": "Choose location & export",
  "没有可导出的执行": "No execution to export",
  "发起导出失败": "Failed to start export",
  "导出任务已开始，可在右下角任务托盘查看进度": "Export started — check the task tray",

  // 导入
  "导入 CSV": "Import CSV",
  "列映射 → 类型按内容推断（展示提示）→ 后台任务执行；失败行可在任务托盘查看。": "Map columns → types inferred from content (hints only) → background task; failed rows show in the tray.",
  "目标表名": "Target table",
  "CSV 文件路径": "CSV file path",
  "分隔符": "Delimiter",
  "冲突策略": "Conflict strategy",
  "报错（首错中止）": "Error (stop on first failure)",
  "跳过失败行": "Skip failed rows",
  "覆盖（替换同主键）": "Overwrite (replace by primary key)",
  "首行为表头": "First row is header",
  "源列": "Source column",
  "样例": "Sample",
  "推断": "Inferred",
  "目标列": "Target column",
  "（跳过）": "(skip)",
  "数值": "Numeric",
  "文本": "Text",
  "列映射（共": "Column mapping (",
  " 行；类型为按内容推断）": " rows; types inferred from content)",
  "目标表列读取失败（表不存在？），映射暂不可用": "Failed to read target columns (table missing?), mapping unavailable",
  "文件读取失败：请检查路径与分隔符": "Failed to read file: check path and delimiter",
  "开始导入": "Start import",
  "请选择连接": "Pick a connection",
  "请填写目标表名": "Target table is required",
  "至少映射一列": "Map at least one column",
  "发起导入失败": "Failed to start import",
  "导入任务已开始，可在右下角任务托盘查看进度与错误行": "Import started — check the task tray for progress and failed rows",

  // 任务托盘
  "后台任务": "Background tasks",
  "收起托盘": "Collapse tray",
  "清空已完成": "Clear finished",
  "取消任务": "Cancel task",
  "跳过": "Skipped",
  "日志": "Logs",
  "（无日志）": "(no logs)",
  "导出完成": "Export finished",
  "导出已取消": "Export cancelled",
  "导出失败": "Export failed",
  "导入完成": "Import finished",
  "导入已取消": "Import cancelled",
  "导入失败": "Import failed",
  "行成功": " rows succeeded",

  // 命令面板
  "搜索动作…": "Search actions…",
  "打开保存的查询 / 最近表…": "Open saved queries / recent tables…",
  "打开保存的查询或最近表": "Open saved queries or recent tables",
  "无匹配项": "No matches",
  "打开连接管理": "Open connections",
  "打开 SQL 工作台": "Open SQL workbench",
  "打开 ER 图": "Open ER diagram",
  "打开执行历史": "Open query history",
  "导出当前结果…": "Export current results…",
  "导入 CSV…": "Import CSV…",
  "切换主题（当前：": "Switch theme (current: ",
  "该记录缺少连接上下文": "Missing connection context for this entry",

  // 设置
  "外观": "Appearance",
  "主题": "Theme",
  "界面密度": "Density",
  "紧凑": "Compact",
  "舒适": "Comfortable",
  "界面字号": "UI font size",
  "编辑器": "Editor",
  "编辑器字号": "Editor font size",
  "Tab 宽度": "Tab width",
  "自动补全": "Auto completion",
  "执行前自动格式化": "Auto-format before run",
  "数据": "Data",
  "单页行数上限": "Rows per page",
  "查询超时（秒，0 = 不限）": "Query timeout (seconds, 0 = none)",
  "自动提交": "Auto commit",
  "关闭后所有语句包裹在事务中，成功提交、失败回滚": "When off, statements run in a transaction — commit on success, rollback on failure",
  "快捷键": "Keyboard shortcuts",
  "动作": "Action",
  "组合键": "Shortcut",
  "修改": "Change",
  "恢复默认": "Reset",
  "按下组合键…（Esc 取消）": "Press keys… (Esc to cancel)",
  "与「": "Conflicts with \"",
  "」冲突": "\"",
  "关于": "About",
  "版本": "Version",
  "检查更新": "Check for updates",
  "已是最新版本": "You are up to date",
  "打开日志目录": "Open log directory",
  "打开数据目录": "Open data directory",
  "数据目录": "Data directory",
  "检查中…": "Checking…",
  "语言": "Language",
  "中文": "Chinese",
  "English": "English",

  // Toast 通用
  "主题：": "Theme: ",
};

interface I18nState {
  lang: Lang;
  setLang: (lang: Lang) => void;
}

function resolveLang(lang: Lang): "zh" | "en" {
  if (lang === "system") {
    return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh")
      ? "zh"
      : "en";
  }
  return lang;
}

export const useI18nStore = create<I18nState>()((set) => ({
  lang: "system",
  setLang: (lang) => {
    set({ lang });
    api.setSetting(SETTING_KEYS.language, lang).catch(() => {});
  },
}));

export interface I18n {
  t: (key: string, vars?: Record<string, string | number>) => string;
  lang: Lang;
  setLang: (lang: Lang) => void;
}

export function useI18n(): I18n {
  const lang = useI18nStore((state) => state.lang);
  const setLang = useI18nStore((state) => state.setLang);
  const effective = resolveLang(lang);
  const t = (key: string, vars?: Record<string, string | number>): string => {
    let text = effective === "en" ? (EN[key] ?? key) : key;
    if (vars) {
      for (const [name, value] of Object.entries(vars)) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
    }
    return text;
  };
  return { t, lang, setLang };
}

/** Boot 时恢复语言设置 */
export function hydrateI18n(): Promise<void> {
  return api
    .getSetting(SETTING_KEYS.language)
    .then((raw) => {
      if (raw === "system" || raw === "zh" || raw === "en") {
        useI18nStore.setState({ lang: raw });
      }
    })
    .catch(() => {});
}
