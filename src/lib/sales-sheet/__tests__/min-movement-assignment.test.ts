import { describe, it, expect } from "vitest";
import { assignMinMovement, type Point } from "../min-movement-assignment";

/** 割当が順列（各スロットにちょうど1写真）であることを検証。 */
function isPermutation(assignment: number[], n: number): boolean {
  if (assignment.length !== n) return false;
  const seen = new Set(assignment);
  return seen.size === n && assignment.every((s) => s >= 0 && s < n);
}

/** 割当の総移動距離（ユークリッド）。 */
function totalDistance(photos: Point[], slots: Point[], assignment: number[]): number {
  return assignment.reduce((sum, slotIdx, photoIdx) => {
    const dx = photos[photoIdx].x - slots[slotIdx].x;
    const dy = photos[photoIdx].y - slots[slotIdx].y;
    return sum + Math.hypot(dx, dy);
  }, 0);
}

describe("assignMinMovement", () => {
  it("空入力は空配列", () => {
    expect(assignMinMovement([], [])).toEqual([]);
  });

  it("1件は必ずスロット0へ", () => {
    expect(assignMinMovement([{ x: 5, y: 9 }], [{ x: 100, y: 100 }])).toEqual([0]);
  });

  it("既に各写真がスロット中心にある場合は恒等割当（移動ゼロ）", () => {
    const pts: Point[] = [
      { x: 10, y: 10 },
      { x: 50, y: 10 },
      { x: 10, y: 50 },
    ];
    expect(assignMinMovement(pts, pts)).toEqual([0, 1, 2]);
  });

  it("各写真を最も近いスロットへ割り当てる（入れ替わりを解消）", () => {
    // 写真0はスロット1の近く、写真1はスロット0の近く。最小移動＝交差を解く。
    const photos: Point[] = [
      { x: 90, y: 10 }, // slot1(100,10) に近い
      { x: 12, y: 10 }, // slot0(10,10) に近い
    ];
    const slots: Point[] = [
      { x: 10, y: 10 },
      { x: 100, y: 10 },
    ];
    expect(assignMinMovement(photos, slots)).toEqual([1, 0]);
  });

  it("最適な総移動距離を返す（貪欲な近傍より良い解を選ぶ）", () => {
    // 貪欲だと写真0→slot0を先に取り、写真1が遠いslotに残ることがある構成。
    const photos: Point[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ];
    const slots: Point[] = [
      { x: 2, y: 0 },
      { x: 0, y: 0 },
    ];
    const assignment = assignMinMovement(photos, slots);
    expect(isPermutation(assignment, 2)).toBe(true);
    // 最適解 = 写真0→slot1(距離0), 写真1→slot0(距離1) = 合計1。
    expect(totalDistance(photos, slots, assignment)).toBeCloseTo(1, 5);
  });

  it("同点は入力順を優先＝恒等割当（積み重ね写真でも代表写真が先頭スロット）", () => {
    // 全写真が同一点に積み重なった degenerate ケース。どのスロットも等距離だが、
    // tie-break により写真 k → スロット k（恒等）に決定的に収まる。
    const photos: Point[] = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ];
    const slots: Point[] = [
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 100, y: 100 },
    ];
    const a = assignMinMovement(photos, slots);
    const b = assignMinMovement(photos, slots);
    expect(a).toEqual(b);
    expect(a).toEqual([0, 1, 2]);
  });

  it("未確定(追加直後)の写真は距離競争から外れ、既存写真がスロットを保つ", () => {
    // 実シナリオ: 既存写真0はゾーン中央(2スロットに等距離)、追加写真1は中央寄りで slot0 に近い。
    const photos: Point[] = [
      { x: 98.5, y: 109.5 }, // 既存(代表): slot0/slot1 に等距離
      { x: 148.5, y: 105 }, // 追加直後(ページ中央)
    ];
    const slots: Point[] = [
      { x: 98.5, y: 76.75 }, // slot0(上)
      { x: 98.5, y: 142.25 }, // slot1(下)
    ];
    // 距離だけの最小化(自由指定なし)では追加写真が上スロットを奪う。
    expect(assignMinMovement(photos, slots)).toEqual([1, 0]);
    // 追加写真(index 1)を距離競争から外すと、既存(代表)が上スロットを保ち追加は下へ。
    expect(assignMinMovement(photos, slots, new Set([1]))).toEqual([0, 1]);
  });

  it("4件でも順列かつ最適（グリッド想定）", () => {
    const photos: Point[] = [
      { x: 105, y: 105 },
      { x: 5, y: 5 },
      { x: 105, y: 5 },
      { x: 5, y: 105 },
    ];
    const slots: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 100 },
      { x: 100, y: 100 },
    ];
    const assignment = assignMinMovement(photos, slots);
    expect(isPermutation(assignment, 4)).toBe(true);
    // 各写真は最寄りの角: 0→3, 1→0, 2→1, 3→2
    expect(assignment).toEqual([3, 0, 1, 2]);
  });
});
