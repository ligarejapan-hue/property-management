"use client";

/**
 * S1b-2: 画面保護の視覚的抑止レイヤー（透かし）。
 *
 * - position:fixed / inset-0 で全画面を覆う。
 * - pointer-events-none + aria-hidden + select-none で通常操作・支援技術・選択を阻害しない。
 * - 低透過のタイル反復で、スクリーンショット・写真・録画に閲覧者の身元を写し込む。
 * - これは「防止」ではなく「抑止＋事後追跡」。DevTools で削除可能。
 *
 * 印刷時の挙動は globals.css の `.screen-protection-watermark` の @media print で最小調整する
 * （position:fixed のため全ページへのタイルはブラウザ依存で保証しない）。
 */

const TILE_COUNT = 80;

export default function WatermarkOverlay({ text }: { text: string }) {
  const tiles = [...Array(TILE_COUNT).keys()];
  return (
    <div
      aria-hidden="true"
      data-testid="screen-protection-watermark"
      className="screen-protection-watermark pointer-events-none fixed inset-0 z-[60] flex flex-wrap content-start gap-x-16 gap-y-12 overflow-hidden p-8 opacity-[0.06] select-none"
    >
      {tiles.map((i) => (
        <span
          key={i}
          className="-rotate-[30deg] whitespace-nowrap text-xs font-semibold text-gray-900"
        >
          {text}
        </span>
      ))}
    </div>
  );
}
