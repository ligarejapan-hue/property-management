/**
 * OwnerMergePreviewButton の transport-level エラー表示テスト。
 *
 * 要件:
 *   - fetch 自体が throw した場合 (network / timeout / CORS / offline)、
 *     result は null のまま、エラーバナーがユーザーに表示される。
 *   - HTTP 4xx/5xx で JSON body がある場合は、既存の result ブロックで
 *     blockReasons / message を表示する（既存挙動）。
 *
 * テスト環境に React DOM が無いため source assertion で担保する。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const src = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/components/owners/OwnerMergePreviewButton.tsx",
  ),
  "utf8",
);

describe("OwnerMergePreviewButton: transport-level エラー表示", () => {
  it("catch ブロックで result を null に保つ（変造された JSON body を持たない）", () => {
    // catch (e) { ... } 内に setResult(null) が含まれる
    const catchMatch = src.match(/catch\s*\([\s\S]*?\)\s*\{([\s\S]*?)\}\s*\};?\s*\n/);
    expect(catchMatch).not.toBeNull();
    if (catchMatch) {
      expect(catchMatch[1]).toMatch(/setResult\(null\)/);
      expect(catchMatch[1]).toMatch(/setErrorMsg\(/);
      expect(catchMatch[1]).toMatch(/setState\(["']error["']\)/);
    }
  });

  it("state === 'error' && !result && errorMsg の独立エラーバナーが存在", () => {
    // result の有無に依存せず、state="error" + errorMsg だけで表示できるブロック
    expect(src).toMatch(
      /state\s*===\s*["']error["']\s*&&\s*!result\s*&&\s*errorMsg/,
    );
  });

  it("通信失敗用バナーが errorMsg を本文として表示する", () => {
    // バナー内に {errorMsg} の参照があること
    // （バナーは state==="error" && !result && errorMsg ブロック内）
    const bannerMatch = src.match(
      /state\s*===\s*["']error["']\s*&&\s*!result\s*&&\s*errorMsg[\s\S]*?\{errorMsg\}/,
    );
    expect(bannerMatch).not.toBeNull();
  });

  it("既存の result ブロック（HTTP 4xx/5xx + JSON body）の表示は維持されている", () => {
    // {result && ( ... blockReasons / summary ... )} が残っている
    expect(src).toMatch(/\{result\s*&&\s*\(/);
    expect(src).toMatch(/result\.blockReasons/);
    expect(src).toMatch(/result\.summary/);
  });

  it("正常系の done state では eligible/summary 表示を行う", () => {
    expect(src).toMatch(/result\.eligible/);
    // 「統合可能」「統合不可」ラベル文字列
    expect(src).toMatch(/統合可能|統合不可/);
  });

  it("masterId / sourceId 変更時の state reset useEffect は維持されている", () => {
    // 既存の reset テストを壊さないことの担保
    expect(src).toMatch(/useEffect/);
    expect(src).toMatch(/\[\s*masterId\s*,\s*sourceId\s*\]/);
    expect(src).toMatch(/setResult\(null\)/);
  });
});
