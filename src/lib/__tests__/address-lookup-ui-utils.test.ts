/**
 * PR2 (住所補完 UI core) の純粋ロジックのユニットテスト。
 * UI/hook は node 環境(testing-library 無)では描画できないため、
 * 上書き判定・候補件数判定・ラベル生成・エラー分類・reducer・stale ガードを
 * 純関数として切り出してここで検証する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  createAddressLookupController,
  decideAddressSearchEffect,
  type LookupAction,
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

// ---------------------------------------------------------------
// createAddressLookupController（Codex P2-1 / P2-B）
// ---------------------------------------------------------------

type LookupResult = { candidates: AddressLookupCandidate[] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** fake timers 下で await 済み continuation（run 内の then 連鎖）を流す。 */
async function flushMicrotasks() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

function setupController() {
  const actions: LookupAction[] = [];
  const fetchByPostalCode = vi.fn<(zip: string) => Promise<LookupResult>>();
  const fetchByAddress = vi.fn<(address: string) => Promise<LookupResult>>();
  const controller = createAddressLookupController(
    {
      fetchByPostalCode,
      fetchByAddress,
      onAction: (action) => actions.push(action),
    },
    300,
  );
  const successes = () =>
    actions.filter(
      (a): a is Extract<LookupAction, { type: "success" }> =>
        a.type === "success",
    );
  return { actions, fetchByPostalCode, fetchByAddress, controller, successes };
}

describe("createAddressLookupController (P2-1: スケジュール時の即時invalidate)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("住所再編集（再スケジュール）時点で旧in-flight応答が破棄される＝候補が復活しない (#1)(#2)", async () => {
    const { fetchByAddress, controller, successes } = setupController();
    const first = deferred<LookupResult>();
    fetchByAddress.mockReturnValueOnce(first.promise);

    controller.searchByAddress("東京都A");
    vi.advanceTimersByTime(300); // debounce 発火 → 旧リクエスト in-flight
    expect(fetchByAddress).toHaveBeenCalledTimes(1);

    controller.searchByAddress("東京都AB"); // ★スケジュールのみ（debounce 未発火）
    first.resolve({ candidates: [cand({ addressLine: "旧住所" })] }); // 300ms 窓内に旧応答
    await flushMicrotasks();

    expect(successes()).toHaveLength(0); // 旧住所の候補は表示されない
  });

  it("再スケジュール後の新しい検索は通常どおり成功する", async () => {
    const { fetchByAddress, controller, successes } = setupController();
    const first = deferred<LookupResult>();
    const second = deferred<LookupResult>();
    fetchByAddress
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    controller.searchByAddress("東京都A");
    vi.advanceTimersByTime(300);
    controller.searchByAddress("東京都AB");
    first.resolve({ candidates: [cand({ addressLine: "旧住所" })] });
    await flushMicrotasks();

    vi.advanceTimersByTime(300); // 2本目の debounce 発火
    expect(fetchByAddress).toHaveBeenLastCalledWith("東京都AB");
    second.resolve({ candidates: [cand({ addressLine: "新住所" })] });
    await flushMicrotasks();

    expect(successes()).toHaveLength(1);
    expect(successes()[0].candidates[0].addressLine).toBe("新住所");
  });
});

describe("createAddressLookupController (P2-B: 郵便番号lookupと住所検索の競合)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("保留中（debounce未発火）の住所検索は lookupByPostalCode で cancel される (#6)", async () => {
    const { fetchByPostalCode, fetchByAddress, controller, successes } =
      setupController();
    const postal = deferred<LookupResult>();
    fetchByPostalCode.mockReturnValueOnce(postal.promise);

    controller.searchByAddress("東京都"); // 保留（発火前）
    controller.lookupByPostalCode("1000005");
    postal.resolve({
      candidates: [
        cand({ postalCode: "1000005", addressLine: "東京都千代田区丸の内" }),
      ],
    });
    await flushMicrotasks();
    vi.advanceTimersByTime(1000); // 保留 debounce が残っていればここで発火するはず
    await flushMicrotasks();

    expect(fetchByAddress).not.toHaveBeenCalled(); // ★保留分は発火しない
    expect(successes()).toHaveLength(1);
    expect(successes()[0].candidates[0].postalCode).toBe("1000005");
  });

  it("in-flight の住所検索応答は郵便番号lookupの結果を上書きしない (#7)", async () => {
    const { fetchByPostalCode, fetchByAddress, controller, successes } =
      setupController();
    const addr = deferred<LookupResult>();
    const postal = deferred<LookupResult>();
    fetchByAddress.mockReturnValueOnce(addr.promise);
    fetchByPostalCode.mockReturnValueOnce(postal.promise);

    controller.searchByAddress("東京都");
    vi.advanceTimersByTime(300); // 住所検索 in-flight
    controller.lookupByPostalCode("1000005"); // seq++ → 住所検索応答は stale 化

    postal.resolve({
      candidates: [
        cand({ postalCode: "1000005", addressLine: "東京都千代田区丸の内" }),
      ],
    });
    await flushMicrotasks();
    addr.resolve({ candidates: [cand({ addressLine: "後から来た住所検索" })] });
    await flushMicrotasks();

    expect(successes()).toHaveLength(1); // postal の1件のみ
    expect(successes()[0].candidates[0].postalCode).toBe("1000005");
  });
});

describe("createAddressLookupController (reset / dispose / エラー分類)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reset は reset action＋保留 debounce 取り消し＋in-flight 破棄 (#8)", async () => {
    const { actions, fetchByAddress, controller, successes } =
      setupController();
    const addr = deferred<LookupResult>();
    fetchByAddress.mockReturnValueOnce(addr.promise);

    controller.searchByAddress("東京都");
    vi.advanceTimersByTime(300); // in-flight
    controller.searchByAddress("神奈川県"); // 保留
    controller.reset();

    expect(actions[actions.length - 1]).toEqual({ type: "reset" });
    addr.resolve({ candidates: [cand()] });
    await flushMicrotasks();
    vi.advanceTimersByTime(1000);
    await flushMicrotasks();

    expect(fetchByAddress).toHaveBeenCalledTimes(1); // 保留分は発火しない
    expect(successes()).toHaveLength(0); // in-flight も破棄
  });

  it("dispose は保留 debounce を取り消し、以後 action を発行しない", async () => {
    const { actions, fetchByAddress, controller } = setupController();
    const addr = deferred<LookupResult>();
    fetchByAddress.mockReturnValueOnce(addr.promise);

    controller.searchByAddress("東京都");
    vi.advanceTimersByTime(300); // in-flight（request 発行済み）
    const issued = actions.length;
    controller.searchByAddress("神奈川県"); // 保留
    controller.dispose();

    addr.resolve({ candidates: [cand()] });
    await flushMicrotasks();
    vi.advanceTimersByTime(1000);
    await flushMicrotasks();

    expect(fetchByAddress).toHaveBeenCalledTimes(1);
    expect(actions.length).toBe(issued); // dispose 後は何も積まれない
  });

  it("失敗応答は classifyAddressLookupError で分類して failure action になる", async () => {
    const { actions, fetchByAddress, controller } = setupController();
    fetchByAddress.mockRejectedValueOnce(
      new Error("住所補完APIが設定されていません"),
    );

    controller.searchByAddress("東京都");
    vi.advanceTimersByTime(300);
    await flushMicrotasks();

    expect(actions[actions.length - 1]).toEqual({
      type: "failure",
      error: "not_configured",
    });
  });
});

// ---------------------------------------------------------------
// decideAddressSearchEffect（Codex P2-A）
// ---------------------------------------------------------------

describe("decideAddressSearchEffect (P2-A: disabled 中は検索しない)", () => {
  it("disabled なら住所非空でも search しない＝reset（mount/prop 変更は同一判定）(#3)(#4)", () => {
    expect(decideAddressSearchEffect(true, true, "東京都千代田区")).toBe(
      "reset",
    );
    expect(decideAddressSearchEffect(true, true, "")).toBe("reset");
  });

  it("disabled へ切り替わった時は reset＝保留 debounce を破棄する側に倒す (#5)", () => {
    // reset は controller.reset() に配線され、保留 debounce の cancel を伴う
    //（cancel の実挙動は controller 側テストで実証）。
    expect(decideAddressSearchEffect(true, true, "東京都")).toBe("reset");
  });

  it("showSearch でなければ何もしない", () => {
    expect(decideAddressSearchEffect(false, false, "東京都")).toBe("none");
    expect(decideAddressSearchEffect(false, true, "東京都")).toBe("none");
  });

  it("enabled で空（空白のみ含む）は reset＝古い候補を消す", () => {
    expect(decideAddressSearchEffect(true, false, "")).toBe("reset");
    expect(decideAddressSearchEffect(true, false, "   ")).toBe("reset");
  });

  it("enabled で非空のときだけ search", () => {
    expect(decideAddressSearchEffect(true, false, "東京都")).toBe("search");
  });
});
