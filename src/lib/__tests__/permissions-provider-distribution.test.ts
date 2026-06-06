/**
 * F12-2(17-C): ScreenProtectionProvider による permissions/capabilities の context 配布と、
 * properties 一覧の重複 fetch 撤去を固定する（source assertion）。
 *
 * 背景: provider は S1b-2 以来 /api/me/permissions を mount 時に 1 回取得していたが、
 * bypass/watermarkText しか公開しておらず、properties 一覧が同一エンドポイントを
 * 独自に再 fetch していた（mount 時に同時 2 リクエスト＝サーバ側 getUserPermissions
 * の DB 3 クエリが 2 倍）。F12-2 で provider が取得結果を context 配布し、
 * properties 一覧はそれを消費する。
 *
 * 固定する仕様:
 * 1) provider は /api/me/permissions を 1 箇所のみで fetch する
 * 2) context は permissions / capabilities / permissionsLoading / permissionsError を公開する
 *    （キー名固定＝消費側の契約）
 * 3) fail-safe: 取得失敗(catch)・非 2xx で permissions を配布しない（null のまま＝権限なし扱い）
 *    かつ bypass を true にしない（既存より緩くしない）
 * 4) capabilities は boolean 厳格判定（=== true）で広く許可しない
 * 5) bypass 判定（isScreenProtectionBypassed）・watermark 系は不変
 * 6) properties 一覧はページ独自の /api/me/permissions fetch を持たず、
 *    useScreenProtection() の permissions から CSV/DM 出力可否を導出する
 * 7) ボタン出し分け条件（csv_export && csv_export_personal、DM は + owner）は不変
 *
 * 権限仕様・PII 表示条件・server 側権限ゲート・/api/me/permissions route は一切変更しない
 * （route 契約は me-permissions-route.test.ts が別途ロック済み）。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const read = (p: string) =>
  fs.readFileSync(path.resolve(process.cwd(), p), "utf8");

const providerSrc = read(
  "src/components/screen-protection/screen-protection-provider.tsx",
);
const pageSrc = read("src/app/(dashboard)/properties/page.tsx");
const guardSrc = read(
  "src/components/screen-protection/screen-protection-guard.tsx",
);

// ── provider: 配布の形 ──────────────────────────────────────────────────────

describe("ScreenProtectionProvider — permissions/capabilities 配布（F12-2）", () => {
  it("/api/me/permissions の fetch は provider 内の 1 箇所のみ", () => {
    const matches = providerSrc.match(/fetch\(\s*["']\/api\/me\/permissions["']/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("context は permissions / capabilities / permissionsLoading / permissionsError を公開する（キー名固定）", () => {
    // interface 定義
    expect(providerSrc).toMatch(/permissions:\s*PermissionEntry\[\]\s*\|\s*null/);
    expect(providerSrc).toMatch(/capabilities:\s*MeCapabilities\s*\|\s*null/);
    expect(providerSrc).toMatch(/permissionsLoading:\s*boolean/);
    expect(providerSrc).toMatch(/permissionsError:\s*boolean/);
    // Provider value に 6 キーすべてが渡る
    expect(providerSrc).toMatch(
      /value=\{\{\s*bypass,\s*watermarkText,\s*permissions,\s*capabilities,\s*permissionsLoading,\s*permissionsError,?\s*\}\}/,
    );
  });

  it("MeCapabilities は corporateLookup / registryAutoFetch の boolean（route 契約と同名）", () => {
    expect(providerSrc).toMatch(
      /export interface MeCapabilities \{\s*corporateLookup:\s*boolean;\s*registryAutoFetch:\s*boolean;\s*\}/,
    );
  });

  it("capabilities は === true の厳格判定（boolean 以外を広く許可しない）", () => {
    expect(providerSrc).toMatch(
      /corporateLookup:\s*json\.capabilities\?\.corporateLookup\s*===\s*true/,
    );
    expect(providerSrc).toMatch(
      /registryAutoFetch:\s*json\.capabilities\?\.registryAutoFetch\s*===\s*true/,
    );
  });

  it("fail-safe: catch では permissions を配布せず（null のまま）、bypass も変更しない", () => {
    const catchBlock = providerSrc.match(/\.catch\(\(\) => \{[\s\S]*?\}\);/)?.[0] ?? "";
    expect(catchBlock).not.toBe("");
    expect(catchBlock).toMatch(/setPermissionsError\(true\)/);
    expect(catchBlock).toMatch(/setPermissionsLoading\(false\)/);
    expect(catchBlock).not.toMatch(/setPermissions\(perms\)/);
    expect(catchBlock).not.toMatch(/setBypass/);
    expect(catchBlock).not.toMatch(/setCapabilities/);
  });

  it("fail-safe: 非 2xx（json=null）でも permissions を配布しない", () => {
    // res.ok でない場合 null に倒す既存形を維持し、!json 分岐では error 通知のみ
    expect(providerSrc).toMatch(/res\.ok \? res\.json\(\) : null/);
    const nullBranch = providerSrc.match(/if \(!json\) \{[\s\S]*?\}/)?.[0] ?? "";
    expect(nullBranch).toMatch(/setPermissionsError\(true\)/);
    expect(nullBranch).not.toMatch(/setPermissions\(perms\)/);
    expect(nullBranch).not.toMatch(/setBypass/);
  });

  it("配布用 state の初期値は fail-safe（permissions=null / loading=true / error=false / bypass=false）", () => {
    expect(providerSrc).toMatch(
      /useState<PermissionEntry\[\]\s*\|\s*null>\(null\)/,
    );
    expect(providerSrc).toMatch(/useState<MeCapabilities \| null>\(null\)/);
    expect(providerSrc).toMatch(/setPermissionsLoading\] = useState\(true\)/);
    expect(providerSrc).toMatch(/setPermissionsError\] = useState\(false\)/);
    // bypass の fail-safe 初期値（S1b-2 以来不変）
    expect(providerSrc).toMatch(/\[bypass, setBypass\] = useState\(false\)/);
  });

  it("bypass 判定・watermark 系は不変（isScreenProtectionBypassed / buildWatermarkText / WatermarkOverlay / Guard）", () => {
    expect(providerSrc).toMatch(/setBypass\(isScreenProtectionBypassed\(perms\)\)/);
    expect(providerSrc).toMatch(/buildWatermarkText/);
    expect(providerSrc).toMatch(/<WatermarkOverlay text=\{watermarkText\} \/>/);
    expect(providerSrc).toMatch(/<ScreenProtectionGuard \/>/);
  });

  it("guard は従来どおり bypass のみを consume する（permissions 配布の影響なし）", () => {
    expect(guardSrc).toMatch(/const \{ bypass \} = useScreenProtection\(\)/);
    expect(guardSrc).not.toMatch(/permissionsLoading|permissionsError/);
  });
});

// ── properties 一覧: 重複 fetch 撤去と consume ──────────────────────────────

describe("properties 一覧 — provider 配布値の consume（F12-2）", () => {
  it("ページ独自の /api/me/permissions fetch を持たない（重複 fetch 撤去）", () => {
    // 実コードの fetch literal はゼロ（コメント内の説明言及のみ許容）
    expect(pageSrc).not.toMatch(/fetch\(\s*["']\/api\/me\/permissions["']/);
    expect(pageSrc).not.toMatch(/setCanExportCsv|setCanExportDm/);
  });

  it("useScreenProtection() の permissions から CSV/DM 出力可否を導出する", () => {
    expect(pageSrc).toMatch(
      /const \{ permissions: mePermissions \} = useScreenProtection\(\)/,
    );
    expect(pageSrc).toMatch(/const \{ canExportCsv, canExportDm \} = useMemo\(/);
  });

  it("出し分け条件は不変: CSV は csv_export && csv_export_personal", () => {
    expect(pageSrc).toMatch(
      /has\("csv_export"\)\s*&&\s*has\("csv_export_personal"\)/,
    );
  });

  it("出し分け条件は不変: DM は CSV 条件 + owner:read", () => {
    expect(pageSrc).toMatch(/canExportDm:\s*canCsv\s*&&\s*has\("owner"\)/);
  });

  it("has 判定は action === \"read\" && granted のまま（緩めない）", () => {
    expect(pageSrc).toMatch(
      /p\.resource === resource && p\.action === "read" && p\.granted/,
    );
  });

  it("fail-safe: permissions=null は空配列に倒して全て false（広く許可しない）", () => {
    expect(pageSrc).toMatch(/mePermissions\s*\?\?\s*\[\]/);
  });

  it("ボタン表示は従来どおり canExportCsv / canExportDm でゲートされる", () => {
    expect(pageSrc).toMatch(/canExportCsv\s*&&\s*\(/);
    expect(pageSrc).toMatch(/canExportDm\s*&&\s*\(/);
  });
});

// ── 非接触の確認 ────────────────────────────────────────────────────────────

describe("F12-2 — 他ページ・他領域は非接触（スコープ固定）", () => {
  it("properties 詳細・admin owner 詳細・field-survey-map は従来どおり独自 fetch のまま（別PR）", () => {
    for (const p of [
      "src/app/(dashboard)/properties/[id]/page.tsx",
      "src/app/(dashboard)/admin/owners/[id]/page.tsx",
      "src/components/field-survey/field-survey-map.tsx",
    ]) {
      expect(read(p)).toMatch(/\/api\/me\/permissions/);
    }
  });

  it("dashboard layout の Provider 配置は不変", () => {
    const layoutSrc = read("src/components/layout/dashboard-layout.tsx");
    expect(layoutSrc).toMatch(/ScreenProtectionProvider/);
  });
});
