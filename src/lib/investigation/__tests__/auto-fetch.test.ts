import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ default: {} }));
vi.mock("../fetch-investigation", () => ({ runAndUpsertInvestigation: vi.fn() }));

import {
  autoFetchWhere,
  isProviderOutage,
  nextDelayMs,
  runAutoFetchOnce,
  shouldStartAutoFetch,
  AUTO_FETCH_NOTE,
  type AutoFetchTarget,
} from "../auto-fetch";

const target: AutoFetchTarget = {
  id: "p1",
  address: "東京都千代田区霞が関1-1",
  lotNumber: null,
  gpsLat: null,
  gpsLng: null,
  createdBy: "u1",
};

const reinfolibOk = {
  providers: [
    { name: "property-db", status: "success" },
    { name: "reinfolib", status: "success", meta: { emptyEndpoints: [] } },
  ],
};

describe("shouldStartAutoFetch", () => {
  it("本番で不動産情報ライブラリの鍵があるときだけ動く", () => {
    expect(shouldStartAutoFetch({ NODE_ENV: "production", REINFOLIB_API_KEY: "k" })).toBe(true);
  });
  it("鍵が無ければ動かない(物件DBの写しだけで『要確認』を量産しない)", () => {
    expect(shouldStartAutoFetch({ NODE_ENV: "production" })).toBe(false);
    expect(shouldStartAutoFetch({ NODE_ENV: "production", REINFOLIB_API_KEY: "" })).toBe(false);
  });
  it("本番以外(開発・テスト)では動かない", () => {
    expect(shouldStartAutoFetch({ NODE_ENV: "development", REINFOLIB_API_KEY: "k" })).toBe(false);
    expect(shouldStartAutoFetch({ NODE_ENV: "test", REINFOLIB_API_KEY: "k" })).toBe(false);
  });
  it("build の最中は動かない", () => {
    expect(
      shouldStartAutoFetch({
        NODE_ENV: "production",
        REINFOLIB_API_KEY: "k",
        NEXT_PHASE: "phase-production-build",
      }),
    ).toBe(false);
  });
  it("INVESTIGATION_AUTO_FETCH=off で止められる", () => {
    expect(
      shouldStartAutoFetch({ NODE_ENV: "production", REINFOLIB_API_KEY: "k", INVESTIGATION_AUTO_FETCH: "off" }),
    ).toBe(false);
  });
});

describe("autoFetchWhere", () => {
  const cutoff = new Date("2026-11-14T00:00:00Z");
  const where = autoFetchWhere(cutoff);

  it("保管した物件は対象外", () => {
    expect(where.isArchived).toBe(false);
  });
  it("一度も取っていない物件(調査情報の行が無い)と、取得中のまま止まった物件だけ", () => {
    expect(where.AND).toContainEqual({
      OR: [
        { investigation: { is: null } },
        { investigation: { is: { status: "fetching", fetchedAt: null, updatedAt: { lt: cutoff } } } },
      ],
    });
  });
  it("住所も座標も無い物件は送らない", () => {
    expect(where.AND).toContainEqual({
      OR: [{ address: { not: "" } }, { gpsLat: { not: null }, gpsLng: { not: null } }],
    });
  });
});

describe("isProviderOutage", () => {
  it("普通に取れたときは止まらない", () => {
    expect(isProviderOutage(reinfolibOk)).toBe(false);
  });
  it("7つの問い合わせが全部失敗したら相手の障害とみなす", () => {
    const errs = Array.from({ length: 7 }, (_, i) => `HTTP 503 (${i})`);
    expect(
      isProviderOutage({
        providers: [{ name: "reinfolib", status: "success", meta: { tileErrors: errs } }],
      }),
    ).toBe(true);
  });
  it("一部だけの失敗は障害とみなさない", () => {
    expect(
      isProviderOutage({
        providers: [{ name: "reinfolib", status: "success", meta: { tileErrors: ["HTTP 503"] } }],
      }),
    ).toBe(false);
  });
  it("住所から位置が出せなかっただけ(その物件の問題)は障害とみなさない", () => {
    expect(
      isProviderOutage({
        providers: [
          { name: "reinfolib", status: "failed", error: '住所のジオコーディングに失敗しました: "x"' },
        ],
      }),
    ).toBe(false);
  });
  it("それ以外の理由で不動産情報ライブラリ自体が失敗したら障害とみなす", () => {
    expect(
      isProviderOutage({ providers: [{ name: "reinfolib", status: "failed", error: "fetch failed" }] }),
    ).toBe(true);
  });
  it("形の崩れた値でも落ちない", () => {
    expect(isProviderOutage(null)).toBe(false);
    expect(isProviderOutage({})).toBe(false);
    expect(isProviderOutage({ providers: "x" })).toBe(false);
  });
});

describe("nextDelayMs", () => {
  it("取れたら少し間をあけて次へ・対象が無ければ1分おき・障害なら30分休む", () => {
    expect(nextDelayMs("done")).toBe(3_000);
    expect(nextDelayMs("idle")).toBe(60_000);
    expect(nextDelayMs("outage")).toBe(30 * 60_000);
    expect(nextDelayMs("error")).toBe(60_000);
  });
});

describe("runAutoFetchOnce", () => {
  it("対象が無ければ何も送らない", async () => {
    const run = vi.fn();
    const out = await runAutoFetchOnce({ pick: async () => null, run, now: () => new Date() });
    expect(out).toBe("idle");
    expect(run).not.toHaveBeenCalled();
  });

  it("物件を作った人の名前で、自動取得の印を付けて取る", async () => {
    const run = vi.fn(async () => ({ rawPayloadJson: reinfolibOk }));
    const out = await runAutoFetchOnce({ pick: async () => target, run, now: () => new Date() });
    expect(out).toBe("done");
    expect(run).toHaveBeenCalledWith(
      "p1",
      "u1",
      { address: target.address, lotNumber: null, gpsLat: null, gpsLng: null },
      undefined,
      { auditNote: AUTO_FETCH_NOTE },
    );
  });

  it("座標がある物件は座標も渡す", async () => {
    const run = vi.fn(async () => ({ rawPayloadJson: reinfolibOk }));
    await runAutoFetchOnce({
      pick: async () => ({ ...target, gpsLat: 35.6, gpsLng: 139.7 }),
      run,
      now: () => new Date(),
    });
    expect((run.mock.calls[0] as unknown[])[2]).toMatchObject({ gpsLat: 35.6, gpsLng: 139.7 });
  });

  it("相手が落ちていたら outage を返す", async () => {
    const run = vi.fn(async () => ({
      rawPayloadJson: { providers: [{ name: "reinfolib", status: "failed", error: "fetch failed" }] },
    }));
    expect(await runAutoFetchOnce({ pick: async () => target, run, now: () => new Date() })).toBe("outage");
  });

  it("取得で例外が出ても止まらず error を返す", async () => {
    const run = vi.fn(async () => {
      throw new Error("boom");
    });
    expect(await runAutoFetchOnce({ pick: async () => target, run, now: () => new Date() })).toBe("error");
  });

  it("取得中のまま止まった物件を拾うため、15分前を区切りとして渡す", async () => {
    const pick = vi.fn(async () => null);
    await runAutoFetchOnce({ pick, run: vi.fn(), now: () => new Date("2026-11-14T01:00:00Z") });
    expect(pick).toHaveBeenCalledWith(new Date("2026-11-14T00:45:00Z"));
  });
});
