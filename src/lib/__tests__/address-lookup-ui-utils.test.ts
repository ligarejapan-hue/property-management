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
  planCandidateApplication,
  evaluateAddressSearchEffect,
  normalizeZipForCompare,
  isPostalResultForZip,
  type AddressSearchEffectState,
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
      {
        loading: false,
        error: "unknown",
        candidates: [cand()],
        attemptedZip: null,
      },
      { type: "request" },
    );
    expect(s).toEqual({
      loading: true,
      error: null,
      candidates: [],
      attemptedZip: null,
    });
  });

  it("success で candidates 反映・loading=false", () => {
    const cs = [cand(), cand()];
    const s = addressLookupReducer(initialLookupState, {
      type: "success",
      candidates: cs,
    });
    expect(s).toEqual({
      loading: false,
      error: null,
      candidates: cs,
      attemptedZip: null,
    });
  });

  it("failure で error 反映・loading=false・candidates 空", () => {
    const s = addressLookupReducer(
      { loading: true, error: null, candidates: [cand()], attemptedZip: null },
      { type: "failure", error: "provider_error" },
    );
    expect(s).toEqual({
      loading: false,
      error: "provider_error",
      candidates: [],
      attemptedZip: null,
    });
  });

  it("reset で loading/error/candidates が消える (#7)", () => {
    const s = addressLookupReducer(
      {
        loading: true,
        error: "provider_error",
        candidates: [cand(), cand()],
        attemptedZip: "1000005",
      },
      { type: "reset" },
    );
    expect(s).toEqual(initialLookupState);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
    expect(s.candidates).toEqual([]);
  });
});

// ---------------------------------------------------------------
// normalizeZipForCompare / isPostalResultForZip
// （Codex P2-H: postal lookup 結果を生成元 zip に紐付け＝zip 変更で stale 化）
// ---------------------------------------------------------------

describe("normalizeZipForCompare / isPostalResultForZip (P2-H)", () => {
  it("normalizeZipForCompare はハイフン・空白を無視して比較できる", () => {
    expect(normalizeZipForCompare("100-0005")).toBe("1000005");
    expect(normalizeZipForCompare(" 100 0005 ")).toBe("1000005");
    expect(normalizeZipForCompare("100-0005")).toBe(
      normalizeZipForCompare("1000005"),
    );
  });

  it("attemptedZip=null は postal 由来でない＝false（住所検索結果は zip に紐づかない）", () => {
    expect(isPostalResultForZip("1000005", null)).toBe(false);
    expect(isPostalResultForZip("", null)).toBe(false);
  });

  it("現在 zip と attemptedZip が正規化一致なら true（ハイフン差を無視）", () => {
    expect(isPostalResultForZip("100-0005", "1000005")).toBe(true);
    expect(isPostalResultForZip("1000005", "100-0005")).toBe(true);
  });

  it("zip が変わって attemptedZip と不一致なら false＝postal 結果は stale", () => {
    expect(isPostalResultForZip("2000000", "1000005")).toBe(false);
  });
});

// ---------------------------------------------------------------
// addressLookupReducer の attemptedZip 追跡（Codex P2-H）
// ---------------------------------------------------------------

describe("addressLookupReducer attemptedZip (P2-H)", () => {
  it("初期状態の attemptedZip は null", () => {
    expect(initialLookupState.attemptedZip).toBeNull();
  });

  it("request は attemptedZip を保持する（postal 由来の zip を記録）", () => {
    const s = addressLookupReducer(initialLookupState, {
      type: "request",
      attemptedZip: "1000005",
    });
    expect(s.attemptedZip).toBe("1000005");
    expect(s.loading).toBe(true);
    expect(s.candidates).toEqual([]);
  });

  it("request で attemptedZip 省略時は null（住所検索など postal でない取得）", () => {
    const s = addressLookupReducer(initialLookupState, { type: "request" });
    expect(s.attemptedZip).toBeNull();
  });

  it("success は attemptedZip を維持する（候補がどの zip 由来か保つ）", () => {
    const req = addressLookupReducer(initialLookupState, {
      type: "request",
      attemptedZip: "1000005",
    });
    const s = addressLookupReducer(req, {
      type: "success",
      candidates: [cand()],
    });
    expect(s.attemptedZip).toBe("1000005");
  });

  it("failure も attemptedZip を維持する（該当なし/失敗表示を zip に紐付け）", () => {
    const req = addressLookupReducer(initialLookupState, {
      type: "request",
      attemptedZip: "1000005",
    });
    const s = addressLookupReducer(req, {
      type: "failure",
      error: "provider_error",
    });
    expect(s.attemptedZip).toBe("1000005");
  });

  it("reset で attemptedZip も null へ戻る（postal context を捨てる）", () => {
    const req = addressLookupReducer(initialLookupState, {
      type: "request",
      attemptedZip: "1000005",
    });
    const s = addressLookupReducer(req, { type: "reset" });
    expect(s.attemptedZip).toBeNull();
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

describe("createAddressLookupController (P2-F: schedule時に旧候補を即クリア)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("住所を再編集した瞬間（debounce発火前）に旧候補クリアの action が積まれる", async () => {
    const { actions, fetchByAddress, controller, successes } =
      setupController();
    const first = deferred<LookupResult>();
    fetchByAddress.mockReturnValueOnce(first.promise);

    controller.searchByAddress("東京都A");
    vi.advanceTimersByTime(300);
    first.resolve({ candidates: [cand({ addressLine: "旧候補" })] });
    await flushMicrotasks();
    expect(successes()).toHaveLength(1); // 旧候補が表示されている状態

    controller.searchByAddress("東京都AB"); // 編集＝schedule（debounce 未発火）
    expect(actions[actions.length - 1]).toEqual({ type: "reset" }); // 即クリア
  });

  it("debounce窓の間、UIに見える候補は空＝クリックできる旧候補が存在しない", async () => {
    const { actions, fetchByAddress, controller } = setupController();
    const first = deferred<LookupResult>();
    const second = deferred<LookupResult>();
    fetchByAddress
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    controller.searchByAddress("東京都A");
    vi.advanceTimersByTime(300);
    first.resolve({
      candidates: [cand({ postalCode: "1110000", addressLine: "旧クエリ候補" })],
    });
    await flushMicrotasks();

    controller.searchByAddress("東京都AB"); // 編集＝schedule
    // action 列を reducer で再生＝この瞬間に UI に見える状態を検証
    const duringWindow = actions.reduce(addressLookupReducer, initialLookupState);
    expect(duringWindow.candidates).toEqual([]); // 旧クエリの候補ボタンは消えている

    vi.advanceTimersByTime(300); // 新しい検索が発火
    second.resolve({ candidates: [cand({ addressLine: "新候補" })] });
    await flushMicrotasks();
    const after = actions.reduce(addressLookupReducer, initialLookupState);
    expect(after.candidates.map((c) => c.addressLine)).toEqual(["新候補"]); // 新結果のみ
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
    controller.searchByAddress("神奈川県"); // 保留（schedule 時の即クリアまで含む）
    const issued = actions.length;
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

// ---------------------------------------------------------------
// planCandidateApplication（Codex P2-C: 確認前に親フォームを部分更新しない）
// ---------------------------------------------------------------

describe("planCandidateApplication (P2-C: zip と住所をペアで計画)", () => {
  it("住所空なら immediate＝zip と住所を同時に即反映してよい (#1)(#3)", () => {
    const plan = planCandidateApplication(
      cand({ postalCode: "1000005", addressLine: "東京都千代田区丸の内" }),
      "",
    );
    expect(plan).toEqual({
      mode: "immediate",
      zip: "1000005",
      addressLine: "東京都千代田区丸の内",
    });
  });

  it("住所非空なら needs-confirm＝確認まで zip も住所も反映しない (#1)(#2)", () => {
    const plan = planCandidateApplication(
      cand({ postalCode: "1000005", addressLine: "東京都千代田区丸の内" }),
      "既存の住所",
    );
    expect(plan.mode).toBe("needs-confirm");
    // 確認確定時に zip と住所を「同時に」反映できるよう、plan が両方を運ぶ (#3)
    expect(plan.zip).toBe("1000005");
    expect(plan.addressLine).toBe("東京都千代田区丸の内");
  });

  it("空白のみの住所は空扱い＝immediate", () => {
    expect(planCandidateApplication(cand(), "   ").mode).toBe("immediate");
  });

  it("postalCode の無い候補は zip=null（郵便番号は変更しない）", () => {
    expect(
      planCandidateApplication(cand({ postalCode: undefined }), "").zip,
    ).toBeNull();
  });
});

// ---------------------------------------------------------------
// lookupByPostalCode の onSuccess（Codex P2-D: 単一候補の自動反映用）
// ---------------------------------------------------------------

describe("createAddressLookupController (P2-D: lookupByPostalCode の onSuccess)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("成功かつ最新のとき onSuccess が候補つきで呼ばれる (#4)(#5)", async () => {
    const { fetchByPostalCode, controller } = setupController();
    const postal = deferred<LookupResult>();
    fetchByPostalCode.mockReturnValueOnce(postal.promise);
    const onSuccess = vi.fn();

    controller.lookupByPostalCode("1000005", onSuccess);
    postal.resolve({ candidates: [cand({ postalCode: "1000005" })] });
    await flushMicrotasks();

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess.mock.calls[0][0]).toHaveLength(1);
  });

  it("stale（後続操作で無効化）なら onSuccess は呼ばれない (#10)", async () => {
    const { fetchByPostalCode, controller } = setupController();
    const postal = deferred<LookupResult>();
    fetchByPostalCode.mockReturnValueOnce(postal.promise);
    const onSuccess = vi.fn();

    controller.lookupByPostalCode("1000005", onSuccess);
    controller.reset(); // 後続操作＝postal 応答は stale
    postal.resolve({ candidates: [cand()] });
    await flushMicrotasks();

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("失敗時は onSuccess は呼ばれない", async () => {
    const { fetchByPostalCode, controller } = setupController();
    fetchByPostalCode.mockRejectedValueOnce(new Error("err"));
    const onSuccess = vi.fn();

    controller.lookupByPostalCode("1000005", onSuccess);
    await flushMicrotasks();

    expect(onSuccess).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------
// createAddressLookupController（Codex P2-H: postal request は attemptedZip を載せ、
// 住所検索/reset は postal context をクリアする）
// ---------------------------------------------------------------

describe("createAddressLookupController (P2-H: postal 結果を zip に紐付け)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lookupByPostalCode の request に attemptedZip=zip が載る", () => {
    const { actions, fetchByPostalCode, controller } = setupController();
    fetchByPostalCode.mockReturnValueOnce(deferred<LookupResult>().promise);

    controller.lookupByPostalCode("100-0005");

    const req = actions.find((a) => a.type === "request");
    expect(req).toEqual({ type: "request", attemptedZip: "100-0005" });
  });

  it("postal 成功後の reduce 結果は attemptedZip=zip を保つ（候補が zip 由来と分かる）", async () => {
    const { actions, fetchByPostalCode, controller } = setupController();
    const postal = deferred<LookupResult>();
    fetchByPostalCode.mockReturnValueOnce(postal.promise);

    controller.lookupByPostalCode("1000005");
    postal.resolve({ candidates: [cand({ postalCode: "1000005" })] });
    await flushMicrotasks();

    const reduced = actions.reduce(addressLookupReducer, initialLookupState);
    expect(reduced.attemptedZip).toBe("1000005");
    expect(reduced.candidates).toHaveLength(1);
  });

  it("住所検索は attemptedZip を載せない＝reduce 後 attemptedZip=null（postal と混同しない）", async () => {
    const { actions, fetchByAddress, controller } = setupController();
    const addr = deferred<LookupResult>();
    fetchByAddress.mockReturnValueOnce(addr.promise);

    controller.searchByAddress("東京都新宿区");
    vi.advanceTimersByTime(300);
    addr.resolve({ candidates: [cand()] });
    await flushMicrotasks();

    const reduced = actions.reduce(addressLookupReducer, initialLookupState);
    expect(reduced.attemptedZip).toBeNull();
  });

  it("postal lookup 後に住所検索すると attemptedZip が即 null へクリアされる（mode=both で postal context が残らない）", async () => {
    const { actions, fetchByPostalCode, fetchByAddress, controller } =
      setupController();
    const postal = deferred<LookupResult>();
    fetchByPostalCode.mockReturnValueOnce(postal.promise);

    controller.lookupByPostalCode("1000005");
    postal.resolve({ candidates: [cand({ postalCode: "1000005" })] });
    await flushMicrotasks();
    expect(
      actions.reduce(addressLookupReducer, initialLookupState).attemptedZip,
    ).toBe("1000005");

    fetchByAddress.mockReturnValueOnce(deferred<LookupResult>().promise);
    controller.searchByAddress("東京都新宿区"); // schedule 時の reset で即クリア
    expect(
      actions.reduce(addressLookupReducer, initialLookupState).attemptedZip,
    ).toBeNull();
  });

  it("reset は attemptedZip を null へ戻す", async () => {
    const { actions, fetchByPostalCode, controller } = setupController();
    fetchByPostalCode.mockReturnValueOnce(deferred<LookupResult>().promise);

    controller.lookupByPostalCode("1000005");
    controller.reset();

    expect(
      actions.reduce(addressLookupReducer, initialLookupState).attemptedZip,
    ).toBeNull();
  });
});

// ---------------------------------------------------------------
// evaluateAddressSearchEffect（Codex P2-E: mount 時の既存住所では検索しない）
// ---------------------------------------------------------------

describe("evaluateAddressSearchEffect (P2-E/P2-G: ユーザー編集後だけ検索)", () => {
  const guard = (
    lastSeen: string,
    programmatic: string | null = null,
  ): AddressSearchEffectState => ({
    lastSeenAddress: lastSeen,
    programmaticAddress: programmatic,
  });

  // ---- P2-G: 明示的な user-edit (touched) signal が必須 ----

  it("edit form 想定: mount 時 address=''（loading 中）→ 保存済み住所が prop 反映されても userEdited=false なら検索しない（P2-G）", () => {
    // 親フォームの非同期ロード: control が先に mount → 後から保存値が prop update。
    // 住所は変化して見えるが user edit ではない → provider へ住所 PII を送らない。
    const out = evaluateAddressSearchEffect(
      true,
      false,
      false, // userEdited=false（親からの保存値反映）
      "東京都千代田区保存済み住所",
      guard(""), // mount 時は空を記録していた
    );
    expect(out.action).toBe("none");
    // 届いた値は lastSeen に記録される（後の編集判定の基準が最新化される）
    expect(out.nextState.lastSeenAddress).toBe("東京都千代田区保存済み住所");
  });

  it("prop update と user input の区別: 同じ住所変化でも userEdited の有無だけで search/none が分かれる（P2-G）", () => {
    const byProp = evaluateAddressSearchEffect(
      true,
      false,
      false,
      "東京都新宿区",
      guard("東京都"),
    );
    const byUser = evaluateAddressSearchEffect(
      true,
      false,
      true,
      "東京都新宿区",
      guard("東京都"),
    );
    expect(byProp.action).toBe("none");
    expect(byUser.action).toBe("search");
  });

  it("mode=search/both とも保存済み住所のロードだけでは検索しない（showSearch=true 経路で userEdited=false）（P2-G）", () => {
    // showSearch=true は mode="search"/"both" の両方を表す（component 側で固定済み）。
    expect(
      evaluateAddressSearchEffect(true, false, false, "保存済み", guard("")).action,
    ).toBe("none");
  });

  // ---- P2-E（userEdited=true のときの既存ガードは維持） ----

  it("mount 時＝住所が lastSeen と同値なら検索しない (#7)", () => {
    const out = evaluateAddressSearchEffect(
      true,
      false,
      true,
      "東京都既存住所",
      guard("東京都既存住所"),
    );
    expect(out.action).toBe("none");
    expect(out.nextState.lastSeenAddress).toBe("東京都既存住所");
  });

  it("ユーザー編集＝touched かつ住所が変わったら検索する (#8)", () => {
    const out = evaluateAddressSearchEffect(
      true,
      false,
      true,
      "東京都新宿区",
      guard("東京都"),
    );
    expect(out.action).toBe("search");
    expect(out.nextState.lastSeenAddress).toBe("東京都新宿区");
    expect(out.nextState.programmaticAddress).toBeNull();
  });

  it("disabled なら住所が変わっても検索せず reset (#9)", () => {
    const out = evaluateAddressSearchEffect(
      true,
      true,
      true,
      "東京都変更後",
      guard("東京都"),
    );
    expect(out.action).toBe("reset");
    expect(out.nextState.lastSeenAddress).toBe("東京都変更後");
  });

  it("候補反映で自分が書いた住所では検索しない（consume される）", () => {
    const out = evaluateAddressSearchEffect(
      true,
      false,
      true,
      "東京都千代田区丸の内",
      guard("", "東京都千代田区丸の内"),
    );
    expect(out.action).toBe("none");
    expect(out.nextState.programmaticAddress).toBeNull();
    expect(out.nextState.lastSeenAddress).toBe("東京都千代田区丸の内");
  });

  it("空になったら reset＝古い候補を消す", () => {
    const out = evaluateAddressSearchEffect(
      true,
      false,
      true,
      "",
      guard("東京都"),
    );
    expect(out.action).toBe("reset");
    expect(out.nextState.lastSeenAddress).toBe("");
  });

  it("showSearch=false なら何もしない", () => {
    expect(
      evaluateAddressSearchEffect(false, false, true, "東京都", guard(""))
        .action,
    ).toBe("none");
  });
});

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
