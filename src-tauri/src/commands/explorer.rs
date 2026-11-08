use tauri::State;

use crate::db::driver::NodePath;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// 对象树懒加载单命令：按 NodePath 展开一层；
/// 非默认库的节点会按需建立跨库连接（连接池按 (id, database) 维护）
#[tauri::command]
pub async fn browse_tree(
    state: State<'_, AppState>,
    id: String,
    path: NodePath,
) -> AppResult<Vec<crate::db::driver::TreeNode>> {
    let row = state
        .meta
        .get_connection(&id)?
        .ok_or_else(|| AppError::NotFound(format!("连接 {id}")))?;
    let database = match &path {
        NodePath::Databases => row.database.clone().unwrap_or_else(|| "postgres".into()),
        NodePath::Schemas { database } | NodePath::Objects { database, .. } => database.clone(),
    };
    let driver = state.connections.get_or_connect(&row, &database).await?;
    driver.children(&path).await
}
