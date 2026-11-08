/** 命令面板：模糊匹配（子序列 + 连续/词首加权）与动作注册表类型 */

export interface PaletteAction {
  id: string;
  title: string;
  keywords: string;
  run: () => void;
}

export interface PaletteMatch<T> {
  item: T;
  score: number;
}

/**
 * 子序列模糊匹配：全部查询字符按序命中才算匹配。
 * 加分：连续命中、词首命中；大小写不敏感。
 */
export function fuzzyScore(query: string, target: string): number | null {
  if (query === "") {
    return 0;
  }
  const lowerQuery = query.toLowerCase();
  const lowerTarget = target.toLowerCase();
  let score = 0;
  let queryIndex = 0;
  let previousHit = -2;
  for (let index = 0; index < lowerTarget.length && queryIndex < lowerQuery.length; index += 1) {
    if (lowerTarget[index] !== lowerQuery[queryIndex]) {
      continue;
    }
    score += 1;
    if (index === previousHit + 1) {
      score += 2; // 连续命中
    }
    if (index === 0 || /[\s_\-./]/.test(lowerTarget[index - 1] ?? "")) {
      score += 3; // 词首命中
    }
    previousHit = index;
    queryIndex += 1;
  }
  if (queryIndex < lowerQuery.length) {
    return null;
  }
  // 越短的目标越靠前
  return score + Math.max(0, 20 - lowerTarget.length) / 10;
}

export function matchActions<T extends { title: string; keywords?: string }>(
  query: string,
  items: readonly T[],
): Array<PaletteMatch<T>> {
  const matches: Array<PaletteMatch<T>> = [];
  for (const item of items) {
    const titleScore = fuzzyScore(query, item.title);
    const keywordScore = item.keywords ? fuzzyScore(query, item.keywords) : null;
    const score = keywordScore !== null ? Math.max(titleScore ?? 0, keywordScore + 1) : titleScore;
    if (score !== null) {
      matches.push({ item, score });
    }
  }
  return matches.sort((a, b) => b.score - a.score);
}
