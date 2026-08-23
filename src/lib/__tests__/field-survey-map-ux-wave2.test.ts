/**
 * 地図操作性 第2弾「最短経路」(発注者承認 2026-08-24) の固定。
 *
 * C1 対応済み1発 / C2 タップで直接詳細(吹き出し廃止・背景タップで閉じる) /
 * C3 地図上の巡回終了+パネル順 / C4 一覧⇔地図の往復 / シート(55vh・×拡大・
 * Escape) / キーボード対策(85dvh) / 撮り直す=カメラ再起動 / エラー帯(×+開始で消す)。
 * ⚠存在チェックだけの空当たりを避け、**配線(呼び出し・結線)**まで固定する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const MAP = read("src/components/field-survey/field-survey-map.tsx");
const TRIP = read("src/components/field-survey/trip-controls.tsx");
const DETAIL = read("src/components/field-survey/pin-detail-panel.tsx");
const QUEUE = read("src/components/field-survey/candidate-queue.tsx");
const BANNER = read("src/components/field-survey/camera-first-banner.tsx");
const CAMERA_BTN = read("src/components/field-survey/camera-first-button.tsx");

describe("C1: 対応済みを1タップで", () => {
  it("読取ビューに1発ボタン(開いている時=対応済みにする/済み=戻す)", () => {
    expect(DETAIL).toContain('data-testid="pin-quick-close"');
    expect(DETAIL).toContain("✔ この場所を対応済みにする");
    expect(DETAIL).toContain('data-testid="pin-quick-reopen"');
    expect(DETAIL).toContain("未対応に戻す");
  });

  it("保存フローと同じ patch/3段ガードを通る(optimistic しない)", () => {
    const at = DETAIL.indexOf("const handleQuickStatus");
    expect(at).toBeGreaterThan(-1);
    const fn = DETAIL.slice(at, at + 1400);
    expect(fn).toContain("buildPinPatch(");
    expect(fn).toContain("mutations.updatePin(saveTargetPinId, patch)");
    expect(fn).toContain("latestPinIdRef.current !== saveTargetPinId");
    expect(fn).toContain("onUpdated?.(r.data)");
  });

  it("ボタンは onQuickStatus に結線され、直接 mutations を呼ばない", () => {
    const at = DETAIL.indexOf('data-testid="pin-quick-close"');
    const btn = DETAIL.slice(at - 400, at + 100);
    expect(btn).toContain('onQuickStatus("closed")');
    expect(btn).not.toContain("mutations.");
  });
});

describe("C2: タップで直接詳細+背景タップで閉じる", () => {
  it("背景クリックのリスナーが実際に閉じ処理へ結線されている", () => {
    const at = MAP.indexOf('map.addListener("click"');
    expect(at).toBeGreaterThan(-1);
    const listener = MAP.slice(at, at + 400);
    expect(listener).toContain("captureRef.current");
    expect(listener).toContain("setSelected(null)");
    expect(listener).toContain("onBackgroundClick()");
    expect(MAP).toContain("onBackgroundClick={closeDetailOnBackground}");
    const cb = MAP.indexOf("const closeDetailOnBackground");
    const cbBody = MAP.slice(cb, cb + 500);
    expect(cbBody).toContain("setDetailPinId(null)");
    // 提出前レビューP1: 既存の busy ゲート原則を踏襲(編集下書き等を黙って壊さない)。
    const guard = cbBody.indexOf("if (detailPanelBusyRef.current) return;");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(cbBody.indexOf("setDetailPinId(null)"));
  });

  it("タップ待ち中は背景クリックが作成処理に譲る(captureRef で最新値を見る)", () => {
    expect(MAP).toContain("const captureRef = useRef(captureMapClick);");
    expect(MAP).toContain("captureRef.current = captureMapClick;");
  });
});

describe("C3: 巡回終了を地図上に+パネル最上部", () => {
  it("地図上の終了ボタンが TripControls の確認モーダルへ結線されている", () => {
    const at = MAP.indexOf('data-testid="trip-quick-end"');
    expect(at).toBeGreaterThan(-1);
    expect(MAP.slice(at, at + 300)).toContain("endTripRef.current?.()");
    // 中継: map → ControlPanel → TripControls の3点結線。
    const passes = MAP.match(/registerEndRequest=\{registerEndRequest\}/g) ?? [];
    expect(passes.length).toBe(2);
    // TripControls 側: active のときだけ confirmEnd へ。
    const req = TRIP.indexOf("const requestEnd");
    expect(req).toBeGreaterThan(-1);
    expect(TRIP.slice(req, req + 300)).toContain('p === "active" ? "confirmEnd" : p');
  });

  it("パネル内で巡回操作(TripControls)が表示切替より上にある", () => {
    const trip = MAP.indexOf("<TripControls");
    const layers = MAP.indexOf(">表示切替</div>");
    expect(trip).toBeGreaterThan(-1);
    expect(layers).toBeGreaterThan(-1);
    expect(trip).toBeLessThan(layers);
  });
});

describe("C4: 一覧⇔地図の往復", () => {
  it("focusPin で来たときだけ「一覧へ戻る」を出す", () => {
    const at = MAP.indexOf('data-testid="map-back-to-candidates"');
    expect(at).toBeGreaterThan(-1);
    const before = MAP.slice(at - 300, at);
    expect(before).toContain("focusPinId &&");
    expect(MAP.slice(at - 300, at + 100)).toContain('href="/field-survey/candidates"');
  });

  it("一覧: 出発した行を覚え、戻ったらその行へスクロール(1回だけ)", () => {
    expect(QUEUE).toContain('sessionStorage.setItem("fsCandidatesReturnPin", r.id)');
    expect(QUEUE).toContain("data-candidate-row={r.id}");
    const eff = QUEUE.indexOf('sessionStorage.getItem("fsCandidatesReturnPin")');
    expect(eff).toBeGreaterThan(-1);
    const effBlock = QUEUE.slice(eff - 600, eff + 600);
    expect(effBlock).toContain("restoredRef.current");
    expect(effBlock).toContain('scrollIntoView({ block: "center" })');
  });
});

describe("シート・モーダルの操作性", () => {
  it("詳細シート: 55vh・×の当たり拡大・Escape で閉じる", () => {
    expect(DETAIL).toContain("max-h-[55vh]");
    expect(DETAIL).not.toContain("max-h-[70vh]");
    const close = DETAIL.indexOf('aria-label="閉じる"');
    expect(DETAIL.slice(close, close + 200)).toContain("-m-2 p-2 text-lg");
    const esc = DETAIL.indexOf('e.key !== "Escape"');
    expect(esc).toBeGreaterThan(-1);
    const escBody = DETAIL.slice(esc, esc + 900);
    // 提出前レビューP1: スタック的に閉じる+作業中はパネルを閉じない。
    expect(escBody).toContain("setShowConvert(false)");
    expect(escBody).toContain("setConfirmingDelete(false)");
    const guard = escBody.indexOf("if (hasUnfinishedWork) return;");
    const closeAt = escBody.indexOf("onClose()");
    expect(guard).toBeGreaterThan(-1);
    expect(closeAt).toBeGreaterThan(guard);
    // 写真削除の確認オープンも作業中に含まれる(dialog との二重処理防止)。
    expect(DETAIL).toContain("confirmDeletePhotoId !== null;");
  });

  it("ピン作成/物件化モーダル: 85dvh+overscroll+上寄せ(キーボードで保存が隠れる対策)", () => {
    for (const f of [
      "src/components/field-survey/pin-create-modal.tsx",
      "src/components/field-survey/convert-pin-to-property-modal.tsx",
    ]) {
      const s = read(f);
      expect(s, f).toContain("max-h-[85dvh]");
      expect(s, f).toContain("overscroll-contain");
      expect(s, f).toContain("items-start justify-center pt-4 sm:items-center");
    }
  });
});

describe("撮り直す=カメラを実際に開く", () => {
  it("起動口は常時マウントの隠し input(FABはタップ待ち中アンマウントされるため)", () => {
    // 提出前レビューP1: FABの input へ登録する方式は、バナー表示中は必ず
    // ref=null でカメラが開かなかった。常時マウント input が唯一の確実な口。
    const at = MAP.indexOf('data-testid="camera-retake-input"');
    expect(at).toBeGreaterThan(-1);
    const input = MAP.slice(at - 400, at + 500);
    expect(input).toContain('type="file"');
    expect(input).toContain('capture="environment"');
    expect(input).toContain("handleCameraPhotoCaptured(file)");
    // バナーの撮り直すが reset→この input を click する順で結線。
    const r = MAP.indexOf("onRetake={() => {");
    const w = MAP.slice(r, r + 260);
    expect(w.indexOf("resetCameraFirst()")).toBeGreaterThan(-1);
    expect(w.indexOf("retakeInputRef.current?.click()")).toBeGreaterThan(
      w.indexOf("resetCameraFirst()"),
    );
    // 旧・登録機構の残骸なし。
    expect(MAP).not.toContain("registerCameraTrigger");
    expect(CAMERA_BTN).not.toContain("registerTrigger");
    expect(BANNER).toContain('data-testid="camera-first-retake"');
  });
});

describe("エラー帯の整理", () => {
  it("×で閉じられ、巡回開始で古い案内が消える", () => {
    const at = MAP.indexOf('role="alert"');
    expect(MAP.slice(at, at + 900)).toContain("setError(null)");
    // justStarted 分岐の中で消す(開始に従ったのに赤が残らない)。
    const js = MAP.indexOf("opts?.justStarted) {");
    expect(MAP.slice(js, js + 300)).toContain("setError(null)");
  });
});
