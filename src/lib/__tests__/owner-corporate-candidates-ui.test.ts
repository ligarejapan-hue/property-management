/**
 * Phase E UI source-assertion テスト。
 *
 * - /admin/owners/correction に「法人番号」タブ + サブフィルタが存在
 * - Owner 詳細リンクが描画される
 * - バルク操作（ボタン）を持たない
 * - fetchCorporateCandidates を呼ぶ
 * - API レスポンスに含まれる法人番号フィールドの参照名が *Masked のみで生 corporateNumber を直接表示していない
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const pageSrc = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/(dashboard)/admin/owners/correction/page.tsx",
  ),
  "utf8",
);

describe("admin/owners/correction page Phase E 法人番号タブ", () => {
  it("filterType に corporate_number が追加されている", () => {
    expect(pageSrc).toMatch(
      /type\s+FilterType\s*=[\s\S]{0,200}"corporate_number"/,
    );
  });

  it("タブ配列に label: 法人番号 が含まれる", () => {
    expect(pageSrc).toMatch(/key:\s*"corporate_number"[\s\S]{0,40}label:\s*"法人番号"/);
  });

  it("CorporateNumberCandidatesPanel をマウントする条件分岐がある", () => {
    expect(pageSrc).toMatch(/filterType\s*===\s*"corporate_number"/);
    expect(pageSrc).toMatch(/<CorporateNumberCandidatesPanel\s*\/>/);
  });

  it("fetchCorporateCandidates を import + 呼び出している", () => {
    expect(pageSrc).toMatch(/fetchCorporateCandidates/);
  });

  it("サブフィルタが 5 種（default / missing / conflict / multi / same）", () => {
    expect(pageSrc).toMatch(/"default"[\s\S]{0,200}"missing"[\s\S]{0,200}"conflict"[\s\S]{0,200}"multi"[\s\S]{0,200}"same"/);
  });

  it("default サブフィルタは API には all として送る（same を除外する仕様）", () => {
    expect(pageSrc).toMatch(
      /subFilter\s*===\s*"default"\s*\?\s*"all"\s*:\s*subFilter/,
    );
  });

  it("Owner 詳細リンクが <Link href={c.detailUrl}> で描画される", () => {
    expect(pageSrc).toMatch(/<Link[\s\S]{0,80}href=\{c\.detailUrl\}/);
    expect(pageSrc).toMatch(/Owner\s+詳細を開く/);
  });

  it("バルク操作の checkbox / 「一括反映」ボタンが無い", () => {
    // CorporateNumberCandidatesPanel 内に bulk 系トークンが存在しないこと
    const panelMatch = pageSrc.match(
      /function CorporateNumberCandidatesPanel[\s\S]*$/,
    );
    expect(panelMatch).not.toBeNull();
    const body = panelMatch?.[0] ?? "";
    expect(body).not.toMatch(/一括反映|bulk[A-Za-z]*Apply|<input[^>]*type="checkbox"/i);
  });

  it("表示に使う列は *Masked フィールドで、生 corporateNumber を直参照しない", () => {
    const panelMatch = pageSrc.match(
      /function CorporateNumberCandidatesPanel[\s\S]*$/,
    );
    expect(panelMatch).not.toBeNull();
    const body = panelMatch?.[0] ?? "";
    expect(body).toMatch(/c\.candidateCorporateNumberMasked/);
    expect(body).toMatch(/c\.existingCorporateNumberMasked/);
    // c.corporateNumber や record.corporateNumber を直参照していないこと
    expect(body).not.toMatch(/c\.corporateNumber\b/);
  });

  it("truncated バナーを描画する条件分岐がある", () => {
    expect(pageSrc).toMatch(/data\.truncated/);
    expect(pageSrc).toMatch(/スキャン上限到達/);
  });

  it("cursor pagination の前後ボタンを描画する", () => {
    expect(pageSrc).toMatch(/前へ/);
    expect(pageSrc).toMatch(/次へ/);
    expect(pageSrc).toMatch(/nextCursor/);
  });
});
