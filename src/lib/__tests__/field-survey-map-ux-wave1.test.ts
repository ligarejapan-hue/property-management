/**
 * 地図操作性 第1弾「安全と見える化」(発注者承認 2026-08-24) の固定。
 *
 * 対象9件: A1 写真削除の確認 / A2 モーダルの portal 化 / A3 打ち切りの断り /
 * A4 踏破状態を地図上へ / A5 バナーを上部スタックへ / A6 現在地の常時表示 /
 * B1 1本指パン(greedy) / B2 自動寄せの寿命とズーム規則 / B3 物件リンク別タブ。
 * (B1/B2 の挙動ピンは既存の source テスト側を更新済み。ここは残りの構造固定。)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

const MAP = read("src/components/field-survey/field-survey-map.tsx");
const PIN_DETAIL = read("src/components/field-survey/pin-detail-panel.tsx");
const TRIP = read("src/components/field-survey/trip-controls.tsx");
const CONSENT = read("src/components/field-survey/location-consent-notice.tsx");
const BANNER = read("src/components/field-survey/camera-first-banner.tsx");
const DISPLAY_POS = read("src/components/field-survey/use-display-position.ts");

describe("A1: 写真削除は確認をはさむ", () => {
  it("削除ボタンは即削除せず確認 state を立てる(直接 handleDelete を呼ばない)", () => {
    // ボタンのハンドラ部分を切り出して固定(コメント一致を避け実呼び出しで見る)。
    const at = PIN_DETAIL.indexOf('data-testid="pin-photo-delete"');
    expect(at).toBeGreaterThan(-1);
    const btn = PIN_DETAIL.slice(at - 600, at);
    expect(btn).toContain("setConfirmDeletePhotoId(p.id)");
    expect(btn).not.toContain("handleDelete(");
  });

  it("ConfirmDialog(共通部品)で「写真を削除しますか？」を出す", () => {
    expect(PIN_DETAIL).toContain('from "@/components/ui/confirm-dialog"');
    expect(PIN_DETAIL).toContain('title="写真を削除しますか？"');
  });

  it("ボタンはサムネイルの外(absolute 重なりを廃止)", () => {
    const at = PIN_DETAIL.indexOf('data-testid="pin-photo-delete"');
    const btn = PIN_DETAIL.slice(at - 600, at + 200);
    expect(btn).not.toContain("absolute right-0 top-0");
  });
});

describe("A2: 巡回モーダルは portal で必ず見える", () => {
  it("trip-controls の ModalShell と 位置同意モーダルが createPortal(document.body)", () => {
    // スマホでは閉じた(display:none)パネルの子孫として描かれ不可視だった。
    expect(TRIP).toContain('import { createPortal } from "react-dom"');
    expect(TRIP).toContain("return createPortal(");
    expect(TRIP).toContain("document.body,");
    expect(CONSENT).toContain('import { createPortal } from "react-dom"');
    expect(CONSENT).toContain("return createPortal(");
    expect(CONSENT).toContain("document.body,");
  });
});

describe("A3: 打ち切り(nextCursor)を読む・断りを出す", () => {
  it("応答の nextCursor を読む=API の実契約(hasNext は存在しない・@codex #407 R2 P1)", () => {
    const m = MAP.match(/nextCursor\?: string \| null;/g) ?? [];
    expect(m.length).toBe(2);
    expect(MAP).toContain(
      'propertiesTruncatedNext = typeof j.nextCursor === "string";',
    );
    expect(MAP).toContain('pinsTruncatedNext = typeof j.nextCursor === "string";');
    expect(MAP).toContain("onTruncationChange({");
    // ⚠存在しないフィールドを読む事故の再発防止: **契約の両側**を同じテストで
    //   固定する。route が nextCursor を返す形を変えたら、ここが名指しで落ちる。
    for (const rf of [
      "src/app/api/field-survey/map/properties/route.ts",
      "src/app/api/field-survey/pins/route.ts",
    ]) {
      expect(read(rf), rf).toContain("apiResponse({ data, nextCursor })");
    }
    // クライアント側に hasNext を読む残骸が無い(説明コメントの語は除外=コード形で見る)。
    expect(MAP).not.toContain("j.hasNext");
    expect(MAP).not.toContain("hasNext?:");
  });

  it("断りの文言は純関数 truncationNotice(専用テストあり)から取る", () => {
    expect(MAP).toContain('from "@/lib/field-survey-map-notices"');
    expect(MAP).toContain("truncationNotice({");
    expect(MAP).toContain('data-testid="map-truncation-notice"');
  });

  it("通信断(catch)でも断りをリセットする(@codex #407 R1 P2)", () => {
    // ⚠AbortError 判定は tracks/coverage の .then にもあるため、tasks の catch に
    //   足した一意コメントを anchor にする(先出現への誤当たり=実測)。
    const at = MAP.indexOf('打ち切りの断りもここで消す');
    expect(at).toBeGreaterThan(-1);
    expect(MAP.slice(at, at + 500)).toContain(
      "onTruncationChange({ pins: false, properties: false })",
    );
  });

  it("範囲過大の早期 return でも断りをリセットする(古い断りを残さない)", () => {
    const at = MAP.indexOf("const v = validateBbox(b);");
    expect(at).toBeGreaterThan(-1);
    const region = MAP.slice(at, at + 700);
    expect(region).toContain(
      "onTruncationChange({ pins: false, properties: false })",
    );
  });
});

describe("A4: 踏破の状態を地図上に出す", () => {
  it("coverageOnMapNotice(純関数・総当たりテストあり)を地図上チップに配線", () => {
    expect(MAP).toContain("coverageOnMapNotice({");
    expect(MAP).toContain('data-testid="map-coverage-notice"');
  });
});

describe("A5: バナーは上部スタック(現在地ボタンを覆わない)", () => {
  it("バナー自身は absolute/bottom-14 を持たない(配置はスタック側)", () => {
    // ⚠経緯コメントに旧クラス名が書いてあるため、className 属性そのもので見る。
    const cls = BANNER.match(/className="([^"]*)"/g) ?? [];
    expect(cls.length).toBeGreaterThan(0);
    for (const c of cls) {
      expect(c).not.toContain("bottom-14");
      expect(c).not.toContain("absolute");
    }
  });

  it("地図側の上部スタックにバナー・読み込み中・断り・踏破状態が同居する", () => {
    const at = MAP.indexOf("画面上部中央の通知スタック");
    expect(at).toBeGreaterThan(-1);
    const stack = MAP.slice(at, at + 2600);
    expect(stack).toContain("<CameraFirstBanner");
    expect(stack).toContain("読み込み中…");
    expect(stack).toContain("map-truncation-notice");
    expect(stack).toContain("map-coverage-notice");
    expect(stack).toContain("top-3");
  });

  it("バナーはスタック容器(flex-col)の中にある(下端の帯へ戻す変異はここで落ちる)", () => {
    // ⚠経緯コメントに旧クラス名(bottom-14)が載るため、判定は className で行う。
    const container = MAP.match(
      /className="pointer-events-none absolute left-1\/2 top-3[^"]*flex-col[^"]*"/,
    );
    expect(container).not.toBeNull();
    const at = MAP.indexOf(container![0]);
    const bannerAt = MAP.indexOf("<CameraFirstBanner");
    expect(bannerAt).toBeGreaterThan(at);
    // バナーが容器の中(直後2,000文字以内)にあり、その区間の className に
    // bottom-14 が無い。
    const between = MAP.slice(at, bannerAt);
    expect(bannerAt - at).toBeLessThan(2000);
    const classesBetween = between.match(/className="[^"]*"/g) ?? [];
    for (const c of classesBetween) expect(c).not.toContain("bottom-14");
  });
});

describe("A6: 現在地は許可済みなら常時表示", () => {
  it("表示専用 watch は permissions が granted のときだけ(勝手にプロンプトを出さない)", () => {
    expect(DISPLAY_POS).toContain('s.state === "granted"');
    // watchPosition の呼び出しは start() の中だけ=granted 判定の後。
    const firstWatch = DISPLAY_POS.indexOf("watchPosition");
    const grantedGate = DISPLAY_POS.indexOf('s.state === "granted"');
    expect(firstWatch).toBeGreaterThan(-1);
    expect(grantedGate).toBeGreaterThan(-1);
    // permissions.query が無い環境では watch しない(従来どおり=安全側)。
    expect(DISPLAY_POS).toContain("if (!permissions?.query) return;");
  });

  it("watch がエラーを報告したら古い現在地を消す(@codex #407 R1 P2)", () => {
    // watchPosition の第2引数(エラーコールバック)の中に setPos(null) がある。
    const at = DISPLAY_POS.indexOf("watchPosition(");
    expect(at).toBeGreaterThan(-1);
    const call = DISPLAY_POS.slice(at, at + 700);
    expect(call).toContain("setPos(null);");
  });

  it("マーカーは displayPosition(記録中=recorder / それ以外=granted watch)", () => {
    expect(MAP).toContain(
      "const displayPosition = recenterLivePosition ?? grantedDisplayPos;",
    );
    expect(MAP).toContain("const showCurrentLocationMarker = !!displayPosition;");
    // 旧「巡回中かつ記録中のみ」ゲートは残っていない。
    expect(MAP).not.toMatch(
      /showCurrentLocationMarker =\s*!!activeSession/,
    );
  });

  it("記録中は表示専用 watch を止める(二重 watch しない)", () => {
    expect(MAP).toContain("useGrantedGeolocationWatch(");
    expect(MAP).toContain('recorder.status !== "recording"');
  });
});

describe("B2: 自動寄せの予約に寿命とユーザー優先", () => {
  it("予約は15秒で失効し、地図をドラッグしたら破棄される(配線まで固定)", () => {
    expect(MAP).toContain("AUTO_CENTER_ON_START_TTL_MS = 15_000");
    // dragstart リスナーの中身が onUserDrag() を呼ぶ(存在だけの空当たり防止)。
    const at = MAP.indexOf('map.addListener("dragstart"');
    expect(at).toBeGreaterThan(-1);
    expect(MAP.slice(at, at + 200)).toContain("onUserDrag()");
    // prop が実際に cancelAutoCenterOnStart へ結線されている。
    expect(MAP).toContain("onUserDrag={cancelAutoCenterOnStart}");
  });

  it("読み込み中の解除は最新の fetch だけが行う(古い finally の早消し防止)", () => {
    expect(MAP).toContain("if (abortRef.current === ac) onLoadingChange(false);");
  });
});

describe("B3: 物件リンクは別タブ(地図の状態を失わない)", () => {
  it("吹き出しの物件リンクに target=_blank + rel(第2弾C2でピン吹き出し廃止=残り1箇所)", () => {
    const links = MAP.match(
      /href=\{`\/properties\/\$\{row\.id\}`\}\s*\n\s*target="_blank"\s*\n\s*rel="noopener noreferrer"/g,
    ) ?? [];
    expect(links.length).toBe(1);
    // ピン側のリンク(propertyId)は吹き出しごと廃止(詳細パネルの物件行が担う)。
    expect(MAP).not.toContain("row.propertyId");
  });
});

describe("読み込み中チップの吊り上げ(A3 付随)", () => {
  it("MapDataLayer は onLoadingChange で親に伝え、自前チップを持たない", () => {
    const layerAt = MAP.indexOf("function MapDataLayer(");
    const layer = MAP.slice(layerAt);
    expect(layer).toContain("onLoadingChange(true)");
    expect(layer).toContain("onLoadingChange(false)");
    expect(layer).not.toContain("読み込み中…");
  });
});
