/**
 * PR-2b-3: 謄本 所在検索「候補を選んで取得」の cond③ 解決コア。
 *
 * resolveRegistryCandidate: 取得時に client の candidateRef を信頼せず、不動産番号は「認可済み検索が
 * server に残したマッピング（candidate-cache）」からのみ解決する（改ざん対策・provider 再検索しない）。
 * 秘匿情報（不動産番号）は error に載せない（cond②）。scope/物件存在は後続 runRegistryAutoFetch が確認。
 */
import { describe, it, expect, beforeEach } from "vitest";

// api-helpers の実物は next-auth→next/server を引き込むため mock（ApiError の status/code のみ必要）。
import { vi } from "vitest";
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

import { resolveRegistryCandidate } from "@/lib/registry-fetch/search";
import {
  rememberSearchCandidates,
  __clearCandidateCacheForTests,
} from "@/lib/registry-fetch/candidate-cache";

const SESSION = { id: "user-1", role: "admin" };
const PROP_ID = "33333333-3333-4333-8333-333333333333";
const EXPECTED_REN = "REN-secret-1";

beforeEach(() => __clearCandidateCacheForTests());

function seed() {
  rememberSearchCandidates(SESSION.id, PROP_ID, [
    { candidateRef: "cand-1", realEstateNumber: EXPECTED_REN },
  ]);
}

function resolve(opts: {
  confirmed?: boolean;
  candidateRef?: string;
  session?: { id: string; role: string };
  propertyId?: string;
} = {}) {
  return resolveRegistryCandidate({
    session: opts.session ?? SESSION,
    propertyId: opts.propertyId ?? PROP_ID,
    confirmed: opts.confirmed ?? true,
    candidateRef: opts.candidateRef ?? "cand-1",
  });
}

describe("resolveRegistryCandidate（cond③: 認可済み検索の server マッピングから解決・再検索しない）", () => {
  it("検索で覚えた候補は不動産番号を解決して返す", () => {
    seed();
    expect(resolve()).toEqual({ realEstateNumber: EXPECTED_REN });
  });

  it("未検索/改ざんの candidateRef は 409（再検索を促す）", () => {
    seed();
    expect(() => resolve({ candidateRef: "TAMPERED" })).toThrow(
      expect.objectContaining({ status: 409, code: "REGISTRY_OBTAIN_CANDIDATE_NOT_FOUND" }),
    );
  });

  it("confirmed:true 以外は 400（キャッシュも見ない）", () => {
    seed();
    expect(() => resolve({ confirmed: false })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it("candidateRef 空は 400", () => {
    expect(() => resolve({ candidateRef: "   " })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it("別物件では解決しない（409・キーに propertyId を含む）", () => {
    seed();
    expect(() => resolve({ propertyId: "other-prop" })).toThrow(
      expect.objectContaining({ status: 409 }),
    );
  });

  it("別ユーザーでは解決しない（409・キーに userId を含む）", () => {
    seed();
    expect(() => resolve({ session: { id: "other-user", role: "admin" } })).toThrow(
      expect.objectContaining({ status: 409 }),
    );
  });

  it("秘匿情報（不動産番号）を error メッセージに載せない", () => {
    seed();
    try {
      resolve({ candidateRef: "TAMPERED" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain(EXPECTED_REN);
    }
  });
});
