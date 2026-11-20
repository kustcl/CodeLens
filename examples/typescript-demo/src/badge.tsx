/** 将分数渲染成带标签的徽标。 */
import { normalize } from "./score.js";

export function ScoreBadge({ value }: { value: number }) {
  const score = normalize(value);
  return <span title="分数">🎯 {score}</span>;
}
