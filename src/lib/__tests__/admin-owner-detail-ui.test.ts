/**
 * Phase F UI source-assertion テスト。
 *
 * /admin/owners/[id]/page.tsx の構成を担保する:
 * - 「補正候補に戻る」リンクが存在
 * - fetchAdminOwnerCorporateCandidate を呼ぶ
 * - CorporateLookupPanel を再利用しマウント
 * - バルク操作ボタンがない
 * - 候補法人番号を URL query に載せない（候補値は API レスポンス由来）
 * - candidate.type で missing / conflict / multi / same のラベル分岐
 * - fieldEditable.corporateNumber が false のときは入力欄・Panel を出さない
 * - ownerVersion / fieldEditable を Panel に props で渡している
 * - stale guard (requestIdRef / mountedRef) を実装
 * - 失敗時に setData(null) で stale 表示を残さない
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const pageSrc = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/(dashboard)/admin/owners/[id]/page.tsx",
  ),
  "utf8",
);

describe("/admin/owners/[id] page (Phase F)", () => {
  it("「補正候補に戻る」リンクが /admin/owners/correction?tab=corporate_number へ向く", () => {
    expect(pageSrc).toMatch(
      /href="\/admin\/owners\/correction\?tab=corporate_number"/,
    );
    expect(pageSrc).toMatch(/補正候補に戻る/);
  });

  it("fetchAdminOwnerCorporateCandidate を import + 呼び出している", () => {
    expect(pageSrc).toMatch(/fetchAdminOwnerCorporateCandidate/);
    expect(pageSrc).toMatch(
      /fetchAdminOwnerCorporateCandidate\(ownerId\)/,
    );
  });

  it("CorporateLookupPanel を import + マウント", () => {
    expect(pageSrc).toMatch(
      /from\s+"@\/components\/owners\/corporate-lookup-panel"/,
    );
    expect(pageSrc).toMatch(/<CorporateLookupPanel/);
  });

  it("CorporateLookupPanel に ownerVersion / fieldEditable / onApplied を渡す", () => {
    expect(pageSrc).toMatch(/ownerVersion=\{owner\.version\}/);
    expect(pageSrc).toMatch(/fieldEditable=\{fieldEditable\}/);
    expect(pageSrc).toMatch(/onApplied=/);
  });

  it("候補 type 別ラベル/バッジが存在する", () => {
    expect(pageSrc).toMatch(/missing/);
    expect(pageSrc).toMatch(/conflict/);
    expect(pageSrc).toMatch(/multi/);
    expect(pageSrc).toMatch(/same/);
    // 候補バナーに data-testid
    expect(pageSrc).toMatch(/data-testid="corporate-candidate-banner"/);
  });

  it("バルク操作ボタンが無い（一括反映 / bulk apply / checkbox 一覧）", () => {
    expect(pageSrc).not.toMatch(/一括反映|bulkApply|bulk-apply/i);
    // テーブル全選択型の checkbox も無い
    expect(pageSrc).not.toMatch(/<input[^>]*type="checkbox"[^>]*select-all/i);
  });

  it("候補法人番号を URL query に載せていない（router.push などで candidate を URL に渡さない）", () => {
    expect(pageSrc).not.toMatch(/router\.push[\s\S]{0,200}candidate/);
    expect(pageSrc).not.toMatch(/[?&]candidate=/);
    expect(pageSrc).not.toMatch(/[?&]corporateNumber=/);
  });

  it("fieldEditable.corporateNumber=false のとき入力欄・Panel を出さない条件分岐", () => {
    // 三項演算 `fieldEditable.corporateNumber ? (...) : (...)`
    expect(pageSrc).toMatch(
      /fieldEditable\.corporateNumber\s*\?\s*\(/,
    );
    expect(pageSrc).toMatch(/法人番号の編集権限がありません/);
  });

  it("/api/me/permissions を呼んで fieldEditable / corporateLookupConfigured を取得", () => {
    expect(pageSrc).toMatch(/\/api\/me\/permissions/);
    expect(pageSrc).toMatch(/setCorporateLookupConfigured/);
    expect(pageSrc).toMatch(/setFieldEditable/);
  });

  it("missing 候補に「法人番号欄に転記」ボタンがあり、転記値は API レスポンス候補値", () => {
    expect(pageSrc).toMatch(/法人番号欄に転記/);
    // setCorporateInput(candidate.candidateCorporateNumberMasked ...) という形
    expect(pageSrc).toMatch(/setCorporateInput\(/);
    expect(pageSrc).toMatch(/candidate\.candidateCorporateNumberMasked/);
  });

  it("Codex P2 流の stale guard を実装（requestIdRef / mountedRef）", () => {
    expect(pageSrc).toMatch(/requestIdRef\s*=\s*useRef\(0\)/);
    expect(pageSrc).toMatch(/mountedRef\s*=\s*useRef\(true\)/);
    expect(pageSrc).toMatch(/\+\+requestIdRef\.current/);
    expect(pageSrc).toMatch(
      /!mountedRef\.current\s*\|\|\s*myReqId\s*!==\s*requestIdRef\.current/,
    );
  });

  it("load 開始 + catch で setData(null) して stale 表示を残さない", () => {
    expect(pageSrc).toMatch(
      /\+\+requestIdRef\.current;[\s\S]{0,400}setLoading\(true\);[\s\S]{0,400}setError\(null\);[\s\S]{0,400}setData\(null\);[\s\S]{0,200}try\s*\{/,
    );
    expect(pageSrc).toMatch(
      /catch\s*\([^)]*\)\s*\{[\s\S]{0,300}setError\([^)]*\);[\s\S]{0,80}setData\(null\);/,
    );
  });

  it("マスク値（XXXX***）は入力欄初期値に流し込まない（13桁数字検証）", () => {
    // existing がマスクパターン (XXXX*********) の場合は corporateInput に入れない
    expect(pageSrc).toMatch(/\/\^\\d\{13\}\$\/\.test\(existing\)/);
  });
});
