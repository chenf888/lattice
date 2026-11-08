# Lattice

<p align="center">
  <img src="src-tauri/icons/128x128.png" width="72" alt="Lattice icon" />
</p>

<p align="center">
  <strong>Local-first cross-platform database workbench</strong><br/>
  A multi-source SQL client for developers · Fully offline · No cloud services
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

## About

Lattice is a desktop database workbench: connect to PostgreSQL / MySQL / SQLite, write and execute SQL, browse large result sets in a virtualized grid, manage database objects and relationships (ER diagram), and handle data import/export with lightweight visualization.

All state stays on your machine (app metadata in SQLite, passwords in the OS keychain) — no accounts, no telemetry, no cloud dependency.

## Features

### Connection Management

- Card-based connection list: groups, favorites, color tags, search
- Create / edit connections: driver, host, port, database, username, password, SSL mode
- Test connection: 3-second timeout with explicit error categories (network unreachable / authentication failed / database missing / SSL error)
- Global banner on disconnect with one-click reconnect; read-only mode toggle (write interception + confirmation)

### Object Browser

- Tree structure: connection → database → schema → tables / views, lazily loaded on expand
- Type-to-filter, name sorting, collapse all, system-object toggle
- Context menu: open data, generate SELECT, copy name, refresh, view ER diagram
- Object details panel: columns, primary and foreign keys

### SQL Editor & Tabs

- CodeMirror 6: syntax highlighting, bracket matching, line numbers, multi-cursor, code folding, autocompletion (tables / columns / keywords backed by a schema cache)
- Multi-tab workspace: drag to reorder, middle-click to close, unsaved dot
- Toolbar: format SQL, EXPLAIN, export results, save query, read-only toggle
- Editor state persistence: cursor, scroll position, unsaved content — fully restored after restart
- Query history panel: filter by connection, click to refill, clear all
- Execution model: statement-by-statement streaming (first results visible immediately), stop on failure, cancellable, timeout, optional transaction wrapping (commit on success / rollback on failure when autocommit is off)

### Results Grid (Performance-Critical)

- TanStack Table + TanStack Virtual — smooth scrolling beyond 100k rows
- Column headers: click to sort, drag to resize, double-click auto-fit, pin, hide
- Cells: monospace font, muted italic NULL, binaries shown as `<BLOB n bytes>`, long text expands on click
- Context menu: copy cell / row, copy as CSV / JSON / INSERT, filter by value
- Filter bar: column + operator + value, stackable conditions
- Status bar: row count, duration, active connection, load more; multi-result-set tabs

### ER Diagram

- Automatic layered layout from foreign keys; drag, zoom, pan, box-select
- Export PNG / SVG; double-click a node to locate it in the object tree

### Visualization

- One-click bar / line / pie charts for the current result set (Recharts)
- Automatic inference of numeric and dimension columns; manual axis switching

### Import & Export

- Export: CSV / JSON / SQL INSERT with column selection, encodings (UTF-8 / UTF-8 BOM / GBK), line separators (LF / CRLF)
- Over 50k rows automatically becomes a background task — streamed straight to file, no row limit
- Import: CSV → table with column mapping UI, content-based type hints, conflict strategies (error / skip / overwrite), live progress and failed-row report

### Task Center

- Bottom-right task tray: running tasks with progress bars, cancel, view logs
- System notifications on completion

### Command Palette & Shortcuts

- `Ctrl/⌘ + K` command palette: fuzzy search across all actions
- `Ctrl/⌘ + P` quick open: saved queries and recent tables
- All 11 shortcuts viewable, customizable (with conflict detection) and persisted in Settings

### Settings & More

- Appearance: theme (light / dark / system, dark by default), density, font size
- Editor: font size, tab width, autocompletion, auto-format before run
- Data: rows per page, query timeout, autocommit
- Bilingual UI (Chinese / English), follows system language by default
- Global error boundary + crash recovery (restart app / open logs / go home)
- Unified toast notifications; daily log rotation, 7-day retention
- Update-check UI flow in place (currently a placeholder)

## Supported Databases

| Database | Driver | Notes |
|---|---|---|
| PostgreSQL | tokio-postgres | TLS, cancellation (CancelToken), dollar-quoted statement parsing |
| MySQL | mysql_async | TLS, cancellation (abort), REPLACE conflict strategy |
| SQLite | rusqlite | Local files, read-only open, InterruptHandle cancellation |

## Download

Grab the latest installer from the [Releases](../../releases) page:

| Platform | File |
|---|---|
| Windows x64 | `Lattice_<version>_x64_en-US.msi` |

- Windows 10 (1809+) / Windows 11; WebView2 Runtime required (bundled with Windows 11)
- macOS (dmg) and Linux (AppImage): please [build from source](#build-from-source) for now

## Build from Source

### Prerequisites

- Rust 1.77+ (latest stable recommended)
- Node.js 20+ and pnpm 9+
- Platform dependencies: Windows needs WebView2 and the MSVC toolchain; Linux needs `libwebkit2gtk-4.1-dev` and friends (see the [Tauri docs](https://tauri.app/start/prerequisites/)); macOS needs Xcode Command Line Tools

### Steps

```bash
pnpm install
pnpm tauri dev        # development mode
pnpm tauri build      # package: dmg / msi / appimage
```

### Portable Mode (Optional)

Set the `LATTICE_DATA_DIR` environment variable to redirect app.db, logs and the WebView2 data directory to a location of your choice — useful for portable use, or on machines where writing to `%APPDATA%` is restricted.

## Project Structure

```
src-tauri/
  src/
    main.rs
    commands/        # all #[tauri::command] handlers, split by domain
    db/
      driver.rs      # trait DatabaseDriver: unified driver interface
      postgres.rs    # PostgreSQL implementation
      mysql.rs       # MySQL implementation
      sqlite.rs      # SQLite implementation
      execution.rs   # execution registry & cancellation
      export.rs      # streaming export & value-formatting primitives
      sql_split.rs   # SQL statement splitting (quotes / comments / dollar-quoted)
      sql_classify.rs / sql_format.rs / value.rs
    store/           # app metadata database (app.db): migrations, connections, history, settings
    tasks/           # background task registry
  migrations/        # SQL migrations, applied automatically at startup
src/
  app/               # routing, layout, global providers, error boundary
  features/
    connections/     # connection management
    explorer/        # object tree
    editor/          # SQL editor & tabs
    results/         # results grid
    erd/             # ER diagram
    charts/          # visualization
    transfer/        # import & export
    tasks/           # task tray
    palette/         # command palette
    history/ settings/
  components/ui/     # base components (shadcn/ui / Radix)
  lib/               # IPC wrapper, i18n, types, hotkey definitions
  stores/            # Zustand slices
```

## Architecture Notes

- **Unified driver interface**: `trait DatabaseDriver` abstracts connect, execute, metadata and cancellation; adding a data source only requires implementing the trait — upper layers stay unchanged.
- **Streaming execution**: `execute_query` returns immediately and streams statements to the frontend (columns → rows → done); the first screen never waits for the full result set. Cancellation goes straight to the engine (PG CancelToken / MySQL abort / SQLite InterruptHandle).
- **Security**: passwords live only in the OS keychain (keyring); Rust-side SQL parameters always use prepared placeholders — no string concatenation; read-only mode is enforced at the session level.
- **Typed IPC**: every command returns `Result<T, AppError>`; the frontend wraps everything in `src/lib/ipc.ts` with unified error handling.
- **Virtualized grid**: TanStack Table column model + TanStack Virtual row virtualization, cells rendered on demand.

## Development & Quality Gates

```bash
pnpm typecheck          # tsc --noEmit (strict)
pnpm lint               # eslint (no-console = error)
cd src-tauri
cargo clippy --all-targets -- -D warnings
cargo test              # includes SQL splitting / type mapping / CSV escaping unit tests and 3 end-to-end flow tests
```

Current baseline: all 66 `cargo test` cases pass; clippy / tsc / eslint are clean.

## Roadmap

- [ ] Wire the update check to a real update source
- [ ] SSH tunnel connections
- [ ] Ship macOS / Linux artifacts with Releases
- [ ] Deep integration testing against real PostgreSQL / MySQL instances

## License

Released under the [MIT License](LICENSE).

Copyright © 2026 chenf888
