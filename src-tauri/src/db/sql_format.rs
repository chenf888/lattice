//! 基础 SQL 格式化：关键字大写、主子句换行缩进、操作符空格规范化。
//! 定位为「保守整理」而非完整美化器：字符串/注释/引号标识符原样保留，
//! 行注释后强制换行避免吞掉后续文本。纯函数 + 单测，零外部依赖。

/// 换行子句关键字
const BREAK_BEFORE: &[&str] = &[
    "FROM", "WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "OFFSET", "UNION", "INTERSECT",
    "EXCEPT", "VALUES", "SET", "JOIN",
];

/// 大写关键字集合（含 BREAK_BEFORE 全集）
const KEYWORDS: &[&str] = &[
    "SELECT", "FROM", "WHERE", "GROUP", "BY", "HAVING", "ORDER", "LIMIT", "OFFSET", "UNION",
    "INTERSECT", "EXCEPT", "INSERT", "INTO", "UPDATE", "DELETE", "VALUES", "SET", "JOIN",
    "INNER", "OUTER", "CROSS", "ON", "AS", "DISTINCT", "NULL", "IS", "IN", "LIKE", "ILIKE",
    "BETWEEN", "EXISTS", "CASE", "WHEN", "THEN", "ELSE", "END", "AND", "OR", "NOT", "ASC",
    "DESC", "TRUE", "FALSE", "WITH", "TABLE", "PRIMARY", "KEY", "FOREIGN", "REFERENCES",
    "DEFAULT", "CONSTRAINT", "UNIQUE", "INDEX", "VIEW", "RETURNING",
];

/// 与函数同名的关键字：仅在后随 `(` 时不改写（LEFT(n)、REPLACE(…) 等）
const FUNC_LIKE: &[&str] = &["LEFT", "RIGHT", "REPLACE", "INSERT"];

/// JOIN 前置修饰词（后随 JOIN 时换行 + 大写）
const JOIN_MODIFIERS: &[&str] = &["INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS"];

#[derive(Debug, Clone, PartialEq)]
enum Atom {
    Word(String),
    Number(String),
    /// 引号包裹字面量的完整原文（字符串 / 引号标识符 / dollar-quoted）
    Quoted(String),
    Comment { text: String, line: bool },
    Op(String),
    Comma,
    LParen,
    RParen,
    Dot,
    Other(char),
}

fn is_word_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_' || ch == '$'
}

const OP_CHARS: &[char] = &['=', '<', '>', '!', '+', '-', '*', '/', '%', '&', '|', '^', '~'];

/// 判定 `chars[i..]` 是否为 dollar-quote 开定界符（`$$` 或 `$tag$`）；
/// 返回闭 `$` 的下标，否则 None
fn dollar_tag_end(chars: &[char], i: usize) -> Option<usize> {
    let mut j = i + 1;
    while j < chars.len() && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') {
        j += 1;
    }
    if j < chars.len() && chars[j] == '$' {
        return Some(j);
    }
    None
}

fn lex(input: &str) -> Vec<Atom> {
    let chars: Vec<char> = input.chars().collect();
    let n = chars.len();
    let mut atoms = Vec::new();
    let mut i = 0usize;
    while i < n {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '-' && i + 1 < n && chars[i + 1] == '-' {
            let start = i;
            while i < n && chars[i] != '\n' {
                i += 1;
            }
            atoms.push(Atom::Comment {
                text: chars[start..i].iter().collect(),
                line: true,
            });
            continue;
        }
        if c == '/' && i + 1 < n && chars[i + 1] == '*' {
            let start = i;
            i += 2;
            while i + 1 < n && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(n);
            atoms.push(Atom::Comment {
                text: chars[start..i].iter().collect(),
                line: false,
            });
            continue;
        }
        if c == '$' && dollar_tag_end(&chars, i).is_some() {
            let start = i;
            let close_index = dollar_tag_end(&chars, i).unwrap_or(i);
            let delimiter: String = chars[i..=close_index].iter().collect();
            i = close_index + 1;
            loop {
                if i >= n {
                    break; // 未闭合：吞到结尾
                }
                if chars[i] == '$' && i + delimiter.len() <= n {
                    let candidate: String = chars[i..i + delimiter.len()].iter().collect();
                    if candidate == delimiter {
                        i += delimiter.len();
                        break;
                    }
                }
                i += 1;
            }
            atoms.push(Atom::Quoted(chars[start..i].iter().collect()));
            continue;
        }
        if c == '\'' || c == '"' || c == '`' {
            let quote = c;
            let start = i;
            i += 1;
            loop {
                if i >= n {
                    break; // 未闭合：吞到结尾
                }
                if chars[i] == quote {
                    if i + 1 < n && chars[i + 1] == quote {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            atoms.push(Atom::Quoted(chars[start..i].iter().collect()));
            continue;
        }
        if c.is_ascii_alphabetic() || c == '_' {
            let start = i;
            while i < n && is_word_char(chars[i]) {
                i += 1;
            }
            atoms.push(Atom::Word(chars[start..i].iter().collect()));
            continue;
        }
        if c.is_ascii_digit() {
            let start = i;
            while i < n && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            atoms.push(Atom::Number(chars[start..i].iter().collect()));
            continue;
        }
        match c {
            ',' => {
                i += 1;
                atoms.push(Atom::Comma);
            }
            '(' => {
                i += 1;
                atoms.push(Atom::LParen);
            }
            ')' => {
                i += 1;
                atoms.push(Atom::RParen);
            }
            '.' => {
                i += 1;
                atoms.push(Atom::Dot);
            }
            _ if OP_CHARS.contains(&c) => {
                let start = i;
                while i < n && OP_CHARS.contains(&chars[i]) {
                    i += 1;
                }
                atoms.push(Atom::Op(chars[start..i].iter().collect()));
            }
            _ => {
                i += 1;
                atoms.push(Atom::Other(c));
            }
        }
    }
    atoms
}

fn next_word(atoms: &[Atom], index: usize) -> Option<&str> {
    atoms.get(index + 1).and_then(|atom| match atom {
        Atom::Word(word) => Some(word.as_str()),
        _ => None,
    })
}

/// 词输出改写：返回 (输出文本, 是否在输出前换行)
fn render_word(atoms: &[Atom], index: usize) -> (String, bool) {
    let word = match &atoms[index] {
        Atom::Word(word) => word.clone(),
        _ => return (String::new(), false),
    };
    let upper = word.to_ascii_uppercase();
    let prev_dot = index > 0 && atoms[index - 1] == Atom::Dot;
    let next_dot = matches!(atoms.get(index + 1), Some(Atom::Dot));
    let next_lparen = matches!(atoms.get(index + 1), Some(Atom::LParen));

    // 标识符限定名不视为关键字（t.select / schema.table）
    if prev_dot || next_dot {
        return (word, false);
    }
    // JOIN 修饰词：后随 JOIN 才换行改写
    if JOIN_MODIFIERS.contains(&upper.as_str())
        && next_word(atoms, index).is_some_and(|next| next.eq_ignore_ascii_case("JOIN"))
    {
        return (upper, true);
    }
    // JOIN 紧跟修饰词时不重复换行（LEFT JOIN 同行）
    if upper == "JOIN" {
        if let Some(Atom::Word(prev)) = index.checked_sub(1).and_then(|i| atoms.get(i)) {
            if JOIN_MODIFIERS.contains(&prev.to_ascii_uppercase().as_str()) {
                return (upper, false);
            }
        }
    }
    if KEYWORDS.contains(&upper.as_str()) {
        if FUNC_LIKE.contains(&upper.as_str()) && next_lparen {
            return (word, false);
        }
        let brk = BREAK_BEFORE.contains(&upper.as_str());
        return (upper, brk);
    }
    (word, false)
}

fn emit_break(out: &mut String) {
    if out.is_empty() || out.ends_with('\n') {
        return;
    }
    out.push_str("\n  ");
}

/// 是否在当前 atom 前输出空格
fn needs_space(out: &str, prev: Option<&Atom>) -> bool {
    if out.is_empty() || out.ends_with(' ') || out.ends_with('\n') {
        return false;
    }
    !matches!(prev, Some(Atom::LParen) | Some(Atom::Dot))
}

fn push_spaced(out: &mut String, text: &str, index: usize, atoms: &[Atom]) {
    let prev = if index > 0 { atoms.get(index - 1) } else { None };
    if needs_space(out, prev) {
        out.push(' ');
    }
    out.push_str(text);
}

/// 保守格式化：空输入原样返回（去尾随空白）
pub fn format_sql(input: &str) -> String {
    if input.trim().is_empty() {
        return input.trim_end().to_owned();
    }
    let atoms = lex(input);
    let mut out = String::with_capacity(input.len() + 32);
    for (index, atom) in atoms.iter().enumerate() {
        match atom {
            Atom::Word(_) => {
                let (text, brk) = render_word(&atoms, index);
                if brk {
                    emit_break(&mut out);
                }
                push_spaced(&mut out, &text, index, &atoms);
            }
            Atom::Number(number) => push_spaced(&mut out, number, index, &atoms),
            Atom::Quoted(raw) => push_spaced(&mut out, raw, index, &atoms),
            Atom::Comment { text, line } => {
                push_spaced(&mut out, text, index, &atoms);
                if *line {
                    out.push('\n');
                }
            }
            Atom::Op(op) => push_spaced(&mut out, op, index, &atoms),
            Atom::Comma => out.push(','),
            Atom::LParen => {
                // 统一空格（count (…) / t (a) / IN (…) 风格一致）
                if needs_space(&out, atoms.get(index.wrapping_sub(1))) {
                    out.push(' ');
                }
                out.push('(');
            }
            Atom::RParen => out.push(')'),
            Atom::Dot => out.push('.'),
            Atom::Other(c) => {
                if needs_space(&out, atoms.get(index.wrapping_sub(1))) {
                    out.push(' ');
                }
                out.push(*c);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uppercases_keywords_and_breaks_clauses() {
        assert_eq!(
            format_sql("select a, b from t where a=1 and b=2"),
            "SELECT a, b\n  FROM t\n  WHERE a = 1 AND b = 2"
        );
        assert_eq!(
            format_sql("select * from t order by a desc limit 10"),
            "SELECT *\n  FROM t\n  ORDER BY a DESC\n  LIMIT 10"
        );
        assert_eq!(
            format_sql("insert into t (a) values (1)"),
            "INSERT INTO t (a)\n  VALUES (1)"
        );
        assert_eq!(
            format_sql("update t set a = 1 where id = 2"),
            "UPDATE t\n  SET a = 1\n  WHERE id = 2"
        );
    }

    #[test]
    fn preserves_strings_and_identifiers() {
        assert_eq!(
            format_sql("select 'abc', \"x;y\" from t"),
            "SELECT 'abc', \"x;y\"\n  FROM t"
        );
        assert_eq!(format_sql("select 'a;b'"), "SELECT 'a;b'");
        // 限定名中的同名关键字不改写
        assert_eq!(
            format_sql("select t.left, t2.count from t"),
            "SELECT t.left, t2.count\n  FROM t"
        );
        // 函数名与关键字同形时不改写
        assert_eq!(
            format_sql("select left(name, 2) from t"),
            "SELECT left (name, 2)\n  FROM t"
        );
    }

    #[test]
    fn handles_joins_and_comments() {
        assert_eq!(
            format_sql("select * from a left join b on a.id=b.id where a.x=1"),
            "SELECT *\n  FROM a\n  LEFT JOIN b ON a.id = b.id\n  WHERE a.x = 1"
        );
        assert_eq!(
            format_sql("select 1 -- note\nfrom t"),
            "SELECT 1 -- note\nFROM t"
        );
        assert_eq!(
            format_sql("select /* c1 */ 1 from t"),
            "SELECT /* c1 */ 1\n  FROM t"
        );
    }

    #[test]
    fn dollar_quoted_and_empty_inputs() {
        assert_eq!(format_sql("select $$a;b$$ as v"), "SELECT $$a;b$$ AS v");
        assert_eq!(format_sql("select $fn$x;y$fn$"), "SELECT $fn$x;y$fn$");
        assert_eq!(format_sql(""), "");
        assert_eq!(format_sql("   "), "");
        assert_eq!(format_sql("select 1"), "SELECT 1");
    }
}
