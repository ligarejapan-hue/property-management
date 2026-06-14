/**
 * PR-1: getRegistryFetchProvider() の解決ロジック（外部接続なし）。
 *
 * 最重要の不変条件: **REGISTRY_FETCH_* 未設定 → null → route 501 維持 = 本番挙動不変。**
 *
 * CodexP2: provider 解決を「env が揃えば返す」ではなく **readiness（実際に実行可能か =
 * browserFactory の有無）** に基づかせる。PR-1 では browserFactory を配線しないため、
 * env を設定しても getRegistryFetchProvider() は null・isRegistryAutoFetchProviderConfigured()
 * は false（= capability false・有料ボタン無効・POST 501 維持・registryStatus を一切動かさない）。
 * これにより「env 設定済みなのに browserFactory 未配線」のとき、capability=true で有料ボタンが
 * 有効化され POST が 501 ガードをバイパスして物件を一瞬 scheduled にした後 provider_error で
 * 必ず失敗する、という「本番に常に失敗する操作」の露出を防ぐ。
 *
 * 将来（PR-2）browserFactory を配線すれば、env が揃った時点で capability=true になる解決経路を
 * テストでも表現する（factory を注入した場合のみ非null）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// auto-fetch.ts は @/lib/prisma / @/lib/api-helpers（→ next-auth → next/server）を
// transitively に import するため、DB 接続・next/server 解決を避けて mock する
// （getRegistryFetchProvider 自体はこれらに触れない）。vi.mock は vitest が先頭へ巻き上げる。
vi.mock("@/lib/prisma", () => ({ default: {} }));
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return { ApiError: MockApiError };
});

import {
  getRegistryFetchProvider,
  isRegistryAutoFetchProviderConfigured,
  __resetRegistryFetchThrottleForTest,
} from "../auto-fetch";
import { OfficialRegistryProvider } from "../official-provider";

const ENV_KEYS = [
  "REGISTRY_FETCH_LOGIN_ID",
  "REGISTRY_FETCH_PASSWORD",
  "REGISTRY_FETCH_BASE_URL",
  "REGISTRY_FETCH_TIMEOUT_MS",
  "REGISTRY_FETCH_PROVIDER",
  "REGISTRY_FETCH_MIN_INTERVAL_MS",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  // 共有 throttle シングルトンの状態がテスト間で漏れないようリセットする。
  __resetRegistryFetchThrottleForTest();
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("getRegistryFetchProvider（PR-1 解決ロジック・readiness ベース）", () => {
  it("REGISTRY_FETCH_* 未設定なら null（= route 501 維持 = 本番挙動不変）", () => {
    expect(getRegistryFetchProvider()).toBeNull();
    expect(isRegistryAutoFetchProviderConfigured()).toBe(false);
  });

  it("LOGIN_ID のみでは null（PASSWORD も必須）", () => {
    process.env.REGISTRY_FETCH_LOGIN_ID = "id";
    expect(getRegistryFetchProvider()).toBeNull();
    expect(isRegistryAutoFetchProviderConfigured()).toBe(false);
  });

  it("PASSWORD のみでは null（LOGIN_ID も必須）", () => {
    process.env.REGISTRY_FETCH_PASSWORD = "pw";
    expect(getRegistryFetchProvider()).toBeNull();
    expect(isRegistryAutoFetchProviderConfigured()).toBe(false);
  });

  it("CodexP2: 資格情報のみ（opt-in env なし）では null（capability false・501維持・本番挙動不変）", () => {
    // PR-2: 既定 factory は明示 opt-in（REGISTRY_FETCH_PROVIDER=official）でのみ配線される。
    // 資格情報だけ設定して chromium 未配置のまま capability=true で常に失敗する操作を露出しない
    // ため、opt-in env が無ければ readiness=false → null（現本番は当 env 未設定ゆえ 501 維持）。
    process.env.REGISTRY_FETCH_LOGIN_ID = "id";
    process.env.REGISTRY_FETCH_PASSWORD = "pw";
    expect(getRegistryFetchProvider()).toBeNull();
    expect(isRegistryAutoFetchProviderConfigured()).toBe(false);
  });

  it("PR-2 live: 資格情報 + opt-in env（REGISTRY_FETCH_PROVIDER=official）で OfficialRegistryProvider を返す（capability true）", () => {
    // 運用 runbook で playwright/chromium を配置後に REGISTRY_FETCH_PROVIDER=official を設定すると、
    // 既定 factory が配線され（実 chromium 起動は fetch 実行時の動的 import まで遅延）、provider が
    // 解決される。ここでは provider 解決のみを検証し、実ブラウザは起動しない（factory 未呼び出し）。
    process.env.REGISTRY_FETCH_LOGIN_ID = "id";
    process.env.REGISTRY_FETCH_PASSWORD = "pw";
    process.env.REGISTRY_FETCH_PROVIDER = "official";
    const provider = getRegistryFetchProvider();
    expect(provider).toBeInstanceOf(OfficialRegistryProvider);
    expect(provider?.name).toBe("official");
    expect(isRegistryAutoFetchProviderConfigured()).toBe(true);
  });

  it("PR-2 live: opt-in env のみ（資格情報欠落）では null（資格情報も必須）", () => {
    process.env.REGISTRY_FETCH_PROVIDER = "official";
    expect(getRegistryFetchProvider()).toBeNull();
    expect(isRegistryAutoFetchProviderConfigured()).toBe(false);
  });

  it("（将来）browserFactory が注入され env も揃えば OfficialRegistryProvider を返す（capability true）", () => {
    // PR-2 で browserFactory を配線したら capability=true になる解決経路を表現する。
    // テストでは実ブラウザを起動しない fake factory を注入し、readiness を満たす。
    process.env.REGISTRY_FETCH_LOGIN_ID = "id";
    process.env.REGISTRY_FETCH_PASSWORD = "pw";
    const browserFactory = async () => ({
      async login() {
        /* no-op */
      },
      async searchByRealEstateNumber() {
        return { found: true };
      },
      async downloadRegistryPdf() {
        return Buffer.from("%PDF");
      },
      async close() {
        /* no-op */
      },
    });
    const provider = getRegistryFetchProvider({ browserFactory });
    expect(provider).toBeInstanceOf(OfficialRegistryProvider);
    expect(provider?.name).toBe("official");
    expect(isRegistryAutoFetchProviderConfigured({ browserFactory })).toBe(true);
  });

  // CodexP2: 本番 provider 生成時に throttle（REGISTRY_FETCH_MIN_INTERVAL_MS）を配線する。
  // 配線が無いと live route で getRegistryFetchProvider() が throttle 無し provider を作り、
  // 同時 POST がレート制御をすり抜けて公式へ複数同時アクセスしてしまう。
  it("CodexP2: live 解決した provider は throttle を持つ（連続 fetch の 2 回目が rate_limited）", async () => {
    process.env.REGISTRY_FETCH_LOGIN_ID = "id";
    process.env.REGISTRY_FETCH_PASSWORD = "pw";
    process.env.REGISTRY_FETCH_PROVIDER = "official";
    process.env.REGISTRY_FETCH_MIN_INTERVAL_MS = "60000";

    // 実ブラウザを起動しない fake factory を注入（解決経路は本番と同じ getRegistryFetchProvider）。
    const browserFactory = async () => ({
      async login() {
        /* no-op */
      },
      async searchByRealEstateNumber() {
        return { found: true };
      },
      async downloadRegistryPdf() {
        return Buffer.from("%PDF-1.4 dl");
      },
      async close() {
        /* no-op */
      },
    });
    const provider = getRegistryFetchProvider({ browserFactory });
    expect(provider).not.toBeNull();
    // 1 回目は許可。
    await provider!.fetchRegistryPdf({
      realEstateNumber: "1234567890123",
      ref: "p1",
    });
    // 同一プロセス内・最小間隔未満の 2 回目は throttle で rate_limited。
    await expect(
      provider!.fetchRegistryPdf({
        realEstateNumber: "1234567890123",
        ref: "p2",
      }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("CodexP2: throttle は別 provider インスタンス間で共有される（同時 POST 直列化）", async () => {
    process.env.REGISTRY_FETCH_LOGIN_ID = "id";
    process.env.REGISTRY_FETCH_PASSWORD = "pw";
    process.env.REGISTRY_FETCH_PROVIDER = "official";
    process.env.REGISTRY_FETCH_MIN_INTERVAL_MS = "60000";

    const browserFactory = async () => ({
      async login() {
        /* no-op */
      },
      async searchByRealEstateNumber() {
        return { found: true };
      },
      async downloadRegistryPdf() {
        return Buffer.from("%PDF-1.4 dl");
      },
      async close() {
        /* no-op */
      },
    });
    // route が別リクエストで getRegistryFetchProvider() を 2 回呼ぶケースを模す。
    const p1 = getRegistryFetchProvider({ browserFactory });
    const p2 = getRegistryFetchProvider({ browserFactory });
    await p1!.fetchRegistryPdf({ realEstateNumber: "1", ref: "p1" });
    // 別インスタンスでも共有 throttle が効き 2 回目は rate_limited。
    await expect(
      p2!.fetchRegistryPdf({ realEstateNumber: "1", ref: "p2" }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("（将来）browserFactory を注入しても env 未設定なら null（資格情報も必須・両方揃って初めて解決）", () => {
    const browserFactory = async () => ({
      async login() {
        /* no-op */
      },
      async searchByRealEstateNumber() {
        return { found: true };
      },
      async downloadRegistryPdf() {
        return Buffer.from("%PDF");
      },
      async close() {
        /* no-op */
      },
    });
    expect(getRegistryFetchProvider({ browserFactory })).toBeNull();
    expect(isRegistryAutoFetchProviderConfigured({ browserFactory })).toBe(
      false,
    );
  });
});
