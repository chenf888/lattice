pub mod db;
pub mod error;
pub mod store;
pub mod tasks;

mod commands;
mod logging;
mod state;

use std::fs;
use std::path::PathBuf;

use tauri::Manager;

use crate::error::AppError;
use crate::state::AppState;
use crate::store::meta::MetaStore;

/// setup 步骤错误标注：panic 消息中直接可见失败步骤
fn ctx(e: impl std::fmt::Display, step: &'static str) -> Box<dyn std::error::Error> {
    Box::new(AppError::Internal(format!("{step}: {e}")))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // 数据根目录：LATTICE_DATA_DIR 覆盖（便携模式）；缺省为系统应用数据目录。
            // 覆盖时 app.db、日志与 WebView2 用户数据目录一并重定向。
            let data_root: PathBuf = match std::env::var("LATTICE_DATA_DIR") {
                Ok(dir) if !dir.is_empty() => {
                    let dir = PathBuf::from(dir);
                    fs::create_dir_all(&dir)
                        .map_err(|e| ctx(e, "create data_dir (LATTICE_DATA_DIR)"))?;
                    dir
                }
                _ => {
                    let dir = handle
                        .path()
                        .app_data_dir()
                        .map_err(|e| ctx(e, "resolve data_dir"))?;
                    fs::create_dir_all(&dir).map_err(|e| ctx(e, "create data_dir"))?;
                    dir
                }
            };
            let portable = std::env::var("LATTICE_DATA_DIR").is_ok_and(|d| !d.is_empty());

            crate::state::set_data_root(data_root.clone());

            let log_dir = data_root.join("logs");
            fs::create_dir_all(&log_dir).map_err(|e| ctx(e, "create log_dir"))?;
            logging::init(&log_dir);

            let meta = MetaStore::open(&data_root.join("app.db"))
                .map_err(|e| ctx(e, "open app.db"))?;
            app.manage(AppState {
                meta: std::sync::Arc::new(meta),
                connections: crate::db::manager::ConnectionManager::new(),
                queries: std::sync::Arc::new(crate::db::execution::ExecutionRegistry::new()),
                tasks: std::sync::Arc::new(crate::tasks::TaskRegistry::new()),
            });

            // 窗口程序化创建：以便携模式挂载 WebView2 数据目录（配置 create:false）
            let mut builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Lattice")
            .inner_size(1440.0, 900.0)
            .min_inner_size(1024.0, 640.0)
            .center();
            // macOS：交通灯悬浮（Overlay）+ 隐藏标题，前端 TitleBar 留出留白
            #[cfg(target_os = "macos")]
            {
                builder = builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true);
            }
            if portable {
                builder = builder.data_directory(data_root.join("webview"));
            }
            builder
                .build()
                .map_err(|e| ctx(e, "build main window"))?;

            log::info!("Lattice 启动：data_root={data_root:?}, portable={portable}");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::get_app_info,
            commands::app::get_setting,
            commands::app::set_setting,
            commands::connections::list_connections,
            commands::connections::create_connection,
            commands::connections::update_connection,
            commands::connections::delete_connection,
            commands::connections::set_connection_favorite,
            commands::connections::test_connection,
            commands::connections::connect_database,
            commands::connections::disconnect_database,
            commands::explorer::browse_tree,
            commands::query::execute_query,
            commands::query::cancel_query,
            commands::query::describe_table,
            commands::query::describe_erd,
            commands::history::list_query_history,
            commands::history::clear_query_history,
            commands::saved::list_saved_queries,
            commands::saved::save_saved_query,
            commands::saved::delete_saved_query,
            commands::tabs::load_tabs_session,
            commands::tabs::save_tabs_session,
            commands::format::format_rows,
            commands::format::format_sql,
            commands::transfer::preview_csv,
            commands::transfer::pick_save_path,
            commands::transfer::pick_open_path,
            commands::transfer::save_binary_file,
            commands::transfer::export_query,
            commands::transfer::import_csv,
            commands::transfer::cancel_task,
            commands::system::restart_app,
            commands::system::open_log_dir,
            commands::system::open_data_dir,
            commands::system::check_update,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Lattice");
}
