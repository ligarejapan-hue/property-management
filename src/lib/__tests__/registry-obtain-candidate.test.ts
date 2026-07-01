/**
 * PR-2b-3: 謄本 所在検索の「候補を選んで取得」の cond③ 再解決コア。
 *
 * resolveRegistryCandidate: 取得時に client から渡された candidateRef を信頼せず、当該物件向けに
 * server 側で再検索し candidateRef 一致候補の realEstateNumber を解決する（改ざん対策／cond③）。
 * 秘匿情報（所在/地番/家屋番号/不動産番号）は error に載せない（cond②）。
 * provider は明示注入。本番は provider null → route 501（cond⑦）。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// api-helpers を mock（実物は next-auth→next/server を引き込むため）。ApiError の status/code のみ必要。
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
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: { property: { findUnique: vi.fn() } },
}));

import prisma from "@/lib/prisma";
import { MockRegistryFetchProvider } from "@/lib/registry-fetch";
import { resolveRegistryCandidate } from "@/lib/registry-fetch/search";

const PROP_ID = "33333333-3333-4333-8333-333333333333";
const SESSION = { id: "user-1", role: "admin" };
const SECRET_ADDR = "東京都秘匿区テスト9-9-9";

const pm = prisma as unknown as { property: { findUnique: Mock } };

function setProperty(over: Record<string, unknown> = {}) {
  pm.property.findUnique.mockResolvedValue({
    id: PROP_ID,
    createdBy: "user-1",
    assignedTo: null,
    address: SECRET_ADDR,
    lotNumber: "5番6",
    buildingNumber: "7",
    realEstateNumber: null,
    ...over,
  });
}

// mock provider の candidateRef / realEstateNumber は ref(=property.id) から決定的。
const MATCHING_REF = `mock-candidate-${PROP_ID}`;
const EXPECTED_REN = `MOCK-${PROP_ID}`;

beforeEach(() => {
  vi.clearAllMocks();
  setProperty();
});

function resolve(opts: { confirmed?: boolean; candidateRef?: string; session?: { id: string; role: string }; provider?: MockRegistryFetchProvider } = {}) {
  return resolveRegistryCandidate(
    {
      session: opts.session ?? SESSION,
      propertyId: PROP_ID,
      confirmed: opts.confirmed ?? true,
      candidateRef: opts.candidateRef ?? MATCHING_REF,
    },
    opts.provider ?? new MockRegistryFetchProvider(),
  );
}

describe("resolveRegistryCandidate（cond③ 候補の server 再解決）", () => {
  it("候補一致で不動産番号を server 側で解決して返す", async () => {
    await expect(resolve()).resolves.toEqual({ realEstateNumber: EXPECTED_REN });
  });

  it("candidateRef が再検索結果に無ければ 409（改ざん/陳腐化 → 再検索を促す）", async () => {
    await expect(resolve({ candidateRef: "mock-candidate-TAMPERED" })).rejects.toMatchObject({
      status: 409,
      code: "REGISTRY_OBTAIN_CANDIDATE_NOT_FOUND",
    });
  });

  it("confirmed:true 以外は 400（DB/provider に到達しない）", async () => {
    await expect(resolve({ confirmed: false })).rejects.toMatchObject({ status: 400 });
    expect(pm.property.findUnique).not.toHaveBeenCalled();
  });

  it("candidateRef 空は 400", async () => {
    await expect(resolve({ candidateRef: "   " })).rejects.toMatchObject({ status: 400 });
  });

  it("物件が無ければ 404", async () => {
    pm.property.findUnique.mockResolvedValue(null);
    await expect(resolve()).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("担当外物件（field_staff スコープ外）は 403", async () => {
    setProperty({ createdBy: "someone-else", assignedTo: "another" });
    await expect(resolve({ session: { id: "user-1", role: "field_staff" } })).rejects.toMatchObject({ status: 403 });
  });

  it("不動産番号を既に持つ物件は所在検索取得できない → 409 NOT_SEARCHABLE", async () => {
    setProperty({ realEstateNumber: "0123-45-678901" });
    await expect(resolve()).rejects.toMatchObject({ status: 409, code: "REGISTRY_OBTAIN_NOT_SEARCHABLE" });
  });

  it("所在が不足していれば 409 NOT_SEARCHABLE（provider に到達しない）", async () => {
    setProperty({ address: null });
    await expect(resolve()).rejects.toMatchObject({ status: 409, code: "REGISTRY_OBTAIN_NOT_SEARCHABLE" });
  });

  it("provider が所在検索非対応なら 501（cond⑦ fail-closed）", async () => {
    const p = new MockRegistryFetchProvider();
    (p as unknown as { supportsLocationSearch: boolean }).supportsLocationSearch = false;
    await expect(resolve({ provider: p })).rejects.toMatchObject({ status: 501 });
  });

  it("provider 検索失敗は安全な分類コードで 502（秘匿情報を載せない）", async () => {
    const p = new MockRegistryFetchProvider({ searchFailWith: "provider_error" });
    await expect(resolve({ provider: p })).rejects.toMatchObject({ status: 502, code: "REGISTRY_SEARCH_PROVIDER_ERROR" });
  });

  it("秘匿情報（所在・不動産番号）を error メッセージに載せない", async () => {
    try {
      await resolve({ candidateRef: "mock-candidate-TAMPERED" });
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain(SECRET_ADDR);
      expect(msg).not.toContain(EXPECTED_REN);
    }
  });
});
