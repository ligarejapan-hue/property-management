import {
  A4_LANDSCAPE,
  type SalesSheetDocument,
  type SalesSheetElement,
} from "./document-schema";
import { inlineDocumentImages } from "./inline-images";
import { isSafeImageSrc } from "./css-safety";
import { getStorage } from "@/lib/storage";
import type { StorageAdapter } from "@/lib/storage/types";
import { localizeOccupancy } from "@/lib/property-types";

export interface SaleLandOverrides {
  price?: string;
  access?: string;
  landArea?: string;
  landCategory?: string;
  transactionType?: string;
  deliveryTiming?: string;
  remarks?: string;
}

export interface SaleLandInput {
  property: {
    address: string;
    zoningDistrict?: string | null;
    buildingCoverageRatio?: string | null;
    floorAreaRatio?: string | null;
    roadType?: string | null;
    roadWidth?: string | null;
    occupancyStatus?: string | null;
  };
  owner?: { name?: string | null } | null;
  photo?: { fileUrl: string } | null;
  overrides?: SaleLandOverrides;
}

/**
 * 保存する画像 src を正規化する。`PropertyPhoto.fileUrl` は storage backend に
 * よって `/uploads/{key}`（local）や `/{bucket}/{key}` / 絶対URL（server）など
 * 形が異なる。storage key を解決して常に正規の `/uploads/{key}` 形へ揃えることで、
 * 保存時の `isSafeImageSrc`（`/uploads/` か `data:` のみ許可）を通り、出力時に
 * `authorizeAndInlineDocumentImages` が `keyFromUrl` で再解決できる。
 * key を解決できない場合は null（呼び出し側で写真を落とす）。
 */
export function toCanonicalUploadsSrc(
  fileUrl: string | null | undefined,
  storage: Pick<StorageAdapter, "keyFromUrl"> = getStorage(),
): string | null {
  const key = storage.keyFromUrl(fileUrl ?? null);
  if (!key) return null;
  const candidate = `/uploads/${key}`;
  // key は storage 的に有効でも image src として不正なことがある（空白/%2e 等）。
  // その場合は写真を落とす（src を返さない）。さもないと保存境界の parseSalesSheetDocument が
  // 図面全体を 422 で弾く。
  return isSafeImageSrc(candidate) ? candidate : null;
}

const NAVY = "#15324f";
const RED = "#d0331a";
const FONT = '"Yu Gothic UI","Meiryo",sans-serif';
const COMPANY = "株式会社リガーレジャパン Ligare Japan　TEL 03-6823-2760";

function row(label: string, value: string | null | undefined): { label: string; value: string } {
  return { label, value: value ?? "" };
}

/** 建蔽率/容積率 → "50％ ／ 100％"（両方空なら ""）。 */
function formatRatio(cover?: string | null, floor?: string | null): string {
  return cover || floor ? `${cover ?? "-"}％ ／ ${floor ?? "-"}％` : "";
}
/** 接道 → "公道 幅員4.0m"（空要素は落とす）。 */
function formatRoad(type?: string | null, width?: string | null): string {
  return [type, width ? `幅員${width}m` : null].filter(Boolean).join(" ") || "";
}

/** 売土地 図面の document を組む（純関数・写真は未展開の /uploads/ src のまま）。 */
export function buildSaleLandDocument(input: SaleLandInput): SalesSheetDocument {
  const o = input.overrides ?? {};
  const p = input.property;
  const ratio = formatRatio(p.buildingCoverageRatio, p.floorAreaRatio);
  const road = formatRoad(p.roadType, p.roadWidth);

  const elements: SalesSheetElement[] = [
    { id: "title", type: "text", x: 10, y: 8, w: 180, h: 10, z: 2,
      content: "売土地", style: { fontSizePt: 16, bold: true, color: NAVY } },
    { id: "price-label", type: "text", x: 10, y: 22, w: 30, h: 8, z: 2,
      content: "価格", style: { fontSizePt: 10, color: "#888888" } },
    { id: "price", type: "text", x: 10, y: 28, w: 130, h: 14, z: 2,
      content: o.price ?? "", style: { fontSizePt: 26, bold: true, color: RED } },
    { id: "overview", type: "table", x: 150, y: 22, w: 137, h: 160, z: 1,
      rows: [
        row("所在地", p.address),
        row("交通", o.access),
        row("土地面積", o.landArea),
        row("地目", o.landCategory),
        row("用途地域", p.zoningDistrict),
        row("建蔽率/容積率", ratio),
        row("接道", road),
        row("現況", localizeOccupancy(p.occupancyStatus)),
        row("引渡", o.deliveryTiming),
        row("取引態様", o.transactionType),
        row("備考", o.remarks),
      ],
      style: { fontSizePt: 9, borderColor: "#cccccc", labelColor: NAVY } },
    { id: "company", type: "text", x: 10, y: 192, w: 277, h: 10, z: 2,
      content: COMPANY,
      style: { fontSizePt: 9, color: NAVY } },
  ];

  if (input.photo?.fileUrl) {
    elements.push({
      id: "photo", type: "image", x: 10, y: 46, w: 130, h: 95, z: 1,
      src: input.photo.fileUrl, fit: "cover", radiusMm: 2, alt: "物件写真",
    });
  }

  return {
    page: A4_LANDSCAPE,
    theme: { fontFamily: FONT, accentColor: NAVY },
    elements,
  };
}

/** DB データ → 写真を data: 展開済みの検証可能な document。 */
export async function buildInitialSalesSheetDocument(
  input: SaleLandInput,
): Promise<SalesSheetDocument> {
  return inlineDocumentImages(buildSaleLandDocument(input));
}

// ---------------------------------------------------------------------------
// 追加テンプレ（売マンション / 売戸建 / 一棟）— 売土地と同じ骨格を流用し、
// 概要表の行・表題・写真枚数だけを差し替える純関数群。写真は未展開の /uploads/
// src のまま（認可・data:化は呼び出し側 route / 出力時に実施）。
// ---------------------------------------------------------------------------

/** 面積（Decimal 文字列）→ "62.45㎡"（空は ""）。 */
function fmtArea(v?: string | null): string {
  return v ? `${v}㎡` : "";
}
/** 整数 → 3桁区切り（"12000" → "12,000"）。 */
function fmtYen(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
/** 月額（円）→ "12,000円/月"（null は ""）。 */
function fmtYenMonth(n?: number | null): string {
  return n != null ? `${fmtYen(n)}円/月` : "";
}
/** 所在階 → "3階 / 全10階" などに整形。 */
function fmtFloor(floorNo?: number | null, totalFloors?: number | null): string {
  if (floorNo != null && totalFloors != null) return `${floorNo}階 / 全${totalFloors}階`;
  if (floorNo != null) return `${floorNo}階`;
  if (totalFloors != null) return `全${totalFloors}階`;
  return "";
}
/** 築年月：override（月精度）優先、無ければ建物の築年（"2015年"）。 */
function fmtBuiltYear(override?: string | null, builtYear?: number | null): string {
  if (override) return override;
  if (builtYear != null) return `${builtYear}年`;
  return "";
}
/** 総戸数（文字列）→ "12戸"（空は ""）。 */
function fmtUnits(v?: string | null): string {
  return v ? `${v}戸` : "";
}

/** 左カラム（表題・価格の下）に写真を最大3枚レイアウトする位置。 */
const PHOTO_LAYOUTS: Record<number, { x: number; y: number; w: number; h: number }[]> = {
  1: [{ x: 10, y: 46, w: 130, h: 110 }],
  2: [
    { x: 10, y: 46, w: 130, h: 74 },
    { x: 10, y: 124, w: 130, h: 62 },
  ],
  3: [
    { x: 10, y: 46, w: 130, h: 88 },
    { x: 10, y: 138, w: 63, h: 48 },
    { x: 77, y: 138, w: 63, h: 48 },
  ],
};
function photoElements(photos: { fileUrl: string }[] | undefined): SalesSheetElement[] {
  const list = (photos ?? []).slice(0, 3);
  const layout = PHOTO_LAYOUTS[list.length] ?? [];
  return list.map((ph, i) => ({
    id: `photo-${i + 1}`,
    type: "image" as const,
    x: layout[i].x,
    y: layout[i].y,
    w: layout[i].w,
    h: layout[i].h,
    z: 1,
    src: ph.fileUrl,
    fit: "cover" as const,
    radiusMm: 2,
    alt: "物件写真",
  }));
}

/** 表題 / 価格 / 概要表 / 会社帯 / 写真 の共通骨格（A4横）。 */
function baseSheet(
  title: string,
  price: string | undefined,
  rows: { label: string; value: string }[],
  photos: { fileUrl: string }[] | undefined,
): SalesSheetDocument {
  const elements: SalesSheetElement[] = [
    { id: "title", type: "text", x: 10, y: 8, w: 180, h: 10, z: 2,
      content: title, style: { fontSizePt: 16, bold: true, color: NAVY } },
    { id: "price-label", type: "text", x: 10, y: 22, w: 30, h: 8, z: 2,
      content: "価格", style: { fontSizePt: 10, color: "#888888" } },
    { id: "price", type: "text", x: 10, y: 28, w: 130, h: 14, z: 2,
      content: price ?? "", style: { fontSizePt: 26, bold: true, color: RED } },
    { id: "overview", type: "table", x: 150, y: 22, w: 137, h: 160, z: 1,
      rows, style: { fontSizePt: 9, borderColor: "#cccccc", labelColor: NAVY } },
    { id: "company", type: "text", x: 10, y: 192, w: 277, h: 10, z: 2,
      content: COMPANY, style: { fontSizePt: 9, color: NAVY } },
    ...photoElements(photos),
  ];
  return { page: A4_LANDSCAPE, theme: { fontFamily: FONT, accentColor: NAVY }, elements };
}

// ---- 売マンション（区分） ----
export interface SaleMansionOverrides {
  price?: string;
  access?: string;
  builtYearMonth?: string;
  structure?: string;
  transactionType?: string;
  deliveryTiming?: string;
  remarks?: string;
}
export interface SaleMansionInput {
  property: {
    address: string;
    roomNo?: string | null;
    exclusiveArea?: string | null;
    balconyArea?: string | null;
    layoutType?: string | null;
    floorNo?: number | null;
    orientation?: string | null;
    managementFee?: number | null;
    repairReserveFee?: number | null;
    zoningDistrict?: string | null;
    occupancyStatus?: string | null;
  };
  building?: {
    name?: string | null;
    totalFloors?: number | null;
    builtYear?: number | null;
    structureType?: string | null;
  } | null;
  photos?: { fileUrl: string }[];
  overrides?: SaleMansionOverrides;
}
export function buildSaleMansionDocument(input: SaleMansionInput): SalesSheetDocument {
  const o = input.overrides ?? {};
  const p = input.property;
  const b = input.building ?? {};
  const title = b.name ? `売マンション　${b.name}` : "売マンション";
  const rows = [
    row("所在地", p.address),
    row("部屋番号", p.roomNo),
    row("交通", o.access),
    row("専有面積", fmtArea(p.exclusiveArea)),
    row("バルコニー面積", fmtArea(p.balconyArea)),
    row("間取り", p.layoutType),
    row("所在階", fmtFloor(p.floorNo, b.totalFloors)),
    row("向き", p.orientation),
    row("築年月", fmtBuiltYear(o.builtYearMonth, b.builtYear)),
    row("構造", o.structure ?? b.structureType),
    row("管理費", fmtYenMonth(p.managementFee)),
    row("修繕積立金", fmtYenMonth(p.repairReserveFee)),
    row("用途地域", p.zoningDistrict),
    row("現況", localizeOccupancy(p.occupancyStatus)),
    row("引渡", o.deliveryTiming),
    row("取引態様", o.transactionType),
    row("備考", o.remarks),
  ];
  return baseSheet(title, o.price, rows, input.photos);
}

// ---- 売戸建 ----
export interface SaleHouseOverrides {
  price?: string;
  access?: string;
  landArea?: string;
  buildingArea?: string;
  builtYearMonth?: string;
  structure?: string;
  transactionType?: string;
  deliveryTiming?: string;
  remarks?: string;
}
export interface SaleHouseInput {
  property: {
    address: string;
    layoutType?: string | null;
    zoningDistrict?: string | null;
    buildingCoverageRatio?: string | null;
    floorAreaRatio?: string | null;
    roadType?: string | null;
    roadWidth?: string | null;
    occupancyStatus?: string | null;
  };
  photos?: { fileUrl: string }[];
  overrides?: SaleHouseOverrides;
}
export function buildSaleHouseDocument(input: SaleHouseInput): SalesSheetDocument {
  const o = input.overrides ?? {};
  const p = input.property;
  const rows = [
    row("所在地", p.address),
    row("交通", o.access),
    row("土地面積", o.landArea),
    row("建物面積", o.buildingArea),
    row("間取り", p.layoutType),
    row("築年月", o.builtYearMonth),
    row("構造", o.structure),
    row("用途地域", p.zoningDistrict),
    row("建蔽率・容積率", formatRatio(p.buildingCoverageRatio, p.floorAreaRatio)),
    row("接道", formatRoad(p.roadType, p.roadWidth)),
    row("現況", localizeOccupancy(p.occupancyStatus)),
    row("引渡", o.deliveryTiming),
    row("取引態様", o.transactionType),
    row("備考", o.remarks),
  ];
  return baseSheet("売戸建", o.price, rows, input.photos);
}

// ---- 一棟（マンション / アパート） ----
export interface SaleBuildingOverrides {
  price?: string;
  access?: string;
  landArea?: string;
  totalFloorArea?: string;
  totalUnits?: string;
  builtYearMonth?: string;
  structure?: string;
  grossYield?: string;
  expectedIncome?: string;
  transactionType?: string;
  deliveryTiming?: string;
  remarks?: string;
}
export interface SaleBuildingInput {
  property: {
    address: string;
    zoningDistrict?: string | null;
    buildingCoverageRatio?: string | null;
    floorAreaRatio?: string | null;
    roadType?: string | null;
    roadWidth?: string | null;
    occupancyStatus?: string | null;
  };
  kind?: "mansion" | "apartment";
  photos?: { fileUrl: string }[];
  overrides?: SaleBuildingOverrides;
}
export function buildSaleBuildingDocument(input: SaleBuildingInput): SalesSheetDocument {
  const o = input.overrides ?? {};
  const p = input.property;
  const title = input.kind === "apartment" ? "一棟アパート" : "一棟マンション";
  const rows = [
    row("所在地", p.address),
    row("交通", o.access),
    row("土地面積", o.landArea),
    row("延床面積", o.totalFloorArea),
    row("総戸数", fmtUnits(o.totalUnits)),
    row("築年月", o.builtYearMonth),
    row("構造", o.structure),
    row("用途地域", p.zoningDistrict),
    row("建蔽率・容積率", formatRatio(p.buildingCoverageRatio, p.floorAreaRatio)),
    row("接道", formatRoad(p.roadType, p.roadWidth)),
    row("想定利回り", o.grossYield),
    row("満室想定収入", o.expectedIncome),
    row("現況", localizeOccupancy(p.occupancyStatus)),
    row("引渡", o.deliveryTiming),
    row("取引態様", o.transactionType),
    row("備考", o.remarks),
  ];
  return baseSheet(title, o.price, rows, input.photos);
}
