/**
 * 一括で外れた物件を「黙って減らさない」（設計 §3.1.0）。
 *
 * ⚠理由によって利用者のやることが違うので、すべてを「地番が未入力」と書かない。
 * ⚠住所・地番そのものは出さない（秘匿・設計 §5）。件数と理由だけ。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(
    process.cwd(),
    "src/app/(dashboard)/properties/registry-fetch/[jobId]/page.tsx",
  ),
  "utf8",
);

describe("除外理由の内訳", () => {
  it("⚠items を参照する（件数タイルだけにしない）", () => {
    // サーバーは物件ごとの理由を返しているのに、画面が使っていなかった。
    expect(src).toContain("progress.items");
    expect(src).toContain("ExcludedReasons");
  });

  it.each([
    ["missing_identifier", "地番・家屋番号が未入力"],
    ["malformed_identifier", "地番/家屋番号の書き方"],
    ["insufficient_location", "住所が未入力"],
    ["has_real_estate_number", "所在検索の対象外"],
    ["identifier_changed", "内容が変わりました"],
    ["ambiguous_candidate", "候補が複数"],
    ["no_candidate", "候補が見つかりません"],
    ["property_unavailable", "物件を参照できません"],
  ])("%s の理由文言を持つ", (_code, label) => {
    expect(src).toContain(label);
  });

  it("⚠不動産番号は「入力の不備」ではなく「対象外」として書く", () => {
    // 直せば通るものではない（番号での取得は途中で止まる既存の行き止まり）。
    expect(src).toContain("所在検索の対象外");
  });

  it("skipped 以外は内訳に出さない（失敗・要確認は別のタイルで出す）", () => {
    expect(src).toContain('it.status !== "skipped"');
  });

  it("⚠住所や地番を画面に出さない（件数と理由だけ）", () => {
    // ExcludedReasons が受け取るのは items（id/propertyId/status/errorCode）のみ。
    expect(src).not.toMatch(/ExcludedReasons[\s\S]{0,200}address/);
    expect(src).not.toMatch(/ExcludedReasons[\s\S]{0,200}lotNumber/);
  });

  it("次にやることを書く（1件ずつ物件ページで対応）", () => {
    expect(src).toContain("物件ページから1件ずつ");
  });
});
