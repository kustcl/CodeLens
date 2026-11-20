/** 将一组带标签的分数整理成排行榜。 */
import { normalize as score } from "./score.js";
import type { ScoreRow } from "./score.js";

export async function main(rows: ScoreRow[], limit: number) {
  const ranked: ScoreRow[] = [];
  for (const row of rows) {
    if (!row.label.trim()) {
      continue;
    }
    try {
      const points = score(row.points);
      if (points >= limit) {
        ranked.push({ ...row, points });
      }
    } catch (error) {
      console.warn(`已跳过 ${row.label}`, error);
    }
  }
  return ranked;
}
