/**
 * PR2 (住所補完 UI core) の純粋ロジックのユニットテスト。
 * UI/hook は node 環境(testing-library 無)では描画できないため、
 * 上書き判定・候補件数判定・ラベル生成・エラー分類・reducer・stale ガードを
 * 純関数として切り出してここで検証する。
 */
import { describe, it, expect } from "vitest";
import type { AddressLookupCandidate } from "@/lib/address-lookup/types";
import {
  shouldAutofillAddress,
  needsOverwriteConfirm,
  isSingleCandidate,
  requiresCandidateSelection,
  formatCandidateLabel,
  classifyAddressLookupError,
  addressLookupReducer,
  initialLookupState,
  isLatestRequest,
} from "@/lib/address-lookup-ui-utils";

const cand = (over: Partial<AddressLookupCandidate> = {}): AddressLookupCandidate => ({
  addressLine: "東京都千代田区丸の内",
  source: "mock",
  ...over,
});

describe("shouldAutofillAddress / needsOverwriteConfirm (上書き方針)", () => {
  it("address が空なら自動反映してよい (#3)", () => {
    expect(shouldAutofillAddress("")).toBe(true);
    expect(shouldAutofillAddress("   ")).toBe(true);
    expect(shouldAutofillAddress("\t\n")).toBe(true);
  });

  it("address に既存値があれば自動反映しない＝上書き確認が必要 (#4)", () => {
    expect(shouldAutofillAddress("東京都千代田区")).toBe(false);
    expect(needsOverwriteConfirm("東京都千代田区")).toBe(true);
    expect(needsOverwriteConfirm("")).toBe(false);
    expect(needsOverwriteConfirm("   ")).toBe(false);
  });
});

describe("候補件数の判定", () => {
  it("候補1件なら単一候補として扱う (#1)", () => {
    expect(isSingleCandidate([cand()])).toBe(true);
    expect(isSingleCandidate([])).toBe(false);
    expect(isSingleCandidate([cand(), cand()])).toBe(false);
  });

  it("候補複数なら選択が必要 (#2)", () => {
    expect(requiresCandidateSelection([cand(), cand()])).toBe(true);
    expect(requiresCandidateSelection([cand()])).toBe(false);
    expect(requiresCandidateSelection([])).toBe(false);
  });
});

describe("formatCandidateLabel (表示用候補ラベル)", () => {
  it("郵便番号があれば 〒付き + 住所を返す", () => {
    const label = formatCandidateLabel(
      cand({ postalCode: "1000005", addressLine: "東京都千代田区丸の内" }),
    );
    expect(label).toContain("100-0005");
    expect(label).toContain("東京都千代田区丸の内");
  });

  it("郵便番号が無ければ住所のみ", () => {
    expect(formatCandidateLabel(cand({ addressLine: "東京都港区" }))).toBe(
      "東京都港区",
    );
  });
});

describe("classifyAddressLookupError (route の安定メッセージで分類)", () => {
  it("7桁/住所指定エラー → invalid_input (INVALID_INPUT)", () => {
    expect(
      classifyAddressLookupError(new Error("郵便番号は7桁で指定してください")),
    ).toBe("invalid_input");
    expect(
      classifyAddressLookupError(new Error("住所を指定してください")),
    ).toBe("invalid_input");
  });

  it("未設定 → not_configured (API_KEY_MISSING)", () => {
    expect(
      classifyAddressLookupError(new Error("住所補完APIが設定されていません")),
    ).toBe("not_configured");
  });

  it("応答取得失敗 → provider_error (PROVIDER_UNAVAILABLE/PROVIDER_ERROR)", () => {
    expect(
      classifyAddressLookupError(
        new Error("住所補完APIからの応答取得に失敗しました"),
      ),
    ).toBe("provider_error");
  });

  it("未知メッセージ / 非 Error → unknown", () => {
    expect(classifyAddressLookupError(new Error("???"))).toBe("unknown");
    expect(classifyAddressLookupError("plain string")).toBe("unknown");
    expect(classifyAddressLookupError(null)).toBe("unknown");
  });
});

describe("addressLookupReducer", () => {
  it("request で loading=true・error/candidates クリア", () => {
    const s = addressLookupReducer(
      { loading: false, error: "unknown", candidates: [cand()] },
      { type: "request" },
    );
    expect(s).toEqual({ loading: true, error: null, candidates: [] });
  });

  it("success で candidates 反映・loading=false", () => {
    const cs = [cand(), cand()];
    const s = addressLookupReducer(initialLookupState, {
      type: "success",
      candidates: cs,
    });
    expect(s).toEqual({ loading: false, error: null, candidates: cs });
  });

  it("failure で error 反映・loading=false・candidates 空", () => {
    const s = addressLookupReducer(
      { loading: true, error: null, candidates: [cand()] },
      { type: "failure", error: "provider_error" },
    );
    expect(s).toEqual({
      loading: false,
      error: "provider_error",
      candidates: [],
    });
  });

  it("reset で loading/error/candidates が消える (#7)", () => {
    const s = addressLookupReducer(
      { loading: true, error: "provider_error", candidates: [cand(), cand()] },
      { type: "reset" },
    );
    expect(s).toEqual(initialLookupState);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
    expect(s.candidates).toEqual([]);
  });
});

describe("isLatestRequest (stale response 対策の核)", () => {
  it("seq が最新と一致すれば true・古ければ false (#6)", () => {
    expect(isLatestRequest(3, 3)).toBe(true);
    expect(isLatestRequest(2, 3)).toBe(false);
    expect(isLatestRequest(1, 5)).toBe(false);
  });
});
