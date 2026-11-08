//! SQL 分句：按顶层 `;` 切分，正确跳过字符串、引号标识符、行/块注释与
//! PostgreSQL dollar-quoted 字符串（`$$…$$` / `$tag$…$tag$`）。
//! 纯函数，无驱动依赖；供执行编排与前端共用语义。

/// 单条语句及其在原文中的字节区间（`sql` 为去首尾空白后的文本）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpannedStatement {
    pub sql: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum State {
    Normal,
    LineComment,
    /// 块注释（携带嵌套深度，PostgreSQL 支持嵌套）
    BlockComment(usize),
    SingleQuoted,
    DoubleQuoted,
    BacktickQuoted,
    /// dollar-quoted（携带定界符，如 `$$` / `$fn$`）
    DollarQuoted(String),
}

/// 尝试在 `bytes[pos..]` 识别 dollar-quote 开定界符：`$tag$`（tag 可为空）。
/// 返回完整定界符（含两侧 `$`）及其字节长度。
fn match_dollar_delimiter(input: &str, pos: usize) -> Option<(String, usize)> {
    let bytes = input.as_bytes();
    if bytes.get(pos) != Some(&b'$') {
        return None;
    }
    let mut cursor = pos + 1;
    while cursor < bytes.len() && (bytes[cursor].is_ascii_alphanumeric() || bytes[cursor] == b'_') {
        cursor += 1;
    }
    if bytes.get(cursor) != Some(&b'$') {
        return None;
    }
    let delimiter = input[pos..=cursor].to_owned();
    Some((delimiter, cursor - pos + 1))
}

/// 按 `;` 切分顶层语句；空白语句丢弃；未闭合的引号/注释吞到文本末尾（不报错）
pub fn split_statements(input: &str) -> Vec<SpannedStatement> {
    let mut statements = Vec::new();
    let mut state = State::Normal;
    let mut statement_start = 0usize;
    let mut chars = input.char_indices().peekable();

    while let Some((index, ch)) = chars.next() {
        // 若上一轮进入 dollar-quoted，需要跳过其闭定界符之前的内容：
        // 状态机以「进入时记录定界符」的方式处理，见下方 Normal 分支
        match &state {
            State::Normal => {
                match ch {
                    '\'' => state = State::SingleQuoted,
                    '"' => state = State::DoubleQuoted,
                    '`' => state = State::BacktickQuoted,
                    '-' => {
                        if input[index + 1..].starts_with('-') {
                            state = State::LineComment;
                            chars.next(); // 消费第二个 '-'
                        }
                    }
                    '/' => {
                        if input[index + 1..].starts_with('*') {
                            state = State::BlockComment(1);
                            chars.next();
                        }
                    }
                    '$' => {
                        if let Some((delimiter, len)) = match_dollar_delimiter(input, index) {
                            // 开定界符必须整体消费（触发字符 '$' 已消费，再吃 len-1 个），
                            // 否则紧随其后的同名 tag 会被误判为闭定界符
                            for _ in 1..len {
                                chars.next();
                            }
                            state = State::DollarQuoted(delimiter);
                        }
                    }
                    ';' => {
                        push_statement(input, statement_start, index, &mut statements);
                        statement_start = index + 1;
                    }
                    _ => {}
                }
            }
            State::LineComment => {
                if ch == '\n' {
                    state = State::Normal;
                }
            }
            State::BlockComment(depth) => {
                if ch == '*' && input[index + 1..].starts_with('/') {
                    let depth = *depth;
                    if depth == 1 {
                        state = State::Normal;
                    } else {
                        state = State::BlockComment(depth - 1);
                    }
                    chars.next();
                } else if ch == '/' && input[index + 1..].starts_with('*') {
                    let depth = *depth;
                    state = State::BlockComment(depth + 1);
                    chars.next();
                }
            }
            State::SingleQuoted => {
                if ch == '\'' {
                    if input[index + 1..].starts_with('\'') {
                        chars.next(); // '' 转义
                    } else {
                        state = State::Normal;
                    }
                }
            }
            State::DoubleQuoted => {
                if ch == '"' {
                    if input[index + 1..].starts_with('"') {
                        chars.next();
                    } else {
                        state = State::Normal;
                    }
                }
            }
            State::BacktickQuoted => {
                if ch == '`' {
                    if input[index + 1..].starts_with('`') {
                        chars.next();
                    } else {
                        state = State::Normal;
                    }
                }
            }
            State::DollarQuoted(delimiter) => {
                if ch == '$' && input[index..].starts_with(delimiter.as_str()) {
                    let skip = delimiter.len() - 1;
                    for _ in 0..skip {
                        chars.next();
                    }
                    state = State::Normal;
                }
            }
        }
    }
    push_statement(input, statement_start, input.len(), &mut statements);
    statements
}

fn push_statement(
    input: &str,
    start: usize,
    end: usize,
    statements: &mut Vec<SpannedStatement>,
) {
    let raw = &input[start..end];
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return;
    }
    // 以 trim 后文本重算精确区间
    let offset = raw.len() - raw.trim_start().len();
    let start = start + offset;
    let end = start + trimmed.len();
    statements.push(SpannedStatement {
        sql: trimmed.to_owned(),
        start,
        end,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sqls(input: &str) -> Vec<String> {
        split_statements(input).into_iter().map(|s| s.sql).collect()
    }

    #[test]
    fn splits_simple_statements() {
        assert_eq!(sqls("select 1; select 2;"), vec!["select 1", "select 2"]);
        assert_eq!(sqls("select 1"), vec!["select 1"]);
        assert_eq!(sqls("  ;  ; select 1; "), vec!["select 1"]);
        assert!(sqls("").is_empty());
        assert!(sqls("   \n  ").is_empty());
    }

    #[test]
    fn keeps_semicolons_inside_strings_and_identifiers() {
        assert_eq!(sqls("select ';' as a"), vec!["select ';' as a"]);
        assert_eq!(sqls("select 'a'';b'"), vec!["select 'a'';b'"]);
        assert_eq!(sqls(r#"select "a;b""#), vec![r#"select "a;b""#]);
        assert_eq!(sqls("select `a;b`"), vec!["select `a;b`"]);
    }

    #[test]
    fn keeps_semicolons_inside_comments() {
        // 前导/内联注释属于语句的一部分（执行语义需保留 hint 类注释）
        assert_eq!(sqls("-- x; y\nselect 1"), vec!["-- x; y\nselect 1"]);
        assert_eq!(sqls("/* a; b */ select 1"), vec!["/* a; b */ select 1"]);
        assert_eq!(sqls("/* a /* b; */ */ select 1"), vec!["/* a /* b; */ */ select 1"]);
        assert_eq!(sqls("select 1 -- trailing;"), vec!["select 1 -- trailing;"]);
    }

    #[test]
    fn keeps_semicolons_inside_dollar_quotes() {
        assert_eq!(sqls("select $$a;b$$; select 2"), vec!["select $$a;b$$", "select 2"]);
        assert_eq!(
            sqls("select $fn$ body ; with ; $fn$ as v; select 2"),
            vec!["select $fn$ body ; with ; $fn$ as v", "select 2"]
        );
        // 非定界符的 $（如占位符 $1）不进入 dollar 状态
        assert_eq!(sqls("select $1 + $2"), vec!["select $1 + $2"]);
    }

    #[test]
    fn statements_carry_exact_spans() {
        let input = "  select 1 ;\nselect 2";
        let out = split_statements(input);
        assert_eq!(out.len(), 2);
        assert_eq!(&input[out[0].start..out[0].end], "select 1");
        assert_eq!(&input[out[1].start..out[1].end], "select 2");
    }

    #[test]
    fn unclosed_quotes_consume_to_end_without_panic() {
        assert_eq!(sqls("select 'abc"), vec!["select 'abc"]);
        assert_eq!(sqls("select 1 /* never closed"), vec!["select 1 /* never closed"]);
    }
}
