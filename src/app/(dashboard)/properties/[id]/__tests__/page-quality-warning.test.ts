import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "page.tsx"), "utf8");

describe("properties/[id]/page.tsx 品質警告セクション (§8-6 C2)", () => {
  // --- 取得手段: 一覧と同じ fetchQualityCheck を使っているか ---
  it("fetchQualityCheck を api-client からインポートしている", () => {
    expect(src).toContain("fetchQualityCheck");
  });

  it("propertyIds スコープで品質チェックを呼んでいる", () => {
    expect(src).toContain("propertyIds");
  });

  // --- severity 別の色 ---
  it("error 系に bg-red-50 がある", () => {
    expect(src).toContain("bg-red-50");
  });

  it("error 系に text-red-700 がある", () => {
    expect(src).toContain("text-red-700");
  });

  it("error 系の dark: に dark:bg-red-500/10 がある", () => {
    expect(src).toContain("dark:bg-red-500/10");
  });

  it("error 系の dark: に dark:text-red-300 がある", () => {
    expect(src).toContain("dark:text-red-300");
  });

  it("warning 系に bg-amber-50 がある（品質警告セクション）", () => {
    expect(src).toContain("bg-amber-50");
  });

  it("warning 系に text-amber-700 がある", () => {
    expect(src).toContain("text-amber-700");
  });

  it("warning 系の dark: に dark:bg-amber-500/10 がある", () => {
    expect(src).toContain("dark:bg-amber-500/10");
  });

  it("warning 系の dark: に dark:text-amber-300 がある", () => {
    expect(src).toContain("dark:text-amber-300");
  });

  // --- fail-safe: ゼロ件=非表示・失敗=非表示 ---
  it("qualityIssues.length > 0 の条件分岐がある（ゼロ件非表示）", () => {
    expect(src).toContain("qualityIssues.length > 0");
  });

  it("catch ブロックで例外を握りつぶしている（取得失敗=fail-safe）", () => {
    // fetchQualityCheck の try/catch が存在する
    expect(src).toContain("fetchQualityCheck");
    // try ... catch で例外ハンドリングしている
    expect(src).toContain("} catch {");
  });

  it("severity !== \"info\" でフィルタしている（info は非表示）", () => {
    expect(src).toContain('severity !== "info"');
  });

  // --- PII 非露出: 所有者名等の生データを品質警告セクションに渡していないこと ---
  it("品質警告セクションに ownerNames を直接出力していない", () => {
    // 品質警告の message は quality-check API が返すメタ情報のみ
    // ownerNames を qualityIssues に混入する処理がないことを確認
    expect(src).not.toContain("ownerNames: qualityIssues");
    expect(src).not.toContain("qualityIssues.push(ownerName");
  });

  it("qualityIssues は message と severity のみ保持している", () => {
    // message プロパティが品質警告セクションで使われている
    expect(src).toContain("issue.message");
    // severity プロパティで色分けしている
    expect(src).toContain("issue.severity");
  });

  // --- 既存の「調査未確認」バッジとの共存 ---
  it("既存の investigationConfirmedAt チェックは残っている", () => {
    expect(src).toContain("investigationConfirmedAt");
  });

  // --- useState で qualityIssues を管理している ---
  it("qualityIssues state が定義されている", () => {
    expect(src).toContain("qualityIssues");
    expect(src).toContain("setQualityIssues");
  });

  // --- @codex P2: 物件更新時にも品質警告を再取得する ---
  it("loadQualityIssues が useCallback として定義されている（更新時再取得のため）", () => {
    expect(src).toContain("loadQualityIssues");
    expect(src).toContain("useCallback");
  });

  it("fetchProperty が loadQualityIssues を依存配列に含んでいる", () => {
    expect(src).toContain("loadQualityIssues");
    // fetchProperty の useCallback 依存配列に loadQualityIssues が含まれている
    expect(src).toContain("[id, loadQualityIssues]");
  });

  it("fetchProperty が完了後に loadQualityIssues を呼び出している（更新後の警告再取得）", () => {
    // fetchProperty が loadQualityIssues を呼ぶことで更新アクション後も警告が最新になる
    expect(src).toContain("void loadQualityIssues()");
  });

  it("cancelled フラグで stale な取得結果の上書きを防いでいる", () => {
    expect(src).toContain("cancelled");
    expect(src).toContain("if (cancelled) return");
  });
});
