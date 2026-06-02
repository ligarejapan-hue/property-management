"use client";

import { watermarkSvgDataUri } from "@/lib/screen-protection";

/**
 * S1b-2: 画面保護の視覚的抑止レイヤー（透かし）。
 *
 * Codex P2-1: 固定個数のタイル要素ではなく、回転透かしを描いた SVG を
 * `background-repeat: repeat` で敷き詰める。これにより wide / tall / 4K でも
 * viewport 全体（下端・右端含む）を無透かし領域なく覆える。
 *
 * - position:fixed / inset-0 で全画面を覆う。
 * - pointer-events-none + aria-hidden + select-none で通常操作・支援技術・選択を阻害しない。
 * - 低透過。これは「防止」ではなく「抑止＋事後追跡」（DevTools で削除可能）。
 *
 * 印刷時は globals.css の `.screen-protection-watermark` @media print で最小調整する
 * （背景画像の印字はブラウザ依存のため全ページ保証はしない = best-effort）。
 */
export default function WatermarkOverlay({ text }: { text: string }) {
  return (
    <div
      aria-hidden="true"
      data-testid="screen-protection-watermark"
      className="screen-protection-watermark pointer-events-none fixed inset-0 z-[60] select-none bg-repeat opacity-[0.06]"
      style={{ backgroundImage: watermarkSvgDataUri(text) }}
    />
  );
}
