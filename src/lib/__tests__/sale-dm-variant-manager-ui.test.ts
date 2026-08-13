/**
 * 型の管理パネルに外部AI方式の導線が入っている（設計 §2.2/§2.3）。
 *
 * vitest は env=node なのでクリック検証はできない。ハンドラ本体を切り出して
 * 「何を呼ぶか」を固定する（距離窓は脆いので使わない＝PR-C の教訓）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(
  path.resolve(process.cwd(), "src/components/sale-dm/variant-manager.tsx"),
  "utf8",
);
const LINES = src.split("\n");

/**
 * 名前付きハンドラの本体を切り出す。
 * ⚠内側の `});` で切ると本体の途中で終わる（実際に踏んだ）。次の**トップレベル宣言**
 * （インデント2の const）までを本体とみなす。
 */
function handlerBody(decl: string): string {
  const start = LINES.findIndex((l) => l.includes(decl));
  if (start < 0) return "";
  let end = LINES.length;
  for (let i = start + 1; i < LINES.length; i += 1) {
    if (LINES[i].startsWith("  const ")) {
      end = i;
      break;
    }
  }
  return LINES.slice(start, end).join("\n");
}

describe("型の管理パネル: 外部AI方式の導線", () => {
  it("切り出しが働いている（空振り・広すぎの防止）", () => {
    const b = handlerBody("const openLetter");
    expect(b.length).toBeGreaterThan(50);
    expect(b.length).toBeLessThan(1500);
  });

  it("プロンプトを取りに行くハンドラがある", () => {
    expect(handlerBody("const openLetter")).toContain(
      "fetchSaleDmVariantPrompt",
    );
  });

  it("保存は表示したときの指紋を一緒に送る（版ずれの検出）", () => {
    const b = handlerBody("const saveTemplate");
    expect(b).toContain("saveSaleDmVariantTemplate");
    expect(b).toContain("promptDigest");
  });

  it("適用は結果を件数で伝える（黙って減らさない）", () => {
    const b = handlerBody("const applyTemplate");
    expect(b).toContain("applySaleDmVariantTemplate");
    expect(b).toContain("skippedTagCount");
    expect(b).toContain("skippedScopeCount");
  });

  it("プロンプトのコピー導線がある", () => {
    expect(handlerBody("const copyPrompt")).toContain("clipboard");
  });

  it("凍結済みの型は貼り付けの導線を出さない", () => {
    expect(src).toContain("letter.frozen");
    expect(src).toMatch(/送付の実績があるため/);
  });

  it("凍結済みでも「適用」は使える（@codex #376）", () => {
    // 割当で別の型へ移された宛先は本文が空になる。ここを隠すと1件ずつ手で書くしかない。
    // 禁止すべきは「差し替え」であって「保存済みの文面の適用」ではない。
    // ⚠案内文にも同じ語が出るので、分岐より**後ろ**にあるボタンを探す。
    const condAt = src.indexOf("letter.frozen ? (");
    const applyAt = src.indexOf("onClick={() => applyTemplate(false)}", condAt);
    expect(condAt).toBeGreaterThan(0);
    expect(applyAt).toBeGreaterThan(condAt);
    // 分岐は適用ボタンより前に閉じている（＝ボタンは分岐の外）。
    const closeAt = src.indexOf("          )}", condAt);
    expect(closeAt).toBeGreaterThan(condAt);
    expect(closeAt).toBeLessThan(applyAt);
    expect(src).toMatch(/入れ直すことはできます/);
  });

  it("「追加の指示」の入力欄は出さない（外部プロンプトに載らないため）", () => {
    expect(src).not.toMatch(/setOpt\("extraInstruction"/);
  });

  it("日数や件数を文言に焼き込んでいない", () => {
    expect(src).not.toMatch(/90日|20,000字/);
  });
});
