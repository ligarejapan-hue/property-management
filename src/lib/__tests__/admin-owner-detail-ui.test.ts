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

  it("permissions / capabilities は ScreenProtectionProvider 経由（useScreenProtection）で取得する（直接 fetch しない）", () => {
    // F12 展開(19-A): ページ独自の /api/me/permissions fetch を撤去し、provider 配布値
    //（permissions / capabilities）から fieldEditable / corporateLookupConfigured を導出。
    expect(pageSrc).toMatch(/useScreenProtection\(\)/);
    expect(pageSrc).not.toMatch(/fetch\(\s*["']\/api\/me\/permissions["']/);
    // 旧 fetch 実装の痕跡（setter）が残っていない
    expect(pageSrc).not.toMatch(/setCorporateLookupConfigured/);
    expect(pageSrc).not.toMatch(/setFieldEditable/);
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

  // ---- Codex P1: 別 Owner 遷移時の corporateInput 残留防止 ----
  it("Codex P1: load 毎に setCorporateInput(\"\") で初期化してから条件付きで採用", () => {
    // try 内、setData(res) の後に setCorporateInput("") が来る（stale guard 通過後）
    expect(pageSrc).toMatch(
      /setData\(res\);[\s\S]{0,500}setCorporateInput\(""\);/,
    );
    // その後の if/else if で setCorporateInput(existing) または
    // setCorporateInput(candidate...) が呼ばれる
    expect(pageSrc).toMatch(/setCorporateInput\(existing\)/);
    expect(pageSrc).toMatch(
      /setCorporateInput\(res\.candidate\.candidateCorporateNumberMasked\)/,
    );
  });

  it("Codex P1: setCorporateInput(\"\") は stale guard return の後にある（最新リクエストのみ反映）", () => {
    // myReqId !== requestIdRef.current で return された後にだけ setCorporateInput("") が走る
    expect(pageSrc).toMatch(
      /myReqId\s*!==\s*requestIdRef\.current[\s\S]{0,80}return;[\s\S]{0,500}setCorporateInput\(""\);/,
    );
  });

  it("Codex P1: setCorporateInput への流し込みは raw 13桁検証ガード経由", () => {
    // existing 流し込みは /^\d{13}$/.test(existing) ガード内
    expect(pageSrc).toMatch(
      /\/\^\\d\{13\}\$\/\.test\(existing\)[\s\S]{0,80}setCorporateInput\(existing\)/,
    );
    // candidate 流し込みも /^\d{13}$/.test ガード内 + type === "missing" 条件
    expect(pageSrc).toMatch(
      /res\.candidate\?\.type\s*===\s*"missing"[\s\S]{0,200}\/\^\\d\{13\}\$\/\.test\(res\.candidate\.candidateCorporateNumberMasked\)[\s\S]{0,200}setCorporateInput\(res\.candidate\.candidateCorporateNumberMasked\)/,
    );
  });

  it("Codex P1: candidate なし & existing がマスク／null の場合、setCorporateInput(\"\") の後に追加採用が無い", () => {
    // setCorporateInput("") の後に出現する setCorporateInput 呼び出しは全てガード経由
    // → unconditional な setCorporateInput(...) が他に存在しないことを担保
    const matches = pageSrc.match(/setCorporateInput\([^)]+\)/g) ?? [];
    // 期待: setCorporateInput("") / setCorporateInput(existing) /
    //       setCorporateInput(res.candidate.candidateCorporateNumberMasked) /
    //       setCorporateInput(e.target.value) (input onChange) /
    //       setCorporateInput(candidate.candidateCorporateNumberMasked ?? "") (banner 「法人番号欄に転記」)
    // 上記以外の unconditional 呼び出しがないことを確認
    const allowed = new Set([
      'setCorporateInput("")',
      "setCorporateInput(existing)",
      "setCorporateInput(res.candidate.candidateCorporateNumberMasked)",
      "setCorporateInput(e.target.value)",
      'setCorporateInput(\n                            candidate.candidateCorporateNumberMasked ?? "",\n                          )',
    ]);
    for (const m of matches) {
      // 「allowed のいずれかを含む」または「candidate.candidateCorporateNumberMasked ?? \"\"」を含む
      const ok =
        allowed.has(m) ||
        m.includes("candidate.candidateCorporateNumberMasked ?? \"\"") ||
        m === "setCorporateInput(e.target.value)";
      expect(ok, `unexpected setCorporateInput call: ${m}`).toBe(true);
    }
  });
});

// =======================================================================
// F12 展開(19-A): permissions/capabilities を ScreenProtectionProvider 経由へ移行。
//   - ページ独自 /api/me/permissions fetch を撤去し provider 配布値を消費する
//   - 進入時 refresh + pending lazy init + effectivePermissions/effectiveCapabilities
//   - 取得中 / 進入時 refresh 中 / 取得失敗 / 未取得は fail-safe（[] / false）に倒し、
//     stale な権限・capability で編集/照会 UI を出さない（field-survey の tristate null
//     とは異なり、owner full/edit は boolean なので properties 一覧型の制限的 collapse）。
// 参照実装は properties 一覧（permissions-provider-distribution.test.ts がロック）。
// =======================================================================
describe("F12 展開(19-A) — admin owner 詳細は provider 経由で permissions/capabilities を取得", () => {
  it("useScreenProtection() から permissions/capabilities/permissionsLoading/refetchPermissions を取得する", () => {
    expect(pageSrc).toMatch(/useScreenProtection/);
    expect(pageSrc).toMatch(/permissions:\s*mePermissions/);
    expect(pageSrc).toMatch(/capabilities:\s*meCapabilities/);
    expect(pageSrc).toMatch(/permissionsLoading/);
    expect(pageSrc).toMatch(/refetchPermissions/);
  });

  it("ページ独自の /api/me/permissions 直接 fetch を持たない（provider 経由のみ・旧 fetch 痕跡なし）", () => {
    expect(pageSrc).not.toMatch(/fetch\(\s*["']\/api\/me\/permissions["']/);
    expect(pageSrc).not.toMatch(/setFieldEditable/);
    expect(pageSrc).not.toMatch(/setCorporateLookupConfigured/);
  });

  it("進入時 refresh: 進入(mount)あたり最大1回 refetchPermissions を呼び finally で pending を解除する", () => {
    expect(pageSrc).toMatch(/permissionsRefreshRequestedRef\.current/);
    expect(pageSrc).toMatch(
      /refetchPermissions\(\)\.finally\(\(\) => \{\s*setPermissionsRefreshPending\(false\);\s*\}\)/,
    );
  });

  it("進入時 refresh: provider 取得進行中は呼ばない / mount 時進行中の成功時は追加 fetch しない", () => {
    expect(pageSrc).toMatch(/if \(permissionsLoading\) return;/);
    expect(pageSrc).toMatch(
      /permissionsLoadingAtMountRef\.current === true && mePermissions !== null/,
    );
  });

  it("pending lazy init: mount 時に取得完了済みなら最初の描画から pending=true で開始", () => {
    expect(pageSrc).toMatch(
      /useState\(\s*\n?\s*\(\) => !permissionsLoading,?\s*\n?\s*\)/,
    );
  });

  it("effectivePermissions / effectiveCapabilities: pending/loading 中は [] / false に倒す（stale 表示防止・fail-safe）", () => {
    expect(pageSrc).toMatch(
      /permissionsRefreshPending \|\| permissionsLoading\s*\n?\s*\?\s*\[\]\s*\n?\s*:\s*\(mePermissions \?\? \[\]\)/,
    );
    expect(pageSrc).toMatch(
      /permissionsRefreshPending \|\| permissionsLoading\s*\n?\s*\?\s*false\s*\n?\s*:\s*meCapabilities\?\.corporateLookup === true/,
    );
  });

  it("導出は useMemo の純関数（setter / state 持ち越しなし）で fieldEditable / corporateLookupConfigured を返す", () => {
    expect(pageSrc).toMatch(
      /const \{ fieldEditable, corporateLookupConfigured \} = useMemo/,
    );
    expect(pageSrc).toMatch(
      /\[permissionsRefreshPending,\s*permissionsLoading,\s*mePermissions,\s*meCapabilities\]/,
    );
  });

  it("owner full/edit と corporateLookup 判定ロジックは不変（緩めない）", () => {
    expect(pageSrc).toMatch(/p\.action === "full" && p\.granted/);
    expect(pageSrc).toMatch(/p\.action === "edit" && p\.granted/);
    expect(pageSrc).toMatch(
      /hasFullPerm\("owner_corporate_number"\)\s*\|\|\s*\n?\s*hasEditPerm\("owner_corporate_number"\)/,
    );
    expect(pageSrc).toMatch(/meCapabilities\?\.corporateLookup === true/);
  });

  it("server 側権限ゲート・API route は触らず、導出値を Panel に props で渡すのみ", () => {
    expect(pageSrc).toMatch(/fieldEditable=\{fieldEditable\}/);
    expect(pageSrc).toMatch(/configured=\{corporateLookupConfigured\}/);
  });
});
