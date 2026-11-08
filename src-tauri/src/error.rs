use serde::ser::{Serialize, SerializeStruct, Serializer};

/// 所有 IPC 命令的统一错误类型；序列化为 { code, message } 供前端分类处理。
/// NotFound/Conn/Cancelled 为已确认的错误分类契约（阶段二/三启用），先于使用点声明。
#[allow(dead_code)]
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Db(#[from] rusqlite::Error),
    #[error("invalid input: {0}")]
    Input(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("connection failed: {0}")]
    Conn(String),
    #[error("task cancelled")]
    Cancelled,
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Internal(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Db(_) => "db",
            AppError::Input(_) => "input",
            AppError::NotFound(_) => "not_found",
            AppError::Conn(_) => "connection",
            AppError::Cancelled => "cancelled",
            AppError::Io(_) => "io",
            AppError::Internal(_) => "internal",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

impl From<tauri::Error> for AppError {
    fn from(err: tauri::Error) -> Self {
        AppError::Internal(err.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
