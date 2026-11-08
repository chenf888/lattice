//! 每日文件日志：按天轮转（UTC 日期命名），保留 KEEP_DAYS 天。
//! 手写而非使用 tauri-plugin-log：该插件的轮转策略为按大小（KeepAll/KeepOne/KeepSome），
//! 无真正的“按天”语义；本模块以 ~120 行精确实现规格要求，且各纯函数可单测。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use log::{LevelFilter, Log, Metadata, Record};

pub const KEEP_DAYS: u64 = 7;
const FILE_PREFIX: &str = "lattice";

/// Howard Hinnant `days_from_civil`：公历日期 → 自 1970-01-01 的天数
fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = i64::from(if m <= 2 { y - 1 } else { y });
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (i64::from(m) + 9) % 12; // [0, 11]
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// `days_from_civil` 的逆变换：天数 → 公历日期
fn civil_from_days(day: i64) -> (i32, u32, u32) {
    let z = day + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let mut y = (yoe + era * 400) as i32;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32; // [1, 12]
    if m <= 2 {
        y += 1;
    }
    (y, m, d)
}

/// 从文件名提取日期（形如 2026-11-08 的子串），返回对应天数
fn date_in_name(name: &str) -> Option<i64> {
    let bytes = name.as_bytes();
    let mut i = 0;
    while i + 10 <= bytes.len() {
        let looks_like_date = bytes[i].is_ascii_digit()
            && bytes[i + 1].is_ascii_digit()
            && bytes[i + 2].is_ascii_digit()
            && bytes[i + 3].is_ascii_digit()
            && bytes[i + 4] == b'-'
            && bytes[i + 5].is_ascii_digit()
            && bytes[i + 6].is_ascii_digit()
            && bytes[i + 7] == b'-'
            && bytes[i + 8].is_ascii_digit()
            && bytes[i + 9].is_ascii_digit();
        if looks_like_date {
            if let (Ok(y), Ok(m), Ok(d)) = (
                name[i..i + 4].parse::<i32>(),
                name[i + 5..i + 7].parse::<u32>(),
                name[i + 8..i + 10].parse::<u32>(),
            ) {
                if (1..=12).contains(&m) && (1..=31).contains(&d) {
                    return Some(days_from_civil(y, m, d));
                }
            }
        }
        i += 1;
    }
    None
}

/// 删除保留期之外的按天日志文件；返回删除数量
pub fn prune_old_logs(dir: &Path, today_days: i64, keep_days: u64) -> std::io::Result<usize> {
    let cutoff = today_days - i64::try_from(keep_days).unwrap_or(i64::MAX);
    let mut removed = 0;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.starts_with(FILE_PREFIX) {
            if let Some(day) = date_in_name(name) {
                if day < cutoff {
                    fs::remove_file(&path)?;
                    removed += 1;
                }
            }
        }
    }
    Ok(removed)
}

struct State {
    day: i64,
    file: Option<File>,
}

struct DailyLogger {
    dir: PathBuf,
    stdout: bool,
    state: Mutex<State>,
}

impl DailyLogger {
    /// 打开（必要时创建）当天日志文件；跨天时轮转并清理过期文件
    fn rotate(&self, state: &mut State, day: i64) {
        if state.day == day && state.file.is_some() {
            return;
        }
        let (y, m, d) = civil_from_days(day);
        let path = self.dir.join(format!("{FILE_PREFIX}-{y:04}-{m:02}-{d:02}.log"));
        state.file = OpenOptions::new().create(true).append(true).open(&path).ok();
        state.day = day;
        // 新的一天开始时清理过期日志；清理失败不影响写入
        let _ = prune_old_logs(&self.dir, day, KEEP_DAYS);
    }
}

impl Log for DailyLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= log::max_level()
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        let day = (now.as_secs() / 86_400) as i64;
        let secs_of_day = now.as_secs() % 86_400;
        let line = format!(
            "[{:02}:{:02}:{:02}.{:03}] [{:<5}] [{}] {}\n",
            secs_of_day / 3600,
            (secs_of_day % 3600) / 60,
            secs_of_day % 60,
            now.subsec_millis(),
            record.level(),
            record.target(),
            record.args(),
        );
        // 日志器内部绝不允许 panic：全部降级为忽略
        if let Ok(mut state) = self.state.lock() {
            self.rotate(&mut state, day);
            if let Some(file) = state.file.as_mut() {
                let _ = file.write_all(line.as_bytes());
            }
        }
        if self.stdout {
            let mut out = std::io::stdout().lock();
            let _ = out.write_all(line.as_bytes());
        }
    }

    fn flush(&self) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(file) = state.file.as_mut() {
                let _ = file.flush();
            }
        }
    }
}

/// 安装全局日志器；安装失败（如重复安装）降级忽略，不视为致命
pub fn init(dir: &Path) {
    let _ = fs::create_dir_all(dir);
    let logger = DailyLogger {
        dir: dir.to_path_buf(),
        stdout: cfg!(debug_assertions),
        state: Mutex::new(State { day: -1, file: None }),
    };
    // 首条日志前先完成当天文件的准备与过期清理
    if let Ok(mut state) = logger.state.lock() {
        logger.rotate(&mut state, today_days());
    }
    let _ = log::set_boxed_logger(Box::new(logger));
    log::set_max_level(if cfg!(debug_assertions) {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    });
}

fn today_days() -> i64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    (now.as_secs() / 86_400) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn civil_roundtrip_and_anchors() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
        assert_eq!(civil_from_days(11_017), (2000, 3, 1));
        for day in [0i64, 1, 365, 19_723, 20_000, 100_000] {
            let (y, m, d) = civil_from_days(day);
            assert_eq!(days_from_civil(y, m, d), day);
        }
    }

    #[test]
    fn extracts_date_from_filename() {
        assert_eq!(
            date_in_name("lattice-2026-11-08.log"),
            Some(days_from_civil(2026, 11, 8))
        );
        assert_eq!(date_in_name("lattice.log"), None);
        assert_eq!(date_in_name("unrelated.txt"), None);
        assert_eq!(date_in_name("x2026-13-45.log"), None); // 非法月份
    }

    #[test]
    fn prunes_only_expired_prefixed_dated_logs() {
        let dir = env::temp_dir().join(format!("lattice-log-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let today = today_days();
        let old = civil_from_days(today - 30);
        let recent = civil_from_days(today - 1);
        let old_name = format!("lattice-{:04}-{:02}-{:02}.log", old.0, old.1, old.2);
        let recent_name = format!("lattice-{:04}-{:02}-{:02}.log", recent.0, recent.1, recent.2);
        fs::write(dir.join(&old_name), "old").unwrap();
        fs::write(dir.join(&recent_name), "new").unwrap();
        fs::write(dir.join("lattice.log"), "current").unwrap();
        fs::write(dir.join("other-2020-01-01.log"), "not ours").unwrap();

        let removed = prune_old_logs(&dir, today, KEEP_DAYS).unwrap();
        assert_eq!(removed, 1);
        assert!(!dir.join(&old_name).exists());
        assert!(dir.join(&recent_name).exists());
        assert!(dir.join("lattice.log").exists());
        assert!(dir.join("other-2020-01-01.log").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
