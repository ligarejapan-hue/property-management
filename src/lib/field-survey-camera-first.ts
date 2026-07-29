/**
 * カメラファースト(撮影→ピン登録)動線の純ロジック。
 *
 * 現場スタッフが「家の前に立つ → 撮る」の体の動きでピンを登録できるよう、
 * 巡回中は地図上にカメラボタンを常設する。
 *
 * ⚠**位置は必ず地図タップで決める** (2026-07-29 業務判断)。以前は撮影後に
 * 現在地へ自動でピンを立てていたが、GPS が返すのは「立っている場所」＝道路
 * なので、**ピンが道路に立ち、どの家の写真か分からなくなる**。現地で家の前に
 * 立ったまま家の上をタップしてもらう方が、手数は同じで確実。
 * → 撮影後は常に "awaiting-map-tap"。GPS を待つ段 ("locating") は無い。
 *
 * このモジュールは UI から切り離した純関数のみ:
 * - navigator / fetch / storage / console を一切使わない
 * - 座標を文言に含めない (PII 方針)
 */

export type CameraFirstPhase = "idle" | "awaiting-map-tap";

/**
 * カメラボタンの表示 / 無効判定。
 * - 巡回 session 中、または「巡回なしで撮影」権限 (field_survey:quick_capture)
 *   保有時に表示する。後者は巡回を開始せずその場で撮って登録するための権限で、
 *   既定では誰も持たない (server 側も同じ権限で fail-closed に判定する)。
 * - 作成 modal 表示中・地図タップ待ち中は非表示 (二重起動防止 / banner に譲る)
 * - canWrite は tristate: false 確定のみ無効化、null (判定不能) は API 403 委譲で有効
 * - canCaptureWithoutTrip は「true 確定のときだけ」表示に効かせる。null(判定不能)で
 *   出すと、権限が無い人に押させて 403 にするだけなので安全側に倒す。
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
  const disabled = input.canWrite === false;
  return { visible, disabled };
}
