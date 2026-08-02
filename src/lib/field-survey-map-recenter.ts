/**
 * 地図の「現在地へ移動」の純ロジック。
 *
 * ⚠**なぜ機能が要るか**: 同じ操作は表示切替パネル最下部にもあるが、スマホでは
 * パネルを開いて最下部までスクロールしないと押せず、しかも巡回中 (位置記録中)
 * にしか効かない。街歩き中に地図をずらして自分の場所へ戻る、という最も頻度の
 * 高い操作が最も遠い場所にあった (2026-08-03 発注者の実機フィードバック)。
 *
 * このモジュールは UI から切り離した純関数のみ:
 * - navigator / fetch / storage / console を一切使わない
 * - 座標を文言に含めない (PII 方針)。エラー文言は code から自前で組み立て、
 *   ブラウザ由来の message (英語・環境情報を含み得る) は素通ししない
 */

export interface RecenterPosition {
  lat: number;
  lng: number;
}

/** 「現在地へ移動」を押したときに何をするか。 */
export type RecenterPlan =
  /** 位置記録中 = recorder の最新位置で即座に寄せる (GPS を取り直さない)。 */
  | { kind: "use-live"; pos: RecenterPosition }
  /** 記録していない = その場で単発取得する。 */
  | { kind: "locate" }
  /** 取得中の連打 = 何もしない (取得を多重に走らせない)。 */
  | { kind: "busy" };

/**
 * 押下時の分岐を決める。
 *
 * ⚠**位置記録中を最優先**にするのは、取得済みの位置があるのに GPS を取り直すと
 * 数秒待たされるうえ、屋内では取得失敗して「押しても動かない」ことがあるため。
 * ⚠**取得中 (locating) の判定は live より後**。記録中なら追加取得は走らないので、
 * busy を先に見ると「記録中なのに連打で無反応」になる。
 */
export function recenterPlan(input: {
  /** 位置記録中に recorder が持っている最新位置。記録していなければ null。 */
  livePosition: RecenterPosition | null;
  /** 単発取得が進行中か。 */
  locating: boolean;
}): RecenterPlan {
  if (input.livePosition) {
    return {
      kind: "use-live",
      pos: { lat: input.livePosition.lat, lng: input.livePosition.lng },
    };
  }
  if (input.locating) return { kind: "busy" };
  return { kind: "locate" };
}

/**
 * 取得失敗の理由を、現場で**直し方が分かる**日本語にする。
 *
 * ⚠GeolocationPositionError.message はブラウザ依存かつ英語で、稀にホスト名等の
 * 環境情報を含む。そのまま画面へ出さず、code から写した固定文だけを使う。
 * code は 1=PERMISSION_DENIED / 2=POSITION_UNAVAILABLE / 3=TIMEOUT。
 */
export function describeGeolocationError(code: number | null): string {
  if (code === 1) {
    return "位置情報が許可されていません。ブラウザの設定で許可するか、https で始まるアドレスから開き直してください。";
  }
  if (code === 3) {
    return "現在地を取得できませんでした。屋外や窓際でもう一度お試しください。";
  }
  return "現在地を取得できませんでした。電波の届く場所でもう一度お試しください。";
}

/** geolocation API 自体が無い環境 (対応していないブラウザ) の案内。 */
export const RECENTER_UNSUPPORTED_MESSAGE =
  "このブラウザでは現在地を取得できません。地図をタップして場所を指定してください。";

/**
 * 寄せたあとに倍率を上げるか。
 *
 * 市区町村が入る広さ (既定 14) のまま寄せても現場では使えないため、引きすぎて
 * いるときだけ街歩き用まで上げる。⚠すでに寄せている人の倍率は変えない
 * (勝手に引かれると、見ていた範囲を見失う)。
 */
export function recenterZoom(input: {
  currentZoom: number | null | undefined;
  tripZoom: number;
}): number | null {
  const z = input.currentZoom;
  if (typeof z !== "number" || !Number.isFinite(z)) return null;
  return z < input.tripZoom ? input.tripZoom : null;
}
