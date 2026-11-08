# Lattice

<p align="center">
  <img src="src-tauri/icons/128x128.png" width="72" alt="Lattice 图标" />
</p>

<p align="center">
  <strong>本地优先的跨平台数据库工作台</strong><br/>
  面向开发者的多数据源 SQL 客户端 · 全程离线可用 · 不依赖任何云服务
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue" alt="platform" />
  <img src="https://img.shields.io/badge/Tauri-2-orange" alt="Tauri 2" />
  <img src="https://img.shields.io/badge/React-19-149ECA" alt="React 19" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license" />
</p>

<p align="center">
  <a href="README.md">中文</a> | <a href="README.en.md">English</a>
</p>

---

## 简介

Lattice 是一款桌面端数据库工作台：连接 PostgreSQL / MySQL / SQLite，编写并执行 SQL，以虚拟化网格浏览海量结果集，管理数据库对象与关系（ER 图），完成数据导入导出与轻量可视化。

所有状态保存在本机（应用元数据存于 SQLite，密码存于操作系统钥匙串），无账号、无遥测、无云依赖。

## 功能特性

### 连接管理

- 连接卡片列表：分组、收藏、颜色标签、搜索
- 新建 / 编辑连接：驱动、主机、端口、库名、用户名、密码、SSL 模式
- 「测试连接」：3 秒超时，返回明确错误分类（网络不可达 / 认证失败 / 库不存在 / SSL 错误）
- 断线全局横幅 + 一键重连；只读模式开关（写操作拦截 + 二次确认）

### 对象浏览器

- 树形结构：连接 → 数据库 → Schema → 表 / 视图，懒加载（展开才请求）
- 输入即过滤、按名称排序、折叠全部、系统对象显示开关
- 右键菜单：打开数据、生成 SELECT、复制名称、刷新、查看 ER 图
- 对象详情面板：列结构、主外键信息

### SQL 编辑器与标签页

- CodeMirror 6：语法高亮、括号匹配、行号、多光标、代码折叠、自动补全（表名 / 列名 / 关键字，基于 schema 缓存）
- 多标签工作区：拖拽排序、中键关闭、未保存圆点
- 工具栏：格式化 SQL、EXPLAIN、导出结果、保存查询、只读切换
- 编辑器状态持久化：光标、滚动位置、未保存内容，重启后完整恢复
- 执行历史面板：按连接过滤、点击回填、一键清空
- 执行模型：逐语句流式执行（首条结果即刻可见）、失败即停、可取消、可设超时、可选事务包裹（autocommit 关闭时成功提交 / 失败回滚）

### 结果网格（性能关键）

- TanStack Table + TanStack Virtual 虚拟滚动，10 万行以上保持流畅
- 列头：点击排序、拖拽调宽、双击自适应、固定列、隐藏列
- 单元格：等宽字体、NULL 弱化斜体、二进制显示为 `<BLOB n bytes>`、长文本点击展开详情
- 右键：复制单元格 / 行、复制为 CSV / JSON / INSERT、按值筛选
- 筛选条：列名 + 操作符 + 值，多条件叠加
- 状态栏：行数、耗时、当前连接、加载更多；多结果集标签切换

### ER 图

- 基于外键自动分层布局，节点拖拽、缩放、平移、框选
- 导出 PNG / SVG；双击节点定位到对象树

### 数据可视化

- 对当前结果集一键生成柱状图 / 折线图 / 饼图（Recharts）
- 自动推断数值列与维度列，支持手动切换 X / Y 轴

### 导入导出

- 导出：CSV / JSON / SQL INSERT，可选列、编码（UTF-8 / UTF-8 BOM / GBK）、行分隔符（LF / CRLF）
- 超过 5 万行自动转后台任务，流式直写文件，无行数上限
- 导入：CSV → 表，列映射界面、按内容推断类型提示、冲突策略（报错 / 跳过 / 覆盖）、实时进度与错误行报告

### 后台任务中心

- 右下角任务托盘：运行中任务与进度条、取消、查看日志
- 任务完成系统通知

### 命令面板与快捷键

- `Ctrl/⌘ + K` 命令面板：模糊搜索全部动作
- `Ctrl/⌘ + P` 快速打开：已保存查询与最近表
- 全部 11 个快捷键可在设置中查看、自定义（含冲突检测）并持久化

### 设置与其他

- 外观：主题（浅色 / 深色 / 跟随系统，默认深色）、界面密度、字号
- 编辑器：字号、Tab 宽度、自动补全、执行前自动格式化
- 数据：单页行数上限、查询超时秒数、自动提交
- 中 / 英双语界面，默认跟随系统语言
- 全局错误边界 + 崩溃恢复（重启应用 / 打开日志 / 返回主页）
- 统一 Toast 通知；日志按天轮转，保留 7 天
- 更新检查界面流程就绪（当前为占位实现）

## 支持的数据库

| 数据库 | 驱动 | 说明 |
|---|---|---|
| PostgreSQL | tokio-postgres | TLS、取消（CancelToken）、dollar-quoted 语句解析 |
| MySQL | mysql_async | TLS、取消（abort）、REPLACE 冲突策略 |
| SQLite | rusqlite | 本地文件、只读打开、InterruptHandle 取消 |

## 下载安装

前往 [Releases](../../releases) 页面下载最新安装包：

| 平台 | 文件 |
|---|---|
| Windows x64 | `Lattice_<版本>_x64_en-US.msi` |

- Windows 10（1809+）/ Windows 11，需 WebView2 Runtime（Windows 11 自带）
- macOS（dmg）与 Linux（AppImage）当前请[从源码构建](#从源码构建)

## 从源码构建

### 环境要求

- Rust 1.77+（推荐最新 stable）
- Node.js 20+ 与 pnpm 9+
- 平台依赖：Windows 需 WebView2 与 MSVC 工具链；Linux 需 `libwebkit2gtk-4.1-dev` 等（见 [Tauri 文档](https://tauri.app/start/prerequisites/)）；macOS 需 Xcode Command Line Tools

### 步骤

```bash
pnpm install
pnpm tauri dev        # 开发模式
pnpm tauri build      # 打包：产出 dmg / msi / appimage
```

### 便携模式（可选）

设置环境变量 `LATTICE_DATA_DIR` 可将 app.db、日志与 WebView2 数据目录整体重定向到指定位置，适合免安装运行或在限制 `%APPDATA%` 写入的机器上使用。

## 项目结构

```
src-tauri/
  src/
    main.rs
    commands/        # 所有 #[tauri::command]，按域拆分
    db/
      driver.rs      # trait DatabaseDriver：统一驱动接口
      postgres.rs    # PostgreSQL 实现
      mysql.rs       # MySQL 实现
      sqlite.rs      # SQLite 实现
      execution.rs   # 执行注册表与取消
      export.rs      # 流式导出与值格式化原语
      sql_split.rs   # SQL 分句（引号 / 注释 / dollar-quoted）
      sql_classify.rs / sql_format.rs / value.rs
    store/           # 应用元数据库（app.db）：迁移、连接、历史、设置
    tasks/           # 后台任务注册表
  migrations/        # SQL 迁移脚本，启动时自动执行
src/
  app/               # 路由、布局、全局 Provider、错误边界
  features/
    connections/     # 连接管理
    explorer/        # 对象树
    editor/          # SQL 编辑器与标签页
    results/         # 结果网格
    erd/             # ER 图
    charts/          # 可视化
    transfer/        # 导入导出
    tasks/           # 任务托盘
    palette/         # 命令面板
    history/ settings/
  components/ui/     # 基础组件（shadcn/ui / Radix）
  lib/               # IPC 封装、i18n、类型、快捷键定义
  stores/            # Zustand slices
```

## 架构要点

- **统一驱动接口**：`trait DatabaseDriver` 抽象连接、执行、元数据、取消；新增数据源只需实现该 trait，上层不变。
- **流式执行**：`execute_query` 立即返回，逐语句推流到前端（列 → 行 → 完成），首屏不等全量结果；取消三路直达（PG CancelToken / MySQL abort / SQLite InterruptHandle）。
- **安全**：密码仅存操作系统钥匙串（keyring），Rust 侧 SQL 参数一律预编译占位符，禁字符串拼接；只读模式在会话层强制。
- **IPC 类型化**：全部命令返回 `Result<T, AppError>`，前端经 `src/lib/ipc.ts` 统一封装与错误处理。
- **虚拟化网格**：TanStack Table 列模型 + TanStack Virtual 行虚拟化，单元格按需渲染。

## 开发与质量门

```bash
pnpm typecheck          # tsc --noEmit（strict）
pnpm lint               # eslint（no-console = error）
cd src-tauri
cargo clippy --all-targets -- -D warnings
cargo test              # 含 SQL 分句 / 类型映射 / CSV 转义单测与 3 条端到端流程测试
```

当前基线：`cargo test` 66 项全部通过，clippy / tsc / eslint 零告警。

## 路线图

- [ ] 自动更新检查接入更新源
- [ ] SSH 隧道连接
- [ ] macOS / Linux 发行包随 Release 发布
- [ ] PostgreSQL / MySQL 真实实例深度联调

## 许可证

本项目基于 [MIT License](LICENSE) 发布。

Copyright © 2026 chenf888
