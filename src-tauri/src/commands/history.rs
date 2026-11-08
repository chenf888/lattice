//! 查询历史命令

use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;
use crate::store::meta::HistoryRow;

#[tauri::command]
pub async fn list_query_history(
    state: State<'_, AppState>,
    connection_id: Option<String>,
    limit: Option<i64>,
) -> AppResult<Vec<HistoryRow>> {
    state
        .meta
        .list_query_history(connection_id.as_deref(), limit.unwrap_or(200))
}

#[tauri::command]
pub async fn clear_query_history(state: State<'_, AppState>) -> AppResult<()> {
    state.meta.clear_query_history()
}
