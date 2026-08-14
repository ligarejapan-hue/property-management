/**
 * F12 展開(19-A 第3実装): properties/[id] 詳細ページの permissions/capabilities を
 * ScreenProtectionProvider 経由へ移行したことをロックする source-assertion テスト。
 *
 *  - ページ独自 /api/me/permissions fetch を撤去し provider 配布値を消費する
 *  - 進入時 refresh + pending lazy init + effectivePermissions/effectiveCapabilities
 *  - 取得中 / 進入時 refresh 中 / 取得失敗 / 未取得は fail-safe([] / false)へ倒し、
 *    stale な権限・capability で編集/閲覧/自動取得 UI を出さない(field-survey の
 *    tristate null とは異なり、本ページの 8 状態は全て boolean ゲートなので
 *    properties 一覧 / admin owner 詳細と同じ制限的 collapse)。
 *  - 8 状態の判定述語(granted / full|edit / owner:write && owner_note)は不変(緩めない)。
 *
 * 参照実装: admin/owners/[id]/page.tsx(admin-owner-detail-ui.test.ts がロック)。
 * 権限仕様・PII 表示条件・server 側権限ゲート・/api/me/permissions route は変更しない。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const pageSrc = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/(dashboard)/properties/[id]/page.tsx",
  ),
  "utf8",
);

describe("F12 展開(19-A 第3実装) — properties 詳細は provider 経由で permissions/capabilities を取得", () => {
  it("useScreenProtection() から permissions/capabilities/permissionsLoading/refetchPermissions を取得する", () => {
    expect(pageSrc).toMatch(/useScreenProtection/);
    expect(pageSrc).toMatch(/permissions:\s*mePermissions/);
    expect(pageSrc).toMatch(/capabilities:\s*meCapabilities/);
    expect(pageSrc).toMatch(/permissionsLoading/);
    expect(pageSrc).toMatch(/refetchPermissions/);
  });

  it("ページ独自の /api/me/permissions 直接 fetch を持たない(provider 経由のみ・旧 fetch 痕跡なし)", () => {
    expect(pageSrc).not.toMatch(/fetch\(\s*["']\/api\/me\/permissions["']/);
  });

  it("旧 page-local fetch 実装の setter 痕跡が一切残っていない(8 状態すべて)", () => {
    expect(pageSrc).not.toMatch(/setCanWriteProperty/);
    expect(pageSrc).not.toMatch(/setCanWriteOwner/);
    expect(pageSrc).not.toMatch(/setCanReadOwner/);
    expect(pageSrc).not.toMatch(/setCanCreateOwnerMemo/);
    expect(pageSrc).not.toMatch(/setCorporateLookupConfigured/);
    expect(pageSrc).not.toMatch(/setCanAutoFetchRegistry/);
    expect(pageSrc).not.toMatch(/setRegistryAutoFetchConfigured/);
    expect(pageSrc).not.toMatch(/setOwnerEditableFields/);
  });

  it("旧 fetch レスポンスの inline 型注釈(capabilities?: { corporateLookup?: boolean } / registryAutoFetch?: boolean)が残っていない", () => {
    expect(pageSrc).not.toMatch(/capabilities\?:\s*\{[^}]*corporateLookup\?:\s*boolean/);
    expect(pageSrc).not.toMatch(/registryAutoFetch\?:\s*boolean/);
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

  it("effectivePermissions: pending/loading 中は [] に倒す(stale 表示防止・制限的 collapse・NOT tristate null)", () => {
    expect(pageSrc).toMatch(
      /permissionsRefreshPending \|\| permissionsLoading\s*\n?\s*\?\s*\[\]\s*\n?\s*:\s*\(mePermissions \?\? \[\]\)/,
    );
  });

  it("effectiveCapabilities: ページが読む capability を**すべて** collapseCapabilities 経由で pending/loading 中は false に倒す(1つでも素通りは不可)", () => {
    // collapse フラグは permissions と同じ pending/loading で立てる。
    expect(pageSrc).toMatch(
      /const collapseCapabilities =\s*\n?\s*permissionsRefreshPending \|\| permissionsLoading/,
    );
    // 非交渉 #1: === true リテラルの存在だけでなく collapse の ternary 自体を明示ロックし、
    // 将来の refactor が capability の collapse を黙って外す silent drift を防ぐ。
    // ⚠**capability 名を手で並べない**。並べる作りだと、ページが新しい capability を
    //   読み始めたときに素通りする(2026-08-15: registryAutoFetch を撤去した際、
    //   名指しの配列だったこのテストが「2つ」を前提にしていて落ちた)。
    //   実際に読んでいる `meCapabilities?.X` を**走査して**全部に collapse を要求する。
    const used = [
      ...pageSrc.matchAll(/meCapabilities\?\.([A-Za-z0-9_]+)\s*===\s*true/g),
    ].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const cap of new Set(used)) {
      expect(pageSrc).toMatch(
        new RegExp(
          `= collapseCapabilities\\s*\\n?\\s*\\?\\s*false\\s*\\n?\\s*:\\s*meCapabilities\\?\\.${cap} === true`,
        ),
      );
    }
    // 撤去した自動取得ボタンの capability は、このページではもう読まない。
    expect(used).not.toContain("registryAutoFetch");
  });

  it("導出は単一 useMemo の純関数(setter / state 持ち越しなし)で 8 状態を返す", () => {
    expect(pageSrc).toMatch(/=\s*useMemo\(/);
    expect(pageSrc).toMatch(
      /\[permissionsRefreshPending,\s*permissionsLoading,\s*mePermissions,\s*meCapabilities\]/,
    );
  });

  it("scalar permission 述語は不変(緩めない・granted)", () => {
    expect(pageSrc).toMatch(/p\.resource === "property" && p\.action === "write" && p\.granted/);
    expect(pageSrc).toMatch(/p\.resource === "owner" && p\.action === "write" && p\.granted/);
    expect(pageSrc).toMatch(/p\.resource === "owner" && p\.action === "read" && p\.granted/);
    expect(pageSrc).toMatch(/p\.resource === "registry" && p\.action === "auto_fetch" && p\.granted/);
  });

  it("field-level 述語は不変(full / edit)", () => {
    expect(pageSrc).toMatch(/p\.action === "full" && p\.granted/);
    expect(pageSrc).toMatch(/p\.action === "edit" && p\.granted/);
  });

  it("ownerEditableFields 台帳: 7 キーが owner_<field> full(corporateNumber は full||edit)から導出される", () => {
    expect(pageSrc).toMatch(/name:\s*hasFullPerm\("owner_name"\)/);
    expect(pageSrc).toMatch(/nameKana:\s*hasFullPerm\("owner_name_kana"\)/);
    expect(pageSrc).toMatch(/phone:\s*hasFullPerm\("owner_phone"\)/);
    expect(pageSrc).toMatch(/zip:\s*hasFullPerm\("owner_zip"\)/);
    expect(pageSrc).toMatch(/address:\s*hasFullPerm\("owner_address"\)/);
    expect(pageSrc).toMatch(/email:\s*hasFullPerm\("owner_email"\)/);
    expect(pageSrc).toMatch(
      /corporateNumber:\s*\n?\s*hasFullPerm\("owner_corporate_number"\)\s*\|\|\s*\n?\s*hasEditPerm\("owner_corporate_number"\)/,
    );
  });

  it("canCreateOwnerMemo は owner:write && owner_note(full||edit)の複合述語を保つ(最も locked が薄い導出・緩めない)", () => {
    expect(pageSrc).toMatch(
      /canWriteOwner && \(hasFullPerm\("owner_note"\) \|\| hasEditPerm\("owner_note"\)\)/,
    );
  });

  it("導出 const 名は現行を維持し下流配線へそのまま渡す(canRead/canWrite/editableFields/canAutoFetch/providerConfigured)", () => {
    // 下流の prop 配線(canRead={canReadOwner} 等)を温存するため const 名を変えない。
    expect(pageSrc).toMatch(/canRead=\{canReadOwner\}/);
    expect(pageSrc).toMatch(/canWrite=\{canWriteOwner\}/);
    expect(pageSrc).toMatch(/editableFields=\{ownerEditableFields\}/);
    expect(pageSrc).toMatch(/canAutoFetch=\{canAutoFetchRegistry\}/);
    // ⚠2026-08-15: 自動取得ボタンを撤去したので、providerConfigured を受け取るのは
    //   所在検索ボタン（より厳しい capability）だけになった。
    expect(pageSrc).toMatch(
      /providerConfigured=\{registryLocationSearchConfigured\}/,
    );
    expect(pageSrc).not.toMatch(/registryAutoFetchConfigured/);
  });
});
