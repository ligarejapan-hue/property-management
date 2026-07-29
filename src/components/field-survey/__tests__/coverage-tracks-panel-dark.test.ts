/**
 * 線（歩いた道筋）の切替・断り書きの dark 配色。
 *
 * 面（歩いた場所）の断り書きと同じ配色規則に揃える。ここが欠けると、
 * 夜間の現場でスマホをダークモードにしている人に文字が読めなくなる。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "field-survey-map.tsx"), "utf8");

/** 線の断り書きだけを切り出す（面の分と取り違えない）。 */
function noticeOf(testId: string): string {
  const i = src.indexOf(`data-testid="${testId}"`);
  if (i < 0) return "";
  return src.slice(Math.max(0, i - 400), i + 400);
}

describe("線の断り書き dark: 配色", () => {
  it("確認中は中立色（灰）で dark 対応がある", () => {
    const m = noticeOf("tracks-loading-notice");
    expect(m).toContain("dark:bg-gray-800/40");
    expect(m).toContain("dark:text-gray-300");
  });

  it("範囲過大は琥珀で dark 対応がある", () => {
    const m = noticeOf("tracks-truncated-notice");
    expect(m).toContain("dark:bg-amber-500/15");
    expect(m).toContain("dark:text-amber-300");
  });

  it("取得失敗は琥珀で dark 対応がある", () => {
    const m = noticeOf("tracks-unavailable-notice");
    expect(m).toContain("dark:bg-amber-500/15");
    expect(m).toContain("dark:text-amber-300");
  });

  it("一部だけ表示のときも琥珀で dark 対応がある", () => {
    const m = noticeOf("tracks-dropped-notice");
    expect(m).toContain("dark:bg-amber-500/15");
    expect(m).toContain("dark:text-amber-300");
  });

  it("線の色の説明にも dark 対応がある", () => {
    const i = src.indexOf("灰色の線＝過去に歩いた道");
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i - 200, i)).toContain("dark:text-gray-400");
  });
});
