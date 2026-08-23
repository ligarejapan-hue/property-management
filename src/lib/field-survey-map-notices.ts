/**
 * 地図の上に直接出す通知文 (地図操作性 第1弾 A3/A4・発注者承認 2026-08-24)。
 *
 * - 打ち切り(A3): ピン100/物件200件の上限で**黙って古いものが消えていた**。
 *   API の hasNext を画面が読むようにし、超過時はこの断りを地図上に出す。
 * - 踏破の状態(A4): 「確認中/取得失敗/範囲広すぎ」がスマホでは閉じたパネルの
 *   中にしかなく、「色がない=誰も通っていない」と誤読させていた。
 *   状態→文言をここで決め、地図上のチップとパネルの詳しい説明を両立させる。
 *
 * 表示の優先度: 取得失敗 > 範囲広すぎ > 確認中。面(coverage)と線(tracks)は
 * どちらか悪い方に合わせる(色が信用できない状況を隠さない)。
 */
import type { CoverageStatus } from "./field-survey-coverage";

export function truncationNotice(input: {
  pinsTruncated: boolean;
  propertiesTruncated: boolean;
}): string | null {
  const { pinsTruncated, propertiesTruncated } = input;
  if (!pinsTruncated && !propertiesTruncated) return null;
  const what =
    pinsTruncated && propertiesTruncated
      ? "ピン・物件"
      : pinsTruncated
        ? "ピン"
        : "物件";
  return `表示しきれていない${what}があります。地図を拡大してください。`;
}

const COVERAGE_NOTICE_RANK: Record<CoverageStatus, number> = {
  off: 0,
  ready: 0,
  loading: 1,
  "too-wide": 2,
  unavailable: 3,
};

const COVERAGE_NOTICE_TEXT: Record<number, string | null> = {
  0: null,
  1: "歩いた場所を確認中…",
  2: "範囲が広すぎるため、歩いた場所は表示していません。",
  3: "歩いた場所を取得できませんでした。色が付いていない場所も、通っている可能性があります。",
};

export function coverageOnMapNotice(input: {
  coverage: CoverageStatus;
  tracks: CoverageStatus;
}): string | null {
  const rank = Math.max(
    COVERAGE_NOTICE_RANK[input.coverage],
    COVERAGE_NOTICE_RANK[input.tracks],
  );
  return COVERAGE_NOTICE_TEXT[rank];
}
