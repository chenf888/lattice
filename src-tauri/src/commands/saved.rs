//! 保存的查询命令

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::store::meta::SavedQueryRow;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQueryInput {
    pub id: Option<String>,
    pub connection_id: Option<String>,
    pub name: String,
    pub sql: String,
    pub folder: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuerySummary {
    pub id: String,
    pub connection_id: Option<String>,
    pub name: String,
    pub sql: String,
    pub folder: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl From<SavedQueryRow> for SavedQuerySummary {
    fn from(row: SavedQueryRow) -> Self {
        Self {
            id: row.id,
            connection_id: row.connection_id,
            name: row.name,
            sql: row.sql,
            folder: row.folder,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

fn validate(input: &SavedQueryInput) -> AppResult<()> {
    if input.name.trim().is_empty() {
        return Err(AppError::Input("查询名称不能为空".into()));
    }
    if input.sql.trim().is_empty() {
        return Err(AppError::Input("SQL 不能为空".into()));
    }
    Ok(())
}

#[tauri::command]
pub async fn list_saved_queries(
    state: State<'_, AppState>,
    connection_id: Option<String>,
) -> AppResult<Vec<SavedQuerySummary>> {
    Ok(state
        .meta
        .list_saved_queries(connection_id.as_deref())?
        .into_iter()
        .map(SavedQuerySummary::from)
        .collect())
}

#[tauri::command]
pub async fn save_saved_query(
    state: State<'_, AppState>,
    input: SavedQueryInput,
) -> AppResult<SavedQuerySummary> {
    validate(&input)?;
    let row = state.meta.upsert_saved_query(
        input.id.as_deref(),
        input.connection_id.as_deref(),
        input.name.trim(),
        &input.sql,
        input.folder.as_deref().map(str::trim).filter(|f| !f.is_empty()),
    )?;
    Ok(SavedQuerySummary::from(row))
}

#[tauri::command]
pub async fn delete_saved_query(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.meta.delete_saved_query(&id)
}
