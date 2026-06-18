/**
 * Phase B UI 統合 source-assertion テスト。
 *
 * - 「法人情報を検索」ボタンが panel に存在する
 * - 検索中表示（"検索中..."）がある
 * - preview パネル（data-testid="corporate-lookup-preview"）がある
 * - 廃止法人警告（"廃止法人" バッジ）がある
 * - Phase C: 反映チェックボックスと apply ボタンが存在し、applyOwnerCorporate を呼ぶ
 * - Phase C: ownerVersion / fieldEditable / onApplied props を受け取る
 * - 自動 lookup / 自動保存しない（mount 時 lookup 呼び出しなし）
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

  it("Phase C: 反映チェックボックスと apply ボタンが存在する", () => {
    // 反映対象選択チェックボックスが描画されている
    expect(panelSrc).toMatch(/会社名 → 所有者名/);
    expect(panelSrc).toMatch(/所在地 → 現住所/);
    expect(panelSrc).toMatch(/郵便番号/);
    // 反映ボタンと applyOwnerCorporate API 呼び出し
    expect(panelSrc).toMatch(/applyOwnerCorporate/);
    expect(panelSrc).toMatch(/選択した項目を所有者に反映/);
    // PATCH 経由の Owner 更新導線は持たない（apply API 経由のみ）
    expect(panelSrc).not.toMatch(/updateOwner\(/);
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

  it("検索結果に searchedFor を紐づけ、現在入力と一致しないと preview / error を出さない", () => {
    // 検索開始時に searchedFor を確定する
    expect(panelSrc).toMatch(/setSearchedFor\(/);
    // showResult / showError ガードがあり、normalized と searchedFor の一致を要求する
    expect(panelSrc).toMatch(/const\s+showResult\s*=[\s\S]{0,200}searchedFor\s*===\s*normalized/);
    expect(panelSrc).toMatch(/const\s+showError\s*=[\s\S]{0,200}searchedFor\s*===\s*normalized/);
    // 描画側で showResult / showError を使っている（生 result / error を直接条件にしない）
    const previewRender = panelSrc.match(/\{showResult\s*&&\s*result[\s\S]*?data-testid="corporate-lookup-preview"/);
    expect(previewRender).not.toBeNull();
    const errorRender = panelSrc.match(/\{showError\s*&&/);
    expect(errorRender).not.toBeNull();
  });

  it("rawCorporateNumber が変わる = normalized が変わると古い preview が見えなくなる（ガード経由）", () => {
    // 「searchedFor !== normalized なら showResult が false」になる構造
    expect(panelSrc).toMatch(
      /showResult\s*=\s*result\s*!==\s*null\s*&&\s*searchedFor\s*!==\s*null\s*&&\s*searchedFor\s*===\s*normalized/,
    );
  });

  it("Phase C: ownerVersion / fieldEditable / onApplied props を受け取る", () => {
    expect(panelSrc).toMatch(/ownerVersion\??:\s*number/);
    expect(panelSrc).toMatch(/fieldEditable\??:\s*\{/);
    expect(panelSrc).toMatch(/onApplied\??:/);
  });

  it("Phase C: 廃止法人は confirm を出してから apply する", () => {
    expect(panelSrc).toMatch(/window\.confirm/);
    expect(panelSrc).toMatch(/廃止/);
  });

  it("Phase C: apply は再 lookup 結果を信用するため expectedRecord を送る", () => {
    expect(panelSrc).toMatch(/expectedRecord/);
    // postCode / updateDate を比較スナップショットとして送る
    // (conflict ack 再送のため result.record を const record に取り出して使う)
    expect(panelSrc).toMatch(/postCode:\s*record\.postCode/);
    expect(panelSrc).toMatch(/updateDate:\s*record\.updateDate/);
  });

  it("conflict(明らかな不一致)は確認のうえ acknowledgeConflict=true で再送する", () => {
    expect(panelSrc).toMatch(/CONFLICT_NOT_ACKNOWLEDGED/);
    expect(panelSrc).toMatch(/acknowledgeConflict/);
    // generic CONFLICT(楽観ロック)より先に判定する
    expect(panelSrc).toMatch(
      /CONFLICT_NOT_ACKNOWLEDGED[\s\S]{0,400}window\.confirm/,
    );
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

  it("corporateLookupConfigured を provider 配布の capabilities から導出（直接 fetch しない）", () => {
    // F12 展開(19-A 第3実装): ページ独自 fetch を撤去し meCapabilities から導出。
    // 移行形の網羅ロックは properties-detail-permissions-provider.test.ts。
    expect(pageSrc).toMatch(/meCapabilities\?\.corporateLookup === true/);
    expect(pageSrc).not.toMatch(/setCorporateLookupConfigured/);
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

  it("候補バナーは currentInput が非空なら early return する（手入力した別法人番号を保護）", () => {
    // 関数本体を抽出して、currentInput.trim() !== "" の early return が
    // 「candidates 計算より前」に置かれていることを確認する。
    // 関数末端の判定は「次の function 宣言まで」または EOF。
    const bannerFn = pageSrc.match(
      /function CorporateNumberCandidateBanner[\s\S]*?(?=\nfunction |\nexport default function |\n\/\/ ----|$)/,
    );
    expect(bannerFn).not.toBeNull();
    const body = bannerFn?.[0] ?? "";
    // currentInput.trim() !== "" による early return がある
    expect(body).toMatch(/currentInput\.trim\(\)\s*!==\s*""\s*\)\s*return\s+null/);
    // candidates 算出より前で return している（順序保証）
    const earlyReturnIdx = body.search(/currentInput\.trim\(\)\s*!==\s*""\s*\)\s*return\s+null/);
    const candidatesIdx = body.search(/detection\.candidates/);
    expect(earlyReturnIdx).toBeGreaterThan(-1);
    expect(candidatesIdx).toBeGreaterThan(-1);
    expect(earlyReturnIdx).toBeLessThan(candidatesIdx);
  });

  it("候補バナーは「入力値と異なる候補だけを除外」する旧ロジックを持たない", () => {
    // 古い実装: detection.candidates.filter((c) => c !== normalizedInput) が無いこと。
    // P3 で「入力欄に値があれば一律バナー非表示」方針に変更したため。
    const bannerFn = pageSrc.match(
      /function CorporateNumberCandidateBanner[\s\S]*?(?=\nfunction |\nexport default function |\n\/\/ ----|$)/,
    );
    expect(bannerFn).not.toBeNull();
    const body = bannerFn?.[0] ?? "";
    expect(body).not.toMatch(/\.filter\(\s*\(c\)\s*=>\s*c\s*!==\s*normalizedInput\s*\)/);
  });

  it("候補バナーの docstring が「入力欄に値があるなら描画しない」方針を明示", () => {
    // 仕様の食い違いで Codex P3 が再発しないよう doc を assert する。
    expect(pageSrc).toMatch(/入力欄に既に何らかの値がある\s*→\s*描画しない/);
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
