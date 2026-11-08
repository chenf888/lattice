//! 标签会话命令：整表事务替换 + 启动恢复

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;
use crate::store::meta::TabRecord;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabSessionRecord {
    pub id: String,
    pub connection_id: Option<String>,
    pub title: Option<String>,
    pub sql: Option<String>,
    pub scroll_top: Option<i64>,
    pub cursor_from: Option<i64>,
    pub cursor_to: Option<i64>,
    pub updated_at: i64,
}

impl From<TabRecord> for TabSessionRecord {
    fn from(record: TabRecord) -> Self {
        Self {
            id: record.id,
            connection_id: record.connection_id,
            title: record.title,
            sql: record.sql,
            scroll_top: record.scroll_top,
            cursor_from: record.cursor_from,
            cursor_to: record.cursor_to,
            updated_at: record.updated_at,
        }
    }
}

impl From<TabSessionRecord> for TabRecord {
    fn from(record: TabSessionRecord) -> Self {
        Self {
            id: record.id,
            connection_id: record.connection_id,
            title: record.title,
            sql: record.sql,
            scroll_top: record.scroll_top,
            cursor_from: record.cursor_from,
            cursor_to: record.cursor_to,
            updated_at: record.updated_at,
        }
    }
}

#[tauri::command]
pub async fn load_tabs_session(state: State<'_, AppState>) -> AppResult<Vec<TabSessionRecord>> {
    Ok(state
        .meta
        .list_tabs_session()?
        .into_iter()
        .map(TabSessionRecord::from)
        .collect())
}

#[tauri::command]
pub async fn save_tabs_session(
    state: State<'_, AppState>,
    tabs: Vec<TabSessionRecord>,
) -> AppResult<()> {
    let records: Vec<TabRecord> = tabs.into_iter().map(TabRecord::from).collect();
    state.meta.replace_tabs_session(&records)
}
