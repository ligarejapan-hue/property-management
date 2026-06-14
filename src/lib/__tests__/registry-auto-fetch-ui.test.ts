/**
 * PR5: 謄本「自動取得」UI 導線の確認。
 *
 * house 規約（vitest environment:"node"・jsdom 無し）に合わせ、コンポーネント / ページ /
 * route のソースを fs で読む source-assertion を中心に確認し、provider capability ヘルパは
 * runtime（null → false）+ 実装関係（getRegistryFetchProvider() != null）で確認する。
 *
 * 確認観点（指示対応）:
 *  - registry:auto_fetch 権限がある場合だけ描画（非 admin 非表示）
 *  - capabilities.registryAutoFetch を参照し、provider 未設定時は disabled + 理由文
 *  - 確認後の submit 経路でのみ confirmed:true を送る / POST 先が /registry/auto-fetch
 *  - 501 / 409 を成功扱いしない / owner 名・住所など PII を UI で参照しない・console.log しない
 *  - ActionBar の ACTIONS[] には載せない
 *  - permissions route が registryAutoFetch capability を返す
 *  - null provider → false（runtime）/ provider あり → true（実装が != null 関係）
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

// isRegistryAutoFetchProviderConfigured を隔離 import するための mock。
// auto-fetch.ts の隣接 import を no-op 化し、heavy 依存（pdf-parse/storage/prisma 等）を
// 読み込まずに helper 単体を評価する。helper / getRegistryFetchProvider はこれら依存を使わない。
vi.mock("@/lib/prisma", () => ({ default: {} }));
vi.mock("@/lib/api-helpers", () => ({ ApiError: class extends Error {} }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/property-access", () => ({ canAccessPropertyRecord: vi.fn() }));
vi.mock("@/lib/pdf-extract", () => ({
  extractTextFromPdf: vi.fn(),
  isPdfBuffer: vi.fn(),
}));
vi.mock("@/lib/registry-pdf/process", () => ({ processRegistryPdf: vi.fn() }));
vi.mock("@/lib/registry-fetch", () => ({
  RegistryFetchError: class extends Error {},
}));

import {
  getRegistryFetchProvider,
  isRegistryAutoFetchProviderConfigured,
} from "@/lib/registry-fetch/auto-fetch";

const read = (rel: string) =>
  fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");

const buttonSrc = read(
  "src/components/properties/registry-auto-fetch-button.tsx",
);
const pageSrc = read("src/app/(dashboard)/properties/[id]/page.tsx");
const actionBarSrc = read("src/components/properties/action-bar.tsx");
const permRouteSrc = read("src/app/api/me/permissions/route.ts");
const autoFetchSrc = read("src/lib/registry-fetch/auto-fetch.ts");

describe("RegistryAutoFetchButton — 描画ゲートと安全性 (source assertion)", () => {
  it("registry:auto_fetch が無ければ何も描画しない（非 admin 非表示）", () => {
    expect(buttonSrc).toMatch(/canAutoFetch/);
    expect(buttonSrc).toMatch(/if\s*\(\s*!canAutoFetch\s*\)\s*return null/);
  });

  it("provider 未設定（providerConfigured=false）は disabled + 理由文を表示する", () => {
    expect(buttonSrc).toMatch(/providerConfigured/);
    expect(buttonSrc).toMatch(/disabled=\{[^}]*providerDisabled[^}]*\}/);
    expect(buttonSrc).toMatch(
      /謄本自動取得プロバイダが未設定のため現在実行できません。/,
    );
  });

  it("POST 先は /registry/auto-fetch（method=POST）", () => {
    expect(buttonSrc).toMatch(
      /\/api\/properties\/\$\{propertyId\}\/registry\/auto-fetch/,
    );
    expect(buttonSrc).toMatch(/method:\s*"POST"/);
  });

  it("確認(confirming)を経た submit 経路でのみ課金確認フラグを 1 回だけ送る", () => {
    expect(buttonSrc).toMatch(/state\s*===\s*"confirming"/);
    expect(buttonSrc).toMatch(/handleConfirm/);
    expect(buttonSrc).toMatch(/JSON\.stringify\(\{\s*confirmed:\s*true\s*\}\)/);
    const occurrences = buttonSrc.match(/confirmed:\s*true/g) ?? [];
    expect(occurrences.length).toBe(1);
  });

  it("501 / 409 等の非 2xx を成功扱いしない（res.ok 以外は throw、done は ok 後）", () => {
    expect(buttonSrc).toMatch(/if\s*\(\s*!res\.ok\s*\)/);
    expect(buttonSrc).toMatch(/throw new Error/);
    const okIdx = buttonSrc.indexOf("!res.ok");
    const doneIdx = buttonSrc.indexOf('setState("done")');
    expect(okIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeGreaterThan(okIdx);
  });

  it("所有者氏名 / 住所など PII を UI で参照せず console.log もしない", () => {
    expect(buttonSrc).not.toMatch(/console\.log/);
    expect(buttonSrc).not.toMatch(
      /ownerName|owner_name|ownerAddress|owner_address|nameKana|name_kana|parsedOwners/i,
    );
  });

  it("成功時は onComplete を呼ぶ", () => {
    expect(buttonSrc).toMatch(/onComplete\(\)/);
  });

  it("確認文に有料・明示確認・再取得(obtained 時)の注意がある", () => {
    expect(buttonSrc).toMatch(/有料/);
    expect(buttonSrc).toMatch(/明示/);
    expect(buttonSrc).toMatch(/registryStatus\s*===\s*"obtained"/);
    expect(buttonSrc).toMatch(/再取得/);
  });
});

describe("PropertyDetailPage — 自動取得導線の配線 (source assertion)", () => {
  it("registry:auto_fetch 権限を provider 配布の permissions から導出する", () => {
    // F12 展開(19-A 第3実装): setter を撤去し useMemo 内で effectivePermissions から導出。
    expect(pageSrc).not.toMatch(/setCanAutoFetchRegistry/);
    // 判定述語は不変（緩めない）。導出元が provider 配布値に変わるだけ。
    expect(pageSrc).toMatch(
      /p\.resource === "registry" && p\.action === "auto_fetch" && p\.granted/,
    );
  });

  it("registryAutoFetch capability を provider 配布値から導出する", () => {
    // F12 展開(19-A 第3実装): inline fetch 型 + setter を撤去し meCapabilities から導出。
    expect(pageSrc).not.toMatch(/setRegistryAutoFetchConfigured/);
    expect(pageSrc).not.toMatch(/registryAutoFetch\?:\s*boolean/);
    expect(pageSrc).toMatch(/meCapabilities\?\.registryAutoFetch === true/);
  });

  it("ActionBar の直後に RegistryAutoFetchButton を 1 箇所だけ描画する", () => {
    expect(pageSrc).toMatch(/<RegistryAutoFetchButton/);
    const actionBarIdx = pageSrc.indexOf("<ActionBar");
    const buttonIdx = pageSrc.indexOf("<RegistryAutoFetchButton");
    expect(actionBarIdx).toBeGreaterThan(-1);
    expect(buttonIdx).toBeGreaterThan(actionBarIdx);
    expect(pageSrc).toMatch(/canAutoFetch=\{canAutoFetchRegistry\}/);
    expect(pageSrc).toMatch(
      /providerConfigured=\{registryAutoFetchConfigured\}/,
    );
    const matches = pageSrc.match(/<RegistryAutoFetchButton/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe("ActionBar — ACTIONS[] に自動取得を載せない (source assertion)", () => {
  it("auto_fetch / 自動取得 / RegistryAutoFetch を含めない", () => {
    expect(actionBarSrc).not.toMatch(/auto_fetch/);
    expect(actionBarSrc).not.toMatch(/自動取得/);
    expect(actionBarSrc).not.toMatch(/RegistryAutoFetch/);
  });
});

describe("/api/me/permissions — registryAutoFetch capability (source assertion)", () => {
  it("capabilities に registryAutoFetch を boolean helper で含める", () => {
    expect(permRouteSrc).toMatch(/isRegistryAutoFetchProviderConfigured/);
    expect(permRouteSrc).toMatch(
      /registryAutoFetch:\s*isRegistryAutoFetchProviderConfigured\(\)/,
    );
  });
});

describe("isRegistryAutoFetchProviderConfigured — provider capability", () => {
  it("現状（provider 未実装 = null）は false を返す（runtime）", () => {
    expect(getRegistryFetchProvider()).toBeNull();
    expect(isRegistryAutoFetchProviderConfigured()).toBe(false);
  });

  it("実装は getRegistryFetchProvider(...) != null（provider あり → true の関係・readiness 委譲）", () => {
    // CodexP2: signature に readiness 注入用の options を許容しつつ、boolean を返し
    // getRegistryFetchProvider(...) の null/非null をそのまま反映する関係を固定する。
    expect(autoFetchSrc).toMatch(
      /export function isRegistryAutoFetchProviderConfigured\([\s\S]*?\)\s*:\s*boolean\s*\{\s*return getRegistryFetchProvider\([^)]*\)\s*!==?\s*null;\s*\}/,
    );
  });

  it("CodexP2: env 設定済みでも browserFactory 未配線なら false（capability false・runtime）", () => {
    const KEYS = ["REGISTRY_FETCH_LOGIN_ID", "REGISTRY_FETCH_PASSWORD"] as const;
    const saved: Record<string, string | undefined> = {};
    for (const k of KEYS) saved[k] = process.env[k];
    try {
      process.env.REGISTRY_FETCH_LOGIN_ID = "id";
      process.env.REGISTRY_FETCH_PASSWORD = "pw";
      // browserFactory を配線していない（PR-1）ため、env 設定済みでも null/false。
      expect(getRegistryFetchProvider()).toBeNull();
      expect(isRegistryAutoFetchProviderConfigured()).toBe(false);
    } finally {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
