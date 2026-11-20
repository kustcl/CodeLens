/** 定义分数记录，并将有效分数约束到 0–100。 */
export interface ScoreRow {
  label: string;
  points: number;
}

export const normalize = (value: number): number => {
  if (!Number.isFinite(value)) {
    throw new RangeError("分数必须是有限数字");
  }
  return Math.max(0, Math.min(100, value));
};
