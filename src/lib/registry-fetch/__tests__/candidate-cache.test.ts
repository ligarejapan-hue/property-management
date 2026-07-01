/**
 * PR-2b-3 (@codex P1): 所在検索の候補→不動産番号を「認可済みユーザーの検索」から取得側へ橋渡しする
 * 短命 in-memory マップ。取得時に provider を再検索しない（throttle の二重消費を避ける）。
 * cond③: 取得キー（不動産番号）の出所は server 自身の検索結果のみ。client は candidateRef のみ。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  rememberSearchCandidates,
  resolveCachedCandidate,
  __clearCandidateCacheForTests,
} from "../candidate-cache";

const USER = "user-1";
const PROP = "prop-1";

beforeEach(() => __clearCandidateCacheForTests());

describe("candidate-cache", () => {
  it("検索で覚えた候補の不動産番号を取得時に解決できる", () => {
    rememberSearchCandidates(USER, PROP, [
      { candidateRef: "c1", realEstateNumber: "REN-1" },
      { candidateRef: "c2", realEstateNumber: "REN-2" },
    ]);
    expect(resolveCachedCandidate(USER, PROP, "c1")).toBe("REN-1");
    expect(resolveCachedCandidate(USER, PROP, "c2")).toBe("REN-2");
  });

  it("未知の candidateRef は null（改ざん/未検索 → route 側で 409）", () => {
    rememberSearchCandidates(USER, PROP, [{ candidateRef: "c1", realEstateNumber: "REN-1" }]);
    expect(resolveCachedCandidate(USER, PROP, "TAMPERED")).toBeNull();
  });

  it("別ユーザー/別物件のキャッシュは解決しない（キーに user+property を含む）", () => {
    rememberSearchCandidates(USER, PROP, [{ candidateRef: "c1", realEstateNumber: "REN-1" }]);
    expect(resolveCachedCandidate("other-user", PROP, "c1")).toBeNull();
    expect(resolveCachedCandidate(USER, "other-prop", "c1")).toBeNull();
  });

  it("不動産番号の無い候補は覚えない（取得キーにできない）", () => {
    rememberSearchCandidates(USER, PROP, [
      { candidateRef: "c1", realEstateNumber: null },
      { candidateRef: "c2" },
    ]);
    expect(resolveCachedCandidate(USER, PROP, "c1")).toBeNull();
    expect(resolveCachedCandidate(USER, PROP, "c2")).toBeNull();
  });

  it("TTL 経過後は解決しない（now を注入して検証）", () => {
    const t0 = 1_000_000;
    rememberSearchCandidates(USER, PROP, [{ candidateRef: "c1", realEstateNumber: "REN-1" }], t0);
    expect(resolveCachedCandidate(USER, PROP, "c1", t0 + 60_000)).toBe("REN-1"); // TTL 内
    expect(resolveCachedCandidate(USER, PROP, "c1", t0 + 60 * 60_000)).toBeNull(); // TTL 超過
  });
});
