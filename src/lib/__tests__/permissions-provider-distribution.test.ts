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
 * 8) Codex 対応（復旧導線+権限鮮度）: provider は refetchPermissions（mount fetch と
 *    共通の loadPermissions・stable callback・in-flight ガード付き）を配布する。
 *    properties 一覧は進入（mount）あたり最大 1 回だけそれを呼び、dashboard 滞在中の
 *    権限付与・剥奪に追従する（旧 page-level fetch が持っていた鮮度の復元）。
 *    ただし provider 取得進行中は呼ばず（同時 2 本に戻さない）、進行中だった取得が
 *    成功した場合は追加 fetch しない（失敗時のみ復旧として再取得）。
 *    ref ガード+in-flight dedupe で無限リトライなし・旧 page-level 直接 fetch は
 *    復活させない
 * 9) Codex 対応3（stale 非表示 + bypass fail-safe）: 進入時 refresh 完了までは
 *    stale な granted permissions でボタンを出さない（pending/loading 中は空配列に
 *    倒す）。provider の失敗系 2 分岐（catch/非 2xx）は permissions/capabilities=null
 *    に加えて bypass=false へ倒す（信頼できる応答が無いとき古い bypass=true を
 *    残さない）。refetchPermissions は完了を await できる Promise を返す
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
  it("/api/me/permissions の fetch call site は provider 内の 1 箇所のみ（mount と refetch で共有）", () => {
    // 実行回数は成功経路=1回・失敗→consumer refetch 経路=2回だが、
    // ソース上の call site は loadPermissions 内の 1 箇所に限定する。
    const matches = providerSrc.match(/fetch\(\s*["']\/api\/me\/permissions["']/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("context は permissions / capabilities / permissionsLoading / permissionsError / refetchPermissions を公開する（キー名固定）", () => {
    // interface 定義
    expect(providerSrc).toMatch(/permissions:\s*PermissionEntry\[\]\s*\|\s*null/);
    expect(providerSrc).toMatch(/capabilities:\s*MeCapabilities\s*\|\s*null/);
    expect(providerSrc).toMatch(/permissionsLoading:\s*boolean/);
    expect(providerSrc).toMatch(/permissionsError:\s*boolean/);
    // Codex 対応3: 完了を await できるよう Promise を返す
    expect(providerSrc).toMatch(/refetchPermissions:\s*\(\) => Promise<void>/);
    // Provider value に 7 キーすべてが渡る
    expect(providerSrc).toMatch(
      /value=\{\{\s*bypass,\s*watermarkText,\s*permissions,\s*capabilities,\s*permissionsLoading,\s*permissionsError,\s*refetchPermissions:\s*loadPermissions,?\s*\}\}/,
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

  it("fail-safe 一式: catch では permissions/capabilities=null + bypass=false へ倒す（Codex 対応3）", () => {
    const catchBlock = providerSrc.match(/\.catch\(\(\) => \{[\s\S]*?\}\)/)?.[0] ?? "";
    expect(catchBlock).not.toBe("");
    expect(catchBlock).toMatch(/setBypass\(false\)/);
    expect(catchBlock).toMatch(/setPermissions\(null\)/);
    expect(catchBlock).toMatch(/setCapabilities\(null\)/);
    expect(catchBlock).toMatch(/setPermissionsError\(true\)/);
    expect(catchBlock).toMatch(/setPermissionsLoading\(false\)/);
    expect(catchBlock).not.toMatch(/setPermissions\(perms\)/);
    // bypass=true へ広げる方向の呼び出しが無い（false 固定のみ）
    expect(catchBlock).not.toMatch(/setBypass\(true\)|setBypass\(isScreenProtectionBypassed/);
  });

  it("fail-safe 一式: 非 2xx（json=null）でも permissions/capabilities=null + bypass=false へ倒す（Codex 対応3）", () => {
    // res.ok でない場合 null に倒す既存形を維持し、!json 分岐は fail-safe 一式のみ
    expect(providerSrc).toMatch(/res\.ok \? res\.json\(\) : null/);
    const nullBranch = providerSrc.match(/if \(!json\) \{[\s\S]*?\}/)?.[0] ?? "";
    expect(nullBranch).toMatch(/setBypass\(false\)/);
    expect(nullBranch).toMatch(/setPermissions\(null\)/);
    expect(nullBranch).toMatch(/setCapabilities\(null\)/);
    expect(nullBranch).toMatch(/setPermissionsError\(true\)/);
    expect(nullBranch).not.toMatch(/setPermissions\(perms\)/);
    expect(nullBranch).not.toMatch(/setBypass\(true\)|setBypass\(isScreenProtectionBypassed/);
  });

  it("以前 bypass=true でも、信頼できる応答が無い refetch 後は bypass=false に倒れる（透かし/Guard が fail-safe 側で復帰）", () => {
    // bypass を true 側へ更新できるのは成功分岐の isScreenProtectionBypassed(perms)
    // のみで、失敗系 2 分岐（catch / !json）は無条件 setBypass(false)。
    // → 剥奪後に refetch が失敗しても古い bypass=true は残らず、
    //   !bypass 側の WatermarkOverlay 表示・Guard 抑止が有効になる。
    const successSets = providerSrc.match(/setBypass\(isScreenProtectionBypassed\(perms\)\)/g) ?? [];
    expect(successSets.length).toBe(1);
    const failSafeSets = providerSrc.match(/setBypass\(false\)/g) ?? [];
    expect(failSafeSets.length).toBe(2); // catch + !json
  });

  it("成功時は permissions/capabilities を配布し、permissionsError を false に戻す（復旧）", () => {
    expect(providerSrc).toMatch(/setPermissions\(perms\)/);
    expect(providerSrc).toMatch(/setPermissionsError\(false\)/);
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

// ── provider: refetch 復旧導線（Codex 対応）────────────────────────────────

describe("ScreenProtectionProvider — refetchPermissions 復旧導線（F12-2 Codex 対応）", () => {
  it("mount 時 fetch と refetch は共通の loadPermissions（stable callback・deps=[]・Promise 返却）", () => {
    expect(providerSrc).toMatch(
      /const loadPermissions = useCallback\(\(\): Promise<void> => \{[\s\S]*?\}, \[\]\);/,
    );
    // mount effect から共通関数を呼ぶ
    expect(providerSrc).toMatch(/loadPermissions\(\);/);
    // context には同一関数を refetchPermissions として配布
    expect(providerSrc).toMatch(/refetchPermissions:\s*loadPermissions/);
  });

  it("in-flight dedupe: 進行中は同一 Promise を返し fetch は同時 1 本（StrictMode 二重 effect・連続呼び出し対応）", () => {
    expect(providerSrc).toMatch(/if \(inFlightRef\.current\) return inFlightRef\.current;/);
    expect(providerSrc).toMatch(/inFlightRef\.current = run;/);
    expect(providerSrc).toMatch(
      /\.finally\(\(\) => \{\s*inFlightRef\.current = null;\s*\}\);/,
    );
  });

  it("refetch 中は permissionsLoading=true（dedupe 判定の直後に設定）", () => {
    expect(providerSrc).toMatch(
      /if \(inFlightRef\.current\) return inFlightRef\.current;\s*\n\s*setPermissionsLoading\(true\);/,
    );
  });

  it("default context の refetchPermissions は no-op（provider 外 fail-safe・resolved Promise）", () => {
    expect(providerSrc).toMatch(/refetchPermissions:\s*\(\) => Promise\.resolve\(\),/);
  });

  it("unmount 後は setState しない（mountedRef ガード）", () => {
    expect(providerSrc).toMatch(/if \(!mountedRef\.current\) return;/);
    expect(providerSrc).toMatch(/mountedRef\.current = false;/);
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
      /const \{\s*permissions: mePermissions,\s*permissionsLoading,\s*refetchPermissions,\s*\} = useScreenProtection\(\)/,
    );
    expect(pageSrc).toMatch(/const \{ canExportCsv, canExportDm \} = useMemo\(/);
  });

  it("権限鮮度: properties 進入（mount）あたり最大 1 回だけ refetchPermissions を呼ぶ（Codex 対応2）", () => {
    // ref ガード（進入あたり 1 回・無限リトライ防止）
    expect(pageSrc).toMatch(
      /if \(permissionsRefreshRequestedRef\.current\) return;/,
    );
    // 再確認の実行（mount 時完了済み=stale の可能性、または進行中だった取得の失敗=復旧）。
    // pending を立ててから呼び、完了（finally）で解除する（Codex 対応3）。
    expect(pageSrc).toMatch(
      /permissionsRefreshRequestedRef\.current = true;\s*\n\s*setPermissionsRefreshPending\(true\);\s*\n\s*refetchPermissions\(\)\.finally\(\(\) => \{\s*\n\s*setPermissionsRefreshPending\(false\);\s*\n\s*\}\);/,
    );
  });

  it("refresh 中は stale な granted permissions でボタンを出さない（Codex 対応3）", () => {
    // mount 時点で取得完了済み（= entry refresh が走る予定）なら最初の描画から
    // pending=true（旧 page-local fetch 時代の「mount 時 hidden 開始」と同じ）
    expect(pageSrc).toMatch(
      /useState\(\s*\n?\s*\(\) => !permissionsLoading,?\s*\n?\s*\)/,
    );
    // pending・loading 中は空配列に倒す＝refresh 完了後の最新 permissions からのみ導出
    expect(pageSrc).toMatch(
      /permissionsRefreshPending \|\| permissionsLoading\s*\n?\s*\?\s*\[\]\s*\n?\s*:\s*\(mePermissions \?\? \[\]\)/,
    );
  });

  it("refresh 完了後: 最新 permissions が granted なら表示・revoked なら非表示（純関数導出・失敗時は null→非表示）", () => {
    // refresh 完了（pending=false・loading=false）後は effectivePermissions =
    // mePermissions ?? [] となり、refetch 成功時は provider が配布した最新権限から
    // has() で再導出（granted→表示/revoked→非表示）。refetch 失敗時は provider が
    // permissions=null に倒すため [] → 全 false → 非表示（fail-safe）。
    expect(pageSrc).toMatch(/const effectivePermissions =/);
    expect(pageSrc).toMatch(
      /effectivePermissions\.some\(\s*\n?\s*\(p\) => p\.resource === resource && p\.action === "read" && p\.granted,?\s*\n?\s*\)/,
    );
  });

  it("権限鮮度: provider 取得進行中は呼ばない（初回 fetch と重複させない＝同時 2 本に戻さない）", () => {
    expect(pageSrc).toMatch(/if \(permissionsLoading\) return;/);
  });

  it("権限鮮度: mount 時進行中だった取得が成功した場合は追加 fetch しない（refetch せず満了）", () => {
    // mount 時点の進行状態を初回 render で一度だけ snapshot する
    expect(pageSrc).toMatch(
      /permissionsLoadingAtMountRef\.current === null\) \{\s*\n\s*permissionsLoadingAtMountRef\.current = permissionsLoading;/,
    );
    // 成功（permissions 非 null）なら ref を立てて return（refetch しない）
    expect(pageSrc).toMatch(
      /permissionsLoadingAtMountRef\.current === true && mePermissions !== null\) \{\s*\n[\s\S]{0,200}?permissionsRefreshRequestedRef\.current = true;\s*\n\s*return;/,
    );
  });

  it("権限付与・剥奪への追従: 導出は context 値の純関数（state 持ち越しなし）+ 進入時再確認", () => {
    // refetch 成功 → provider が setPermissions(perms) → context 更新 → useMemo 再導出
    // → ボタン表示/非表示が最新権限に追従する。導出結果を useState に保持しない
    // （古い snapshot が残らない）ことをロックする。
    expect(pageSrc).toMatch(
      /\}, \[permissionsRefreshPending, permissionsLoading, mePermissions\]\);/,
    );
    expect(pageSrc).not.toMatch(/useState[^\n]*canExportCsv/);
    expect(pageSrc).not.toMatch(/setCanExportCsv|setCanExportDm/);
  });

  it("鮮度再確認でもページは /api/me/permissions を直接 fetch しない（provider 経由のみ・旧 page-level fetch 非復活）", () => {
    expect(pageSrc).not.toMatch(/fetch\(\s*["']\/api\/me\/permissions["']/);
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
  it("properties 詳細は従来どおり独自 fetch のまま（別PR・最後の移行候補）", () => {
    for (const p of [
      "src/app/(dashboard)/properties/[id]/page.tsx",
    ]) {
      expect(read(p)).toMatch(/\/api\/me\/permissions/);
    }
  });

  it("field-survey-map は provider 経由へ移行済み（19-A・直接 fetch を持たない）", () => {
    // 19-A: F12 展開で field-survey-map.tsx の独自 /api/me/permissions fetch を撤去し、
    // useScreenProtection() の配布値から write/manage を導出する。詳細な新形
    //（tristate・進入時 refresh・pending lazy init）は field-survey-pin-ui-source.test.ts
    // がロックする。ここでは「直接 fetch を持たず provider を消費する」最小集合を固定。
    const mapSrc = read("src/components/field-survey/field-survey-map.tsx");
    expect(mapSrc).not.toMatch(/fetch\(\s*["']\/api\/me\/permissions["']/);
    expect(mapSrc).toMatch(/useScreenProtection/);
  });

  it("admin owner 詳細は provider 経由へ移行済み（19-A・直接 fetch を持たない）", () => {
    // 19-A: F12 展開で admin/owners/[id]/page.tsx の独自 /api/me/permissions fetch を
    // 撤去し、useScreenProtection() の permissions / capabilities から fieldEditable /
    // corporateLookupConfigured を導出する。詳細な新形（進入時 refresh・pending lazy
    // init・effectivePermissions/effectiveCapabilities の制限的 collapse）は
    // admin-owner-detail-ui.test.ts がロックする。ここでは最小集合を固定。
    const ownerPageSrc = read("src/app/(dashboard)/admin/owners/[id]/page.tsx");
    expect(ownerPageSrc).not.toMatch(/fetch\(\s*["']\/api\/me\/permissions["']/);
    expect(ownerPageSrc).toMatch(/useScreenProtection/);
  });

  it("dashboard layout の Provider 配置は不変", () => {
    const layoutSrc = read("src/components/layout/dashboard-layout.tsx");
    expect(layoutSrc).toMatch(/ScreenProtectionProvider/);
  });
});
