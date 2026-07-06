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
import { mapOccupancyStatusToMansionOccupancy } from "./occupancy";
import { MANSION_FIELDS } from "./field-model";
import { buildSheetRows, type SheetValues } from "./sheet-rows";

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

/** 整数 → 3桁区切り（"12000" → "12,000"）。 */
function fmtYen(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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
/**
 * 専有面積 + 面積計測方式(壁芯/内法) → "67.21㎡（壁芯）"。
 * 方式未選択なら "67.21㎡"、面積が無ければ ""。field-model の exclusiveArea は
 * unit を持たないため、㎡ もここで組み立てる（sheet-rows での二重付与を防ぐ・@codex P2 fix）。
 */
function fmtExclusiveArea(area?: string | null, method?: string | null): string {
  const s = typeof area === "string" ? area.trim() : "";
  if (!s) return "";
  const m = typeof method === "string" ? method.trim() : "";
  return `${s}㎡${m ? `（${m}）` : ""}`;
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
// 自社マイソク様式（キャッチ帯/写真+セールスポイント/間取り枠/全項目スペック表/会社フッター）。
// スペック表の行は field-model(MANSION_FIELDS) + sheet-rows(buildSheetRows) に委譲する。
export interface SaleMansionOverrides {
  /**
   * 物件種目（新築マンション/中古マンション等）。field-model 上は autoFrom:"propertyType"
   * だが、DB の propertyType enum（apartment_unit 等）は新築/中古・種別軸が異なり
   * 1:1 で写像できないため自動反映せず、常に手入力のみ（Task4 で判断を持ち越し・Task5 で確定）。
   */
  propertyType?: string;
  // 価格
  price?: string;
  unitPrice?: string;
  tax?: string;
  taxAmount?: string;
  // 所在・交通
  access?: string;
  // 土地・権利
  siteArea?: string;
  siteRightRatio?: string;
  landRight?: string;
  /** 用途地域の追加選択（自動反映=zoningDistrict 1件 + これ）。 */
  useDistrict?: string[];
  areaMethod?: string;
  // 建物
  basementFloors?: string;
  /** 築年月（月精度）。無ければ building.builtYear（年精度）へフォールバック。 */
  builtYearMonth?: string;
  parking?: string;
  parkingFee?: string;
  // 設備・現況・管理
  equipment?: string;
  legalRestriction?: string;
  managementUnion?: string;
  managementForm?: string;
  managerStatus?: string;
  developer?: string;
  builder?: string;
  /**
   * 現況（居住中/空家/賃貸中/未完成）。override が無い場合のデフォルトは
   * `mapOccupancyStatusToMansionOccupancy`（occupancy.ts）が occupancyStatus から
   * 決定的に写像する（vacant→空家/occupied→居住中、他は localizeOccupancy 相当）。
   * 作成ダイアログの自動反映プレビューも同じ関数を使うため、フェッチの成否・
   * タイミングに関わらず override 未指定時は常に同じ現況になる（@codex P2 fix）。
   * override があれば常にそれを優先する。
   */
  occupancy?: string;
  delivery?: string;
  remarks?: string;
  // 会社（フッター。MANSION_FIELDS の section:"会社" と対応）
  transactionType?: string;
  compensation?: string;
  adType?: string;
  staff?: string;
  agent?: string;
  specialNotes?: string;
  // レイアウト専用（field-model の行ではない、キャッチ帯/セールスポイントの見出し文言）
  catchCopy?: string;
  salesPoints?: string[];
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
    managementCompany?: string | null;
    totalUnits?: number | null;
  } | null;
  photos?: { fileUrl: string }[];
  /** 間取り図（任意）。指定時のみ中央にプレースホルダ画像を配置する。 */
  floorPlanImage?: { fileUrl: string } | null;
  overrides?: SaleMansionOverrides;
}

/** MANSION_FIELDS の会社セクション（フッター用）を除いたスペック表用フィールド。 */
const MANSION_SPEC_FIELDS = MANSION_FIELDS.filter((f) => f.section !== "会社");

/** property/building の自動反映値 + overrides から sheet-rows 用の values を組む。 */
function buildMansionValues(input: SaleMansionInput): SheetValues {
  const o = input.overrides ?? {};
  const p = input.property;
  const b = input.building ?? {};

  // 用途地域: 自動反映(zoningDistrict) 1件 + overrides の追加選択（空は除外）。
  const useDistrict = [p.zoningDistrict, ...(o.useDistrict ?? [])].filter(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );

  return {
    // 価格・費用（管理費/修繕積立金は自動反映のみ・price/unitPrice/tax/taxAmountは手入力のみ）
    // propertyType: 自動反映元なし（DB enum が語彙不一致のため常に手入力=override のみ）。
    propertyType: o.propertyType,
    buildingName: b.name ?? undefined,
    price: o.price,
    unitPrice: o.unitPrice,
    tax: o.tax,
    taxAmount: o.taxAmount,
    managementFee: p.managementFee != null ? fmtYen(p.managementFee) : undefined,
    repairFee: p.repairReserveFee != null ? fmtYen(p.repairReserveFee) : undefined,
    // 所在・交通
    address: p.address,
    access: o.access,
    // 土地・権利
    siteArea: o.siteArea,
    siteRightRatio: o.siteRightRatio,
    landRight: o.landRight,
    useDistrict,
    // 建物
    areaMethod: o.areaMethod,
    // 専有面積: 面積計測方式(壁芯/内法)を括弧書きで併記して1つの表示値に合成する
    // （field-model.exclusiveArea は unit を持たないため ㎡ もここで付与する）。
    exclusiveArea: fmtExclusiveArea(p.exclusiveArea, o.areaMethod),
    balconyArea: p.balconyArea ?? undefined,
    balconyDir: p.orientation ?? undefined,
    layout: p.layoutType ?? undefined,
    structure: b.structureType ?? undefined,
    floorNo: p.floorNo != null ? String(p.floorNo) : undefined,
    totalFloors: b.totalFloors != null ? String(b.totalFloors) : undefined,
    basementFloors: o.basementFloors,
    builtYearMonth: fmtBuiltYear(o.builtYearMonth, b.builtYear),
    totalUnits: b.totalUnits != null ? String(b.totalUnits) : undefined,
    parking: o.parking,
    parkingFee: o.parkingFee,
    // 設備・現況・管理
    equipment: o.equipment,
    legalRestriction: o.legalRestriction,
    managementUnion: o.managementUnion,
    managementForm: o.managementForm,
    managerStatus: o.managerStatus,
    managementCompany: b.managementCompany ?? undefined,
    developer: o.developer,
    builder: o.builder,
    // 現況: override 優先（マイソク語彙での手動選択/訂正）、無ければ occupancyStatus からの
    // 決定的写像（作成ダイアログの自動反映プレビューと同一関数＝フェッチのタイミングに
    // 依存しない・@codex P2 fix）。
    occupancy: o.occupancy ?? mapOccupancyStatusToMansionOccupancy(p.occupancyStatus),
    delivery: o.delivery,
    remarks: o.remarks,
  };
}

/** 会社フッター2行目（取引態様/報酬/広告/担当/取引士/特記）。未入力の項目は落とす。 */
function mansionFooterDetails(o: SaleMansionOverrides): string {
  return [
    o.transactionType && `取引態様：${o.transactionType}`,
    o.compensation && `報酬：${o.compensation}`,
    o.adType && `広告：${o.adType}`,
    o.staff && `担当：${o.staff}`,
    o.agent && `取引士：${o.agent}`,
    o.specialNotes && `特記：${o.specialNotes}`,
  ]
    .filter(Boolean)
    .join("　");
}

/**
 * 種別非依存の版面パーツ。自社マイソク様式（キャッチ帯/見出し+価格/全項目スペック表/
 * セールスポイント/会社フッター2行/写真/間取り枠）の入力を型で表す。
 * `buildSpecSheetDocument` の唯一の引数（[F2-A Task1] buildSaleMansionDocument から抽出）。
 */
export interface SpecSheetParts {
  /** 左上見出し（建物名+号室 / 「売土地」等）。 */
  heading: string;
  /** 例 "6590万円"（空可）。 */
  priceText: string;
  /** スペック表の行。 */
  rows: { label: string; value: string }[];
  photos?: { fileUrl: string }[];
  catchCopy?: string;
  /** ◆区切りで結合して sales-points 要素に表示。 */
  salesPoints?: string[];
  /** 会社フッター2行目（取引態様/報酬/…）。 */
  footerDetails?: string;
  /** 間取り図（任意）。指定時のみキャッチ帯下にプレースホルダ画像を置く。 */
  floorPlanImage?: { fileUrl: string } | null;
}

/**
 * A4横 自社マイソク様式の版面レイアウトを種別非依存に組む純関数（[F2-A Task1]）。
 * catch-band/catch-copy/heading/price/overview表/sales-points/company/company-details/
 * photos/floor-plan の要素構成・座標・スタイルは、抽出前の buildSaleMansionDocument と
 * 同一（出力不変・build-mansion.test.ts の特性化テストで固定）。
 */
export function buildSpecSheetDocument(parts: SpecSheetParts): SalesSheetDocument {
  const salesPointsText = (parts.salesPoints ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `◆${s}`)
    .join("　");

  const elements: SalesSheetElement[] = [
    // キャッチ帯（全幅の上部バナー）。右スペック表はこの帯の下から始まるため重ならない。
    { id: "catch-band", type: "shape", x: 10, y: 8, w: 277, h: 16, z: 1,
      shape: "rect", fill: NAVY },
    { id: "catch-copy", type: "text", x: 16, y: 8, w: 265, h: 16, z: 2,
      content: parts.catchCopy ?? "", style: { fontSizePt: 13, bold: true, color: "#ffffff", align: "center" } },
    // 左上: 見出し（建物名+号室 等） / 価格（大）
    { id: "heading", type: "text", x: 10, y: 26, w: 94, h: 7, z: 2,
      content: parts.heading, style: { fontSizePt: 11, bold: true, color: NAVY } },
    { id: "price", type: "text", x: 10, y: 33, w: 94, h: 12, z: 2,
      content: parts.priceText, style: { fontSizePt: 20, bold: true, color: RED } },
    // 右: 全項目スペック表（行が多いため fontSize を下げ h を拡大）
    { id: "overview", type: "table", x: 150, y: 26, w: 137, h: 167, z: 1,
      rows: parts.rows, style: { fontSizePt: 7, borderColor: "#cccccc", labelColor: NAVY } },
    // 写真下: セールスポイント（◆区切り）
    { id: "sales-points", type: "text", x: 10, y: 187, w: 136, h: 7, z: 2,
      content: salesPointsText, style: { fontSizePt: 9, bold: true, color: NAVY } },
    // 会社フッター（下部帯・全幅）: 1行目=会社定数、2行目=種別ごとの詳細（取引態様/報酬/…）
    { id: "company", type: "text", x: 10, y: 195, w: 277, h: 6, z: 2,
      content: COMPANY, style: { fontSizePt: 9, color: NAVY } },
    { id: "company-details", type: "text", x: 10, y: 201, w: 277, h: 7, z: 2,
      content: parts.footerDetails ?? "", style: { fontSizePt: 8, color: NAVY } },
    ...photoElements(parts.photos),
  ];

  // 間取り枠: 提供時のみ、キャッチ帯下・写真上の隙間にプレースホルダ画像を置く（任意）。
  if (parts.floorPlanImage?.fileUrl) {
    elements.push({
      id: "floor-plan", type: "image", x: 108, y: 26, w: 32, h: 18, z: 1,
      src: parts.floorPlanImage.fileUrl, fit: "contain", alt: "間取り図",
    });
  }

  return { page: A4_LANDSCAPE, theme: { fontFamily: FONT, accentColor: NAVY }, elements };
}

export function buildSaleMansionDocument(input: SaleMansionInput): SalesSheetDocument {
  const o = input.overrides ?? {};
  const p = input.property;
  const b = input.building ?? {};

  const values = buildMansionValues(input);
  const rows = buildSheetRows(MANSION_SPEC_FIELDS, values);

  const heading = [b.name, p.roomNo ? `${p.roomNo}号室` : null].filter(Boolean).join("　");
  const priceText = o.price ? `${o.price}万円` : "";

  return buildSpecSheetDocument({
    heading,
    priceText,
    rows,
    photos: input.photos,
    catchCopy: o.catchCopy,
    salesPoints: o.salesPoints,
    footerDetails: mansionFooterDetails(o),
    floorPlanImage: input.floorPlanImage,
  });
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
