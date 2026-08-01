/**
 * PR-2b-3 (@codex P1): 所在検索の候補→不動産番号を「認可済みユーザーの検索」から取得側へ橋渡しする
 * 短命 in-memory マップ。取得時に provider を再検索しない（throttle の二重消費を避ける）。
 * さらに検索時の物件指紋を保持し、取得時に物件が編集されていたら（指紋不一致）古い候補を無効化する。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  rememberSearchCandidates,
  resolveCachedCandidate,
  fingerprintProperty,
  __clearCandidateCacheForTests,
  __candidateCacheSizeForTests,
} from "../candidate-cache";

const USER = "user-1";
const PROP = "prop-1";
const FP = "fp-1"; // 指紋は文字列一致のみ見るので任意の固定値でよい。

beforeEach(() => __clearCandidateCacheForTests());

describe("candidate-cache", () => {
  it("検索で覚えた候補の不動産番号を（指紋一致で）取得時に解決できる", () => {
    rememberSearchCandidates(USER, PROP, FP, [
      { candidateRef: "c1", realEstateNumber: "REN-1" },
      { candidateRef: "c2", realEstateNumber: "REN-2" },
    ]);
    expect(resolveCachedCandidate(USER, PROP, "c1", FP)).toEqual({ kind: "number", realEstateNumber: "REN-1" });
    expect(resolveCachedCandidate(USER, PROP, "c2", FP)).toEqual({ kind: "number", realEstateNumber: "REN-2" });
  });

  it("未知の candidateRef は null（改ざん/未検索 → route 側で 409）", () => {
    rememberSearchCandidates(USER, PROP, FP, [{ candidateRef: "c1", realEstateNumber: "REN-1" }]);
    expect(resolveCachedCandidate(USER, PROP, "TAMPERED", FP)).toBeNull();
  });

  it("指紋不一致（検索後に物件編集）は null（@codex P1）", () => {
    rememberSearchCandidates(USER, PROP, FP, [{ candidateRef: "c1", realEstateNumber: "REN-1" }]);
    expect(resolveCachedCandidate(USER, PROP, "c1", "fp-CHANGED")).toBeNull();
  });

  it("別ユーザー/別物件のキャッシュは解決しない（キーに user+property を含む）", () => {
    rememberSearchCandidates(USER, PROP, FP, [{ candidateRef: "c1", realEstateNumber: "REN-1" }]);
    expect(resolveCachedCandidate("other-user", PROP, "c1", FP)).toBeNull();
    expect(resolveCachedCandidate(USER, "other-prop", "c1", FP)).toBeNull();
  });

  it("番号も地番も無い候補は覚えない（取得キーにできない）", () => {
    rememberSearchCandidates(USER, PROP, FP, [
      { candidateRef: "c1", realEstateNumber: null },
      { candidateRef: "c2" },
    ]);
    expect(resolveCachedCandidate(USER, PROP, "c1", FP)).toBeNull();
    expect(resolveCachedCandidate(USER, PROP, "c2", FP)).toBeNull();
  });

  it("段階②: 地番のみの候補は location として覚える（有料取得の取得キー）", () => {
    rememberSearchCandidates(USER, PROP, FP, [
      { candidateRef: "１－１", lotNumber: "１－１" },
      { candidateRef: "家1", buildingNumber: "1-1-1" },
    ]);
    expect(resolveCachedCandidate(USER, PROP, "１－１", FP)).toEqual({
      kind: "location",
      lotNumber: "１－１",
      buildingNumber: null,
    });
    expect(resolveCachedCandidate(USER, PROP, "家1", FP)).toEqual({
      kind: "location",
      lotNumber: null,
      buildingNumber: "1-1-1",
    });
  });

  it("段階②: 不動産番号がある候補は地番があっても number を優先（番号取得の方が確実）", () => {
    rememberSearchCandidates(USER, PROP, FP, [
      { candidateRef: "c1", realEstateNumber: "REN-1", lotNumber: "1-1" },
    ]);
    expect(resolveCachedCandidate(USER, PROP, "c1", FP)).toEqual({
      kind: "number",
      realEstateNumber: "REN-1",
    });
  });

  it("TTL 経過後は解決しない（now を注入して検証）", () => {
    const t0 = 1_000_000;
    rememberSearchCandidates(USER, PROP, FP, [{ candidateRef: "c1", realEstateNumber: "REN-1" }], t0);
    expect(resolveCachedCandidate(USER, PROP, "c1", FP, t0 + 60_000)).toEqual({ kind: "number", realEstateNumber: "REN-1" }); // TTL 内
    expect(resolveCachedCandidate(USER, PROP, "c1", FP, t0 + 60 * 60_000)).toBeNull(); // TTL 超過
  });

  it("同一ユーザー×同一物件の再検索は旧候補を置き換える（@codex P2: 前回の candidateRef を無効化）", () => {
    rememberSearchCandidates(USER, PROP, FP, [{ candidateRef: "old", realEstateNumber: "REN-old" }]);
    rememberSearchCandidates(USER, PROP, FP, [{ candidateRef: "new", realEstateNumber: "REN-new" }]);
    expect(resolveCachedCandidate(USER, PROP, "old", FP)).toBeNull(); // 前回候補は消える
    expect(resolveCachedCandidate(USER, PROP, "new", FP)).toEqual({ kind: "number", realEstateNumber: "REN-new" });
  });

  it("追加時に期限切れエントリを掃除する（@codex P2: Map の際限ない増大を防ぐ）", () => {
    const t0 = 1_000_000;
    rememberSearchCandidates(USER, "prop-A", FP, [{ candidateRef: "a", realEstateNumber: "REN-A" }], t0);
    expect(__candidateCacheSizeForTests()).toBe(1);
    // TTL 超過後に別物件を検索 → 期限切れの prop-A エントリは掃除され、prop-B のみ残る。
    rememberSearchCandidates(USER, "prop-B", FP, [{ candidateRef: "b", realEstateNumber: "REN-B" }], t0 + 11 * 60_000);
    expect(__candidateCacheSizeForTests()).toBe(1);
    expect(resolveCachedCandidate(USER, "prop-B", "b", FP, t0 + 11 * 60_000)).toEqual({ kind: "number", realEstateNumber: "REN-B" });
  });
});

describe("fingerprintProperty", () => {
  it("検索キー項目（所在/地番/家屋番号/不動産番号）が同じなら一致・変われば不一致", () => {
    const base = { address: "所在A", lotNumber: "5番6", buildingNumber: "7", realEstateNumber: null };
    expect(fingerprintProperty(base)).toBe(fingerprintProperty({ ...base }));
    // 前後空白は正規化して同一扱い。
    expect(fingerprintProperty({ ...base, address: " 所在A " })).toBe(fingerprintProperty(base));
    // 不動産番号が付いた／所在が変わった → 別指紋。
    expect(fingerprintProperty({ ...base, realEstateNumber: "0123" })).not.toBe(fingerprintProperty(base));
    expect(fingerprintProperty({ ...base, address: "所在B" })).not.toBe(fingerprintProperty(base));
  });
});
