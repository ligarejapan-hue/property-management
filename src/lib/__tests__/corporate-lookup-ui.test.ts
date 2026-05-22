/**
 * Phase B UI 統合 source-assertion テスト。
 *
 * - 「法人情報を検索」ボタンが panel に存在する
 * - 検索中表示（"検索中..."）がある
 * - preview パネル（data-testid="corporate-lookup-preview"）がある
 * - 廃止法人警告（"廃止法人" バッジ）がある
 * - Phase B では「反映実行ボタン」が disabled or "Phase C で実装予定" 表示
 * - 自動 lookup / 自動保存しない（即 lookup 呼び出しなし）
 * - 候補バナーから法人番号欄へ転記する導線がある
 * - page.tsx 内に CorporateLookupPanel がマウントされている
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const panelSrc = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/owners/corporate-lookup-panel.tsx"),
  "utf8",
);
const pageSrc = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/(dashboard)/properties/[id]/page.tsx"),
  "utf8",
);

describe("corporate-lookup-panel.tsx", () => {
  it("「法人情報を検索」ボタンを描画する", () => {
    expect(panelSrc).toMatch(/法人情報を検索/);
    expect(panelSrc).toMatch(/<button[\s\S]*?onClick=\{handleSearch\}/);
  });

  it("検索中表示「検索中...」がある", () => {
    expect(panelSrc).toMatch(/検索中\.\.\./);
    expect(panelSrc).toMatch(/Loader2/);
  });

  it("preview パネル (data-testid=\"corporate-lookup-preview\") を持つ", () => {
    expect(panelSrc).toMatch(/data-testid="corporate-lookup-preview"/);
  });

  it("廃止法人バッジを描画する", () => {
    expect(panelSrc).toMatch(/廃止法人/);
  });

  it("Phase B では反映実行ボタンが disabled で、DB 書込 API を呼ばない", () => {
    // disabled 属性が付いていること
    expect(panelSrc).toMatch(/Phase C[^<]*実装予定/);
    // 「所有者名・現住所に反映」を含む button 要素全体（開きタグから閉じタグまで）を捕捉。
    const applyButtonBlock = panelSrc.match(
      /<button\b[\s\S]*?所有者名・現住所に反映[\s\S]*?<\/button>/,
    );
    expect(applyButtonBlock).not.toBeNull();
    expect(applyButtonBlock?.[0]).toMatch(/disabled/);
    // apply / update / save / patch を直接呼ぶ口がない
    expect(panelSrc).not.toMatch(/updateOwner\(/);
    expect(panelSrc).not.toMatch(/corporate-apply/);
    expect(panelSrc).not.toMatch(/fetch\(.*PATCH/);
  });

  it("env 未設定（configured=false）時のメッセージがある", () => {
    expect(panelSrc).toMatch(/法人番号API未設定/);
  });

  it("13桁正規化できない時はボタンを disabled にする", () => {
    expect(panelSrc).toMatch(/normalizeCorporateNumber\(rawCorporateNumber\)/);
    expect(panelSrc).toMatch(/canSearch\s*=/);
  });

  it("useEffect 等で自動 lookup していない（mount 時に lookup が走らない）", () => {
    // useEffect を使っていない、または useEffect 内に lookupOwnerCorporateNumber が無いこと
    const useEffectCalls = panelSrc.match(/useEffect\([\s\S]*?lookupOwnerCorporateNumber/);
    expect(useEffectCalls).toBeNull();
  });

  it("保存系 API (updateOwner / PATCH /api/owners/...) を呼ばない", () => {
    expect(panelSrc).not.toMatch(/PATCH/);
    expect(panelSrc).not.toMatch(/updateOwner/);
  });
});

describe("properties/[id]/page.tsx — CorporateLookupPanel 統合", () => {
  it("CorporateLookupPanel を import している", () => {
    expect(pageSrc).toMatch(
      /from\s+"@\/components\/owners\/corporate-lookup-panel"/,
    );
  });

  it("編集フォーム内で <CorporateLookupPanel ... /> をマウントしている", () => {
    expect(pageSrc).toMatch(/<CorporateLookupPanel/);
    expect(pageSrc).toMatch(/ownerId=\{po\.ownerId\}/);
    expect(pageSrc).toMatch(/rawCorporateNumber=\{form\.corporateNumber\}/);
  });

  it("corporateLookupConfigured を /api/me/permissions の capabilities から取得", () => {
    expect(pageSrc).toMatch(/capabilities\?:\s*\{\s*corporateLookup\?:\s*boolean\s*\}/);
    expect(pageSrc).toMatch(/setCorporateLookupConfigured/);
  });

  it("候補バナー (CorporateNumberCandidateBanner) から法人番号欄へ転記する導線", () => {
    expect(pageSrc).toMatch(/function CorporateNumberCandidateBanner/);
    expect(pageSrc).toMatch(/を法人番号欄に転記/);
    // onTransfer が form.corporateNumber を直接書き換える（自動 lookup しない）
    expect(pageSrc).toMatch(
      /onTransfer=\{\(candidate\)[\s\S]{0,120}corporateNumber:\s*candidate/,
    );
  });

  it("候補バナーが「自動 lookup・自動保存しない」旨を明示している", () => {
    expect(pageSrc).toMatch(/自動上書き・自動保存・自動検索はしません/);
  });
});

describe("api-client.ts — lookupOwnerCorporateNumber", () => {
  it("export がある", () => {
    const apiClientSrc = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/api-client.ts"),
      "utf8",
    );
    expect(apiClientSrc).toMatch(/export async function lookupOwnerCorporateNumber/);
    expect(apiClientSrc).toMatch(/corporate-lookup/);
  });
});
