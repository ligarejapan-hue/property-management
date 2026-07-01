/**
 * PR-2b-3: 謄本 所在検索「候補を選んで取得」の cond③ 解決コア。
 *
 * resolveRegistryCandidate: 取得時に client の candidateRef を信頼せず、不動産番号は「認可済み検索が
 * server に残したマッピング（candidate-cache）」からのみ解決する（provider 再検索しない／@codex P1）。
 * さらに現在の物件指紋が検索時と一致する場合だけ有効（検索後に物件が編集されたら 409／@codex P1）。
 * 秘匿情報（不動産番号）は error に載せない（cond②）。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

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
vi.mock("@/lib/prisma", () => ({ default: { property: { findUnique: vi.fn() } } }));

import prisma from "@/lib/prisma";
import { resolveRegistryCandidate } from "@/lib/registry-fetch/search";
import {
  rememberSearchCandidates,
  fingerprintProperty,
  __clearCandidateCacheForTests,
} from "@/lib/registry-fetch/candidate-cache";

const SESSION = { id: "user-1", role: "admin" };
const PROP_ID = "33333333-3333-4333-8333-333333333333";
const EXPECTED_REN = "REN-secret-1";

const pm = prisma as unknown as { property: { findUnique: Mock } };

function propertyRow(over: Record<string, unknown> = {}) {
  return {
    id: PROP_ID,
    createdBy: "user-1",
    assignedTo: null,
    address: "東京都秘匿区テスト9-9-9",
    lotNumber: "5番6",
    buildingNumber: "7",
    realEstateNumber: null,
    ...over,
  };
}

function setProperty(over: Record<string, unknown> = {}) {
  pm.property.findUnique.mockResolvedValue(propertyRow(over));
}

/** 現在の物件と同じ指紋で検索候補を覚える（＝検索直後の状態）。 */
function seed(candidateRef = "cand-1", over: Record<string, unknown> = {}) {
  rememberSearchCandidates(SESSION.id, PROP_ID, fingerprintProperty(propertyRow(over)), [
    { candidateRef, realEstateNumber: EXPECTED_REN },
  ]);
}

function resolve(opts: {
  confirmed?: boolean;
  candidateRef?: string;
  session?: { id: string; role: string };
} = {}) {
  return resolveRegistryCandidate({
    session: opts.session ?? SESSION,
    propertyId: PROP_ID,
    confirmed: opts.confirmed ?? true,
    candidateRef: opts.candidateRef ?? "cand-1",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __clearCandidateCacheForTests();
  setProperty();
});

describe("resolveRegistryCandidate（cond③: 認可済み検索の mapping から解決・指紋一致が前提）", () => {
  it("検索直後（指紋一致）は不動産番号を解決して返す", async () => {
    seed();
    await expect(resolve()).resolves.toEqual({ realEstateNumber: EXPECTED_REN });
  });

  it("検索後に物件が編集された（指紋不一致）は 409（@codex P1・別物件の謄本を取らない）", async () => {
    seed(); // 所在=テスト9-9-9 の状態で覚える
    setProperty({ address: "別の所在1-1-1" }); // 取得時点では所在が変わっている
    await expect(resolve()).rejects.toMatchObject({ status: 409, code: "REGISTRY_OBTAIN_CANDIDATE_NOT_FOUND" });
  });

  it("検索後に不動産番号が付いた（指紋不一致）も 409", async () => {
    seed();
    setProperty({ realEstateNumber: "0123-45-678901" });
    await expect(resolve()).rejects.toMatchObject({ status: 409 });
  });

  it("未検索/改ざんの candidateRef は 409", async () => {
    seed();
    await expect(resolve({ candidateRef: "TAMPERED" })).rejects.toMatchObject({ status: 409 });
  });

  it("confirmed:true 以外は 400（物件も引かない）", async () => {
    seed();
    await expect(resolve({ confirmed: false })).rejects.toMatchObject({ status: 400 });
    expect(pm.property.findUnique).not.toHaveBeenCalled();
  });

  it("candidateRef 空は 400", async () => {
    await expect(resolve({ candidateRef: "   " })).rejects.toMatchObject({ status: 400 });
  });

  it("物件が無ければ 404", async () => {
    seed();
    pm.property.findUnique.mockResolvedValue(null);
    await expect(resolve()).rejects.toMatchObject({ status: 404 });
  });

  it("担当外物件（field_staff スコープ外）は 403", async () => {
    seed();
    setProperty({ createdBy: "someone-else", assignedTo: "another" });
    await expect(resolve({ session: { id: "user-1", role: "field_staff" } })).rejects.toMatchObject({ status: 403 });
  });

  it("秘匿情報（不動産番号）を error メッセージに載せない", async () => {
    seed();
    try {
      await resolve({ candidateRef: "TAMPERED" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain(EXPECTED_REN);
    }
  });
});
