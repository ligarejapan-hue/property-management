/** 消費者向けひな型(2026-09・案3「整理型」×紺)の色と書体。仕様書 §3.1。 */
export const CONSUMER_COLORS = {
  navy: "#1f3a5f",
  price: "#b7281e",
  soft: "#eef2f7",
  ink: "#1a1a1a",
  muted: "#555555",
  white: "#ffffff",
} as const;

/** 本番サーバーは fonts-morisawa-bizud-gothic を導入して BIZ UDPGothic で描く。未導入でも後ろの予備で描ける。 */
export const CONSUMER_FONT_FAMILY = '"BIZ UDPGothic","Yu Gothic UI","Meiryo",sans-serif';
