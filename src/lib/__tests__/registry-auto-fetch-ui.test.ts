/**
 * 謄本「自動取得」導線の**撤去**を固定する（2026-08-15・発注者判断）。
 *
 * ⚠**なぜ消したか**（復活させる前に必ず読む）:
 *   このボタンは物件の `realEstateNumber`（不動産番号）で引く経路の入口だった。ところが
 *   ①番号取得は**実サイトへ配線されていない**（`searchByRealEstateNumber` は「確定」が
 *   カートに `未請求` 行を作るため、外部に触れる前に停止する＝@codex #344 P1）、
 *   ②本番の不動産番号は**0件**、③発注者判断（2026-08-12）で**不動産番号は今後も
 *   作らない・入れない運用**。＝**押しても必ず失敗する導線**だったため撤去し、取得の
 *   入口は「所在で謄本を検索」（住所→候補→人が選ぶ）に一本化した。
 *   ⚠**列（realEstateNumber）と番号取得コードは残す**。列は謄本PDF取込が読み取って保存し、
 *   重複判定の最優先キーになっている（[[import-dedupe]]）。番号経路は一括取得・候補解決と
 *   同じ道を共有しており、入口を塞げば実害は無い。
 *
 * house 規約（vitest environment:"node"・jsdom 無し）に合わせ、ページ / route のソースを
 * fs で読む source-assertion で確認する。
 *
 * 確認観点:
 *  - 物件詳細ページに自動取得ボタンが**無い**（import も描画も・復活したら落ちる）
 *  - コンポーネント本体のファイルが**存在しない**
 *  - registry:auto_fetch 権限の導出は残る（所在検索ボタンが使う）
 *  - ActionBar の ACTIONS[] には載せない
 *  - permissions route が registryAutoFetch capability を返す（一括取得が使う）
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
  publicRegistryLoginUrl,
  DEFAULT_REGISTRY_BASE_URL,
  DEFAULT_REGISTRY_LOGIN_PATH,
} from "@/lib/registry-fetch/auto-fetch";

const read = (rel: string) =>
  fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");

const BUTTON_PATH = "src/components/properties/registry-auto-fetch-button.tsx";

/** 画面側(components / dashboard)の実装ソースを [相対パス, 中身] で列挙する（テストは除く）。 */
function clientSources(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (dir: string) => {
    const abs = path.resolve(process.cwd(), dir);
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(rel);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      out.push([rel, fs.readFileSync(path.resolve(process.cwd(), rel), "utf8")]);
    }
  };
  walk("src/components");
  walk("src/app/(dashboard)");
  return out;
}
const pageSrc = read("src/app/(dashboard)/properties/[id]/page.tsx");
const actionBarSrc = read("src/components/properties/action-bar.tsx");
const permRouteSrc = read("src/app/api/me/permissions/route.ts");
const autoFetchSrc = read("src/lib/registry-fetch/auto-fetch.ts");

describe("謄本「自動取得」導線は撤去済み (source assertion)", () => {
  it("コンポーネント本体のファイルが存在しない", () => {
    expect(fs.existsSync(path.resolve(process.cwd(), BUTTON_PATH))).toBe(false);
  });

  it("物件詳細ページが import も描画もしていない", () => {
    expect(pageSrc).not.toMatch(/registry-auto-fetch-button/);
    expect(pageSrc).not.toMatch(/RegistryAutoFetchButton/);
  });

  it("どの画面からも番号取得の入口（candidateRef 無しの auto-fetch POST）を出さない", () => {
    // ⚠所在検索の取得は candidateRef 付きで同じ route を叩く（api-client の
    //   obtainRegistryByCandidate）。ここで禁じるのは「番号だけで叩く」入口。
    const offenders = clientSources()
      .filter(([, src]) => /registry\/auto-fetch/.test(src))
      .filter(([, src]) => !/candidateRef/.test(src))
      .map(([rel]) => rel);
    expect(offenders).toEqual([]);
  });

  it("消えたボタンへ利用者を誘導する文言を残さない", () => {
    // ⚠実例(2026-08-15): 共通部品の文言は #373 で直っていたのに、所在検索ボタンの
    //   reasonText に**同じ案内の古い版が残って**いた（[[fix-all-call-sites-not-one]]）。
    //   撤去した導線の名前で「ご利用ください」と案内する文字列を全面禁止する。
    const offenders = clientSources()
      .filter(([, src]) => /「謄本を自動取得」\s*をご利用ください/.test(src))
      .map(([rel]) => rel);
    expect(offenders).toEqual([]);
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

  it("使わなくなった registryAutoFetch capability の導出をページに残さない", () => {
    // ⚠所在検索は registryLocationSearch / registryPurchase を使う。自動取得ボタンを
    //   撤去した以上、registryAutoFetch をページで導出しても誰も読まない（読まれない
    //   派生値が残ると「まだ使っている」と誤読される）。
    expect(pageSrc).not.toMatch(/registryAutoFetchConfigured/);
    expect(pageSrc).not.toMatch(/meCapabilities\?\.registryAutoFetch/);
  });

  it("ActionBar の直後に描くのは所在検索ボタンだけ（自動取得は無い）", () => {
    const actionBarIdx = pageSrc.indexOf("<ActionBar");
    const searchIdx = pageSrc.indexOf("<RegistryLocationSearchButton");
    expect(actionBarIdx).toBeGreaterThan(-1);
    expect(searchIdx).toBeGreaterThan(actionBarIdx);
    expect(pageSrc).toMatch(/canAutoFetch=\{canAutoFetchRegistry\}/);
    expect(pageSrc).toMatch(
      /providerConfigured=\{registryLocationSearchConfigured\}/,
    );
    const matches = pageSrc.match(/<RegistryLocationSearchButton/g) ?? [];
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
      /registryAutoFetch:\s*isRegistryAutoFetchProviderConfigured\(\{\s*credentials:/,
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

describe("publicRegistryLoginUrl — 画面のログインリンク(A案・@codex #381 R1/R2 P2)", () => {
  const KEYS = [
    "REGISTRY_FETCH_PUBLIC_LOGIN_URL",
    "REGISTRY_FETCH_BASE_URL",
    "REGISTRY_FETCH_LOGIN_PATH",
  ] as const;
  const withEnv = (
    env: Partial<Record<(typeof KEYS)[number], string>>,
    fn: () => void,
  ) => {
    const saved: Record<string, string | undefined> = {};
    for (const k of KEYS) saved[k] = process.env[k];
    try {
      for (const k of KEYS) {
        if (env[k] === undefined) delete process.env[k];
        else process.env[k] = env[k];
      }
      fn();
    } finally {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };
  const OFFICIAL = `${DEFAULT_REGISTRY_BASE_URL}${DEFAULT_REGISTRY_LOGIN_PATH}`;

  it("env 未設定なら公式の既定値", () => {
    withEnv({}, () => {
      expect(publicRegistryLoginUrl()).toBe(OFFICIAL);
    });
  });

  it("公開専用 env(REGISTRY_FETCH_PUBLIC_LOGIN_URL)には追従する(https のみ)", () => {
    withEnv({ REGISTRY_FETCH_PUBLIC_LOGIN_URL: "https://example.invalid/Login/" }, () => {
      expect(publicRegistryLoginUrl()).toBe("https://example.invalid/Login/");
    });
  });

  it("⚠自動操作用の REGISTRY_FETCH_BASE_URL/LOGIN_PATH は**配らない**(内部を指し得る・R2)", () => {
    withEnv(
      {
        REGISTRY_FETCH_BASE_URL: "https://internal.example.invalid",
        REGISTRY_FETCH_LOGIN_PATH: "/InternalLogin/",
      },
      () => {
        expect(publicRegistryLoginUrl()).toBe(OFFICIAL);
        expect(publicRegistryLoginUrl()).not.toContain("internal");
      },
    );
  });

  it("⚠http・読めない値は既定値へ(資格情報を打つ画面へ平文で誘導しない)", () => {
    withEnv({ REGISTRY_FETCH_PUBLIC_LOGIN_URL: "http://example.invalid/Login/" }, () => {
      expect(publicRegistryLoginUrl()).toBe(OFFICIAL);
    });
    withEnv({ REGISTRY_FETCH_PUBLIC_LOGIN_URL: "not a url" }, () => {
      expect(publicRegistryLoginUrl()).toBe(OFFICIAL);
    });
  });

  it("⚠userinfo 入りURLは既定値へ(埋め込み資格情報を全クライアントへ配らない・R3)", () => {
    withEnv(
      { REGISTRY_FETCH_PUBLIC_LOGIN_URL: "https://user:secret@example.invalid/Login/" },
      () => {
        expect(publicRegistryLoginUrl()).toBe(OFFICIAL);
        expect(publicRegistryLoginUrl()).not.toContain("secret");
      },
    );
    withEnv(
      { REGISTRY_FETCH_PUBLIC_LOGIN_URL: "https://user@example.invalid/Login/" },
      () => {
        expect(publicRegistryLoginUrl()).toBe(OFFICIAL);
      },
    );
  });
});
