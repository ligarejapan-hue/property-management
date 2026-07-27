/**
 * カメラファースト(撮影→自動ピン)動線の純ロジック。
 *
 * 現場スタッフが「家の前に立つ → 撮る」の体の動きだけでピンを登録できるよう、
 * 巡回中は地図上にカメラボタンを常設し、撮影後に現在地へピン作成 modal を開く。
 * 現在地が取れない環境 (http / 権限拒否 / タイムアウト) では「地図をタップして
 * 場所を指定」へフォールバックする。
 *
 * このモジュールは UI から切り離した純関数のみ:
 * - navigator / fetch / storage / console を一切使わない
 * - 座標を文言に含めない (PII 方針)
 */

export type CameraFirstPhase = "idle" | "locating" | "awaiting-map-tap";

export interface CameraFirstCandidate {
  lat: number;
  lng: number;
  accuracy?: number;
}

/**
 * geolocation success callback の raw position を候補座標へ安全に変換する。
 * lat / lng が数値でない・非有限なら null (呼び出し側で地図タップへフォールバック)。
 * accuracy は非数値・非有限なら undefined に落とす (誤送信防止)。
 */
export function cameraFirstCandidateFromPosition(
  pos: unknown,
): CameraFirstCandidate | null {
  const coords = (pos as { coords?: unknown } | null)?.coords as
    | { latitude?: unknown; longitude?: unknown; accuracy?: unknown }
    | undefined;
  const lat = coords?.latitude;
  const lng = coords?.longitude;
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    return null;
  }
  const acc = coords?.accuracy;
  return {
    lat,
    lng,
    accuracy:
      typeof acc === "number" && Number.isFinite(acc) ? acc : undefined,
  };
}

/**
 * 現在地が取れなかった時の案内文。必ず「地図をタップ」への誘導を含める。
 * エラーコードは GeolocationPositionError (1=拒否 / 2=取得不能 / 3=タイムアウト)。
 * 技術用語・座標は含めない (平易な日本語)。
 */
export function cameraFirstFallbackMessage(errorCode: number | null): string {
  if (errorCode === 1) {
    return "位置情報の利用が許可されていないため現在地を使えません。地図をタップして、撮った場所を指定してください。";
  }
  if (errorCode === 3) {
    return "現在地の取得がタイムアウトしました。地図をタップして、撮った場所を指定してください。";
  }
  return "現在地を取得できませんでした。地図をタップして、撮った場所を指定してください。";
}

/**
 * カメラボタンの表示 / 無効判定。
 * - 巡回 session 中、または「巡回なしで撮影」権限 (field_survey:quick_capture)
 *   保有時に表示する。後者は巡回を開始せずその場で撮って登録するための権限で、
 *   既定では誰も持たない (server 側も同じ権限で fail-closed に判定する)。
 * - 作成 modal 表示中・地図タップ待ち中は非表示 (二重起動防止 / banner に譲る)
 * - canWrite は tristate: false 確定のみ無効化、null (判定不能) は API 403 委譲で有効
 * - canCaptureWithoutTrip は「true 確定のときだけ」表示に効かせる。null(判定不能)で
 *   出すと、権限が無い人に押させて 403 にするだけなので安全側に倒す。
 * - 現在地取得中 (locating) は押下不可
 */
export function cameraFirstButtonState(input: {
  hasActiveSession: boolean;
  /** 巡回外でも撮影できるか (field_survey:quick_capture)。null = 判定不能。 */
  canCaptureWithoutTrip?: boolean | null;
  canWrite: boolean | null;
  phase: CameraFirstPhase;
  modalOpen: boolean;
}): { visible: boolean; disabled: boolean } {
  const visible =
    (input.hasActiveSession || input.canCaptureWithoutTrip === true) &&
    !input.modalOpen &&
    input.phase !== "awaiting-map-tap";
  const disabled = input.canWrite === false || input.phase === "locating";
  return { visible, disabled };
}

/**
 * 撮影と並行取得した現在地を「そのまま採用してよいか」の鮮度しきい値 (ms)。
 *
 * カメラを開けたまま歩いて移動すると、ボタンを押した地点の座標で撮影地点の
 * ピンが立ってしまう (@codex #329 R1)。徒歩の移動速度 (概ね 1.4m/s) で
 * 20 秒 ≒ 30m 弱のずれに収まる範囲を上限とし、これを超えたら取り直す。
 * 精度の琥珀警告しきい値 (100m) より十分小さい。
 */
export const CAMERA_PREFETCH_MAX_AGE_MS = 20_000;

/**
 * 先読みした位置が撮影時点でまだ十分新しいか。
 *
 * `GeolocationPosition.timestamp` は取得時刻 (maximumAge のキャッシュ採用分も
 * 反映される) なので、これを基準に判定する。timestamp が取れない実装では
 * 安全側 (古い扱い = 取り直す) に倒す。
 */
export function isCameraPrefetchFresh(
  pos: { timestamp?: number } | null | undefined,
  now: number = Date.now(),
  maxAgeMs: number = CAMERA_PREFETCH_MAX_AGE_MS,
): boolean {
  const ts = pos?.timestamp;
  if (typeof ts !== "number" || !Number.isFinite(ts)) return false;
  const age = now - ts;
  // 端末時計のずれ等で未来時刻になった場合は「新しい」として扱う (age<0)。
  return age <= maxAgeMs;
}
