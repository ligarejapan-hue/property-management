import { describe, it, expect } from "vitest";
import { MockRegistryFetchProvider } from "../mock-provider";
import {
  OfficialRegistryProvider,
  type RegistryBrowserPage,
} from "../official-provider";
import { createRegistryFetchThrottle } from "../throttle";
import { RegistryFetchError } from "../errors";
import type { RegistryCandidate, RegistrySearchRequest } from "../types";

const REQ: RegistrySearchRequest = {
  address: "東京都〇〇区",
  lotNumber: "1番",
  buildingNumber: "2番",
  ref: "p1",
};

describe("MockRegistryFetchProvider.searchCandidates", () => {
  it("request から決定的に候補を返す（同一入力 → 同一候補）", async () => {
    const p = new MockRegistryFetchProvider();
    const a = await p.searchCandidates(REQ);
    const b = await p.searchCandidates(REQ);
    expect(a).toEqual(b);
    expect(a).toHaveLength(1);
    expect(a[0].candidateRef).toBe("mock-candidate-p1");
    expect(a[0].address).toBe("東京都〇〇区");
    expect(a[0].realEstateNumber).toBe("MOCK-p1");
  });

  it("注入した候補をそのまま返す", async () => {
    const candidates: RegistryCandidate[] = [
      { candidateRef: "c1" },
      { candidateRef: "c2" },
    ];
    const p = new MockRegistryFetchProvider({ candidates });
    expect(await p.searchCandidates(REQ)).toBe(candidates);
  });

  it("searchFailWith で分類エラー（RegistryFetchError）を投げる", async () => {
    const p = new MockRegistryFetchProvider({ searchFailWith: "rate_limited" });
    await expect(p.searchCandidates(REQ)).rejects.toBeInstanceOf(RegistryFetchError);
  });
});

/** searchByLocation を任意で持てる fake page（呼び出し順を calls に記録）。 */
function makePage(
  searchByLocation?: () => Promise<RegistryCandidate[]>,
): RegistryBrowserPage & { calls: string[] } {
  const calls: string[] = [];
  const page: RegistryBrowserPage & { calls: string[] } = {
    calls,
    async login() {
      calls.push("login");
    },
    async searchByRealEstateNumber() {
      calls.push("searchNum");
      return { found: true };
    },
    async downloadRegistryPdf() {
      calls.push("download");
      return Buffer.from("%PDF-1.4");
    },
    async close() {
      calls.push("close");
    },
  };
  if (searchByLocation) {
    page.searchByLocation = async () => {
      calls.push("searchLoc");
      return searchByLocation();
    };
  }
  return page;
}

function makeOfficial(
  page: RegistryBrowserPage | null,
  extra: {
    throttle?: ReturnType<typeof createRegistryFetchThrottle>;
    now?: () => Date;
  } = {},
): OfficialRegistryProvider {
  return new OfficialRegistryProvider({
    loginId: "id",
    password: "pw",
    browserFactory: page ? async () => page : undefined,
    throttle: extra.throttle,
    now: extra.now,
  });
}

describe("OfficialRegistryProvider.searchCandidates (PR-2b seam)", () => {
  it("login → searchByLocation → close の順で候補を返す", async () => {
    const candidates: RegistryCandidate[] = [
      { candidateRef: "x1", realEstateNumber: "RE1" },
    ];
    const page = makePage(async () => candidates);
    const out = await makeOfficial(page).searchCandidates(REQ);
    expect(out).toBe(candidates);
    expect(page.calls).toEqual(["login", "searchLoc", "close"]);
  });

  it("実 adapter が searchByLocation 未実装なら provider_error・close する（seam・本番は501）", async () => {
    const page = makePage(); // searchByLocation 無し
    await expect(
      makeOfficial(page).searchCandidates(REQ),
    ).rejects.toMatchObject({ code: "provider_error" });
    expect(page.calls).toContain("close");
  });

  it("browserFactory 未設定なら provider_error（外部接続しない）", async () => {
    await expect(
      makeOfficial(null).searchCandidates(REQ),
    ).rejects.toMatchObject({ code: "provider_error" });
  });

  it("throttle 拒否で rate_limited（公式アクセス前に止める）", async () => {
    const now = () => new Date("2026-06-24T00:00:00Z");
    const throttle = createRegistryFetchThrottle({ minIntervalMs: 60000, burst: 1 });
    const provider = makeOfficial(makePage(async () => []), { throttle, now });
    // 1回目はトークン消費で成功、2回目は同時刻ゆえ rate_limited。
    await provider.searchCandidates(REQ);
    await expect(provider.searchCandidates(REQ)).rejects.toMatchObject({
      code: "rate_limited",
    });
  });

  it("既存の番号取得（fetchRegistryPdf / searchByRealEstateNumber）は壊れていない", async () => {
    const page = makePage(async () => []);
    const res = await makeOfficial(page).fetchRegistryPdf({
      realEstateNumber: "0413234567890",
      ref: "p1",
    });
    expect(res.source).toBe("official");
    // 番号取得は searchByRealEstateNumber → download の既存経路（searchLoc は通らない）。
    expect(page.calls).toEqual(["login", "searchNum", "download", "close"]);
  });
});
