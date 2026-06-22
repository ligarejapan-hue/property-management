import { A4_LANDSCAPE, type SalesSheetDocument } from "../document-schema";

/** 1x1 透明 PNG（オフライン描画用。外部ネットワーク不要）。 */
const TRANSPARENT_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Plan 1 検証用のサンプル図面（ダミー・実データではない）。 */
export const sampleDocument: SalesSheetDocument = {
  page: A4_LANDSCAPE,
  theme: { fontFamily: '"Yu Gothic UI","Meiryo",sans-serif', accentColor: "#1f4e79" },
  elements: [
    {
      id: "title", type: "text", x: 10, y: 8, w: 180, h: 12, z: 2,
      content: "グランドメゾン上馬 101号室",
      style: { fontSizePt: 18, bold: true, color: "#15324f" },
    },
    {
      id: "price", type: "text", x: 10, y: 24, w: 120, h: 14, z: 2,
      content: "3,480万円",
      style: { fontSizePt: 28, bold: true, color: "#d0331a" },
    },
    {
      id: "badge1", type: "badge", x: 10, y: 40, w: 28, h: 7, z: 3,
      label: "リノベ済", shape: "pill", bg: "#0e9f6e", fg: "#ffffff", fontSizePt: 8,
    },
    {
      id: "photo1", type: "image", x: 10, y: 50, w: 120, h: 80, z: 1,
      src: TRANSPARENT_PNG, fit: "cover", radiusMm: 2, alt: "リビング",
    },
    {
      id: "overview", type: "table", x: 200, y: 50, w: 90, h: 120, z: 1,
      rows: [
        { label: "所在地", value: "東京都世田谷区上馬４丁目" },
        { label: "専有面積", value: "62.45㎡（壁芯）" },
        { label: "間取り", value: "2LDK" },
        { label: "築年月", value: "2008年3月" },
      ],
      style: { fontSizePt: 8, borderColor: "#cccccc" },
    },
  ],
};
