import {
  A4_LANDSCAPE,
  type SalesSheetDocument,
  type SalesSheetElement,
} from "./document-schema";
import { inlineDocumentImages } from "./inline-images";
import { isSafeImageSrc } from "./css-safety";
import { getStorage } from "@/lib/storage";
import type { StorageAdapter } from "@/lib/storage/types";
import {
  mapOccupancyStatusToMansionOccupancy,
  mapOccupancyStatusToLandOccupancy,
} from "./occupancy";
import { MANSION_FIELDS, LAND_FIELDS, HOUSE_FIELDS, BUILDING_FIELDS } from "./field-model";
import { buildSheetRows, type SheetValues } from "./sheet-rows";
import { computeSpecSheetLayout, DEFAULT_FOOTER_H, type Rect } from "./layout-engine";
import { buildFooterBand, type FooterBandData } from "./footer-band";

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

// ---------------------------------------------------------------------------
// 全種別(売マンション/売土地/売戸建/一棟)を自社マイソク様式（buildSpecSheetDocument・
// キャッチ帯/写真+セールスポイント/全項目スペック表/会社フッター、field-model 駆動）で組む
// 純関数群（[F2-A/B/C] mansion→land→house→building の順で自社様式化・旧 baseSheet 骨格は撤去）。
// 写真は未展開の /uploads/ src のまま（認可・data:化は呼び出し側 route / 出力時に実施）。
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
/**
 * 面積 + 面積計測方式 → "150.5㎡（実測）"。方式未選択なら "150.5㎡"、面積が無ければ ""。
 * field-model の面積系フィールド（マンション専有面積/売土地土地面積）は unit を持たせず、
 * この関数が ㎡ を組み立てる（sheet-rows での二重付与を防ぐ・@codex P2 fix。
 * [F2-A Task3] fmtExclusiveArea を汎用化・マンション/土地共通ヘルパー）。
 * 現行の売土地ダイアログ（FIELD_SETS.land、Task4で作り込むまではプレーン自由入力）は
 * 単位付きで入力されうるため、合成前に末尾の「㎡」を一度剥がして二重付与を防ぐ
 * （@codex Important fix: "120.50㎡" → "120.50㎡㎡" になっていた）。
 */
function fmtAreaWithMethod(area?: string | null, method?: string | null): string {
  const trimmed = typeof area === "string" ? area.trim() : "";
  if (!trimmed) return "";
  const s = trimmed.endsWith("㎡") ? trimmed.slice(0, -"㎡".length) : trimmed;
  const m = typeof method === "string" ? method.trim() : "";
  return `${s}㎡${m ? `（${m}）` : ""}`;
}

/**
 * 値 + 単位 → "0.5m"/"12.3㎡"（値が無ければ ""）。単位そのものが選択式で意味が変わる
 * 項目（売土地のセットバック=m/㎡）に使う汎用ヘルパー（[F2-A Task3]）。
 * 値がすでに指定の単位で終わっている場合は付け直さない（@codex Important fix:
 * 現行の売土地ダイアログの自由入力で単位まで入力されると "0.5m" + "m" → "0.5mm" に
 * 二重化していた。unit の厳密な末尾一致のみで判定し、それ以外は従来どおり付与する）。
 */
function fmtValueWithUnit(value?: string | null, unit?: string | null): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return "";
  const u = typeof unit === "string" ? unit.trim() : "";
  if (u && s.endsWith(u)) return s;
  return `${s}${u}`;
}

/**
 * 価格文字列 → "3480万円"（すでに末尾が「万円」ならそのまま／付け直さない、空なら ""）。
 * 桁区切りカンマ等は付与しない＝price は自由入力文字列のまま扱う従来仕様を維持する
 * （"3480"→"3480万円"、"3,480"→"3,480万円"）。売マンション/売土地の priceText で
 * 共通利用し、両者の挙動を一致させる（@codex Important fix: 現行の売土地ダイアログは
 * プレーン自由入力のため "3,480万円" と単位まで入力されると "3,480万円万円" に
 * 二重化していた）。
 */
function fmtManYen(price?: string): string {
  const s = typeof price === "string" ? price.trim() : "";
  if (!s) return "";
  const stripped = s.endsWith("万円") ? s.slice(0, -"万円".length) : s;
  return `${stripped}万円`;
}

/**
 * 想定利回り → "7.8％"（末尾の %/％ を一度剥がして二重付与を防ぐ・空なら ""）。一棟の
 * 想定利回りは number フィールドだが、キャッシュ済みクライアントの自由入力で "7.8%"(半角)/
 * "7.8％"(全角) まで入力されうるため合成側で正規化する（[F2-C Task2]・fmtManYen /
 * fmtAreaWithMethod と同じ二重付与ガードの方針）。
 */
function fmtPercent(v?: string | null): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return "";
  const stripped = s.replace(/[%％]\s*$/, "").trimEnd();
  return stripped ? `${stripped}％` : "";
}

/**
 * 満室想定収入 → "980万円"（末尾の「万円/年」「万円」「/年」を一度剥がして二重付与を防ぐ・
 * 空なら ""）。number フィールドだが、本番稼働中の旧一棟ダイアログは "980万円/年" 形式で送る
 * ため（キャッシュ済みクライアント後方互換）合成側で正規化する。年額であることは field-model
 * のラベル「満室想定収入(年額)」で表す（@codex P2 fix・fmtPercent/fmtManYen と同方針）。
 */
function fmtAnnualIncome(v?: string | null): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return "";
  const stripped = s.replace(/(万円\s*\/\s*年|万円|\/\s*年)\s*$/, "").trim();
  return stripped ? `${stripped}万円` : "";
}

/**
 * 専有面積 + 面積計測方式(壁芯/内法) → "67.21㎡（壁芯）"。fmtAreaWithMethod のマンション向け
 * 別名（呼び出し箇所 buildMansionValues の意図を保つため名前を残す・[F2-A Task3] 汎用化）。
 */
function fmtExclusiveArea(area?: string | null, method?: string | null): string {
  return fmtAreaWithMethod(area, method);
}

/** 左カラム（表題・価格の下）に写真を最大3枚レイアウトする位置。座標は
 *  `computeSpecSheetLayout` が返す `photoSlots`（写真枚数・左右分割幅から決定的に
 *  算出）を使う（[Task2] 固定 PHOTO_LAYOUTS テーブルから移行）。 */
function photoElements(
  photos: { fileUrl: string }[] | undefined,
  slots: Rect[],
): SalesSheetElement[] {
  const list = (photos ?? []).slice(0, 3);
  return list.map((ph, i) => ({
    id: `photo-${i + 1}`,
    type: "image" as const,
    x: slots[i].x,
    y: slots[i].y,
    w: slots[i].w,
    h: slots[i].h,
    z: 1,
    src: ph.fileUrl,
    fit: "cover" as const,
    radiusMm: 2,
    alt: "物件写真",
  }));
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

/**
 * 種別非依存の版面パーツ。自社マイソク様式（キャッチ帯/見出し+価格/全項目スペック表/
 * セールスポイント/会社帯/写真/間取り枠）の入力を型で表す。
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
  /** 会社帯（取引態様/広告/報酬/担当/取引士/特記事項）。buildFooterBand(L.footer, …) へ渡す
   *  （[Task3] 旧 footerDetails:string を構造化・会社定数自体は COMPANY_INFO 固定）。 */
  footer?: FooterBandData;
  /** 間取り図（任意）。指定時のみキャッチ帯下にプレースホルダ画像を置く。 */
  floorPlanImage?: { fileUrl: string } | null;
}

/**
 * A4横 自社マイソク様式の版面レイアウトを種別非依存に組む純関数（[F2-A Task1]）。
 * catch-band/catch-copy/heading/price/overview表/sales-points/会社帯(footer-*・
 * buildFooterBand)/photos/floor-plan の要素構成・id・type・style種別・theme は不変
 * （[Task2] で座標算出を computeSpecSheetLayout へ委譲した後も同一。[Task3] でフッター2要素
 * →会社帯へ置換）。座標(x/y/w/h)と overview表の style.fontSizePt は、写真枚数・スペック表
 * 行数・間取り図有無からエンジンが決定的に算出する（build-mansion.test.ts 等のレイアウト
 * テストはこのエンジン出力を期待値として検証しており、固定値の特性化テストではない）。
 */
export function buildSpecSheetDocument(parts: SpecSheetParts): SalesSheetDocument {
  // レイアウト（座標/概要表フォント）は最適化エンジンに委譲する（[Task2]）。
  // 要素構成・id・type・style種別・themeは不変（このエンジン化の前後で同一）。
  const photos = (parts.photos ?? []).slice(0, 3);
  const L = computeSpecSheetLayout({
    photoCount: photos.length,
    specRowCount: parts.rows.length,
    hasFloorPlan: !!parts.floorPlanImage?.fileUrl,
    footerHeight: DEFAULT_FOOTER_H,
  });

  const salesPointsText = (parts.salesPoints ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `◆${s}`)
    .join("　");

  const elements: SalesSheetElement[] = [
    // キャッチ帯（全幅の上部バナー）。右スペック表はこの帯の下から始まるため重ならない。
    { id: "catch-band", type: "shape", x: L.catchBand.x, y: L.catchBand.y, w: L.catchBand.w, h: L.catchBand.h, z: 1,
      shape: "rect", fill: NAVY },
    { id: "catch-copy", type: "text", x: L.catchCopy.x, y: L.catchCopy.y, w: L.catchCopy.w, h: L.catchCopy.h, z: 2,
      content: parts.catchCopy ?? "", style: { fontSizePt: 13, bold: true, color: "#ffffff", align: "center" } },
    // 左上: 見出し（建物名+号室 等） / 価格（大）
    { id: "heading", type: "text", x: L.heading.x, y: L.heading.y, w: L.heading.w, h: L.heading.h, z: 2,
      content: parts.heading, style: { fontSizePt: 11, bold: true, color: NAVY } },
    { id: "price", type: "text", x: L.price.x, y: L.price.y, w: L.price.w, h: L.price.h, z: 2,
      content: parts.priceText, style: { fontSizePt: 20, bold: true, color: RED } },
    // 右: 全項目スペック表（行が多いほどエンジンが fontSize を下げ h を拡大）
    { id: "overview", type: "table", x: L.overview.x, y: L.overview.y, w: L.overview.w, h: L.overview.h, z: 1,
      rows: parts.rows, style: { fontSizePt: L.overview.fontSizePt, borderColor: "#cccccc", labelColor: NAVY } },
    // 写真下: セールスポイント（◆区切り）
    { id: "sales-points", type: "text", x: L.salesPoints.x, y: L.salesPoints.y, w: L.salesPoints.w, h: L.salesPoints.h, z: 2,
      content: salesPointsText, style: { fontSizePt: 9, bold: true, color: NAVY } },
    // 会社帯（下部・全幅）: 会社ブロック(COMPANY_INFO固定)＋取引条件/担当テーブル（[Task3]
    // 旧2text要素(company/company-details)から置換・~15要素は帯矩形 L.footer 内に収まる）。
    ...buildFooterBand(L.footer, parts.footer ?? {}),
    ...photoElements(photos, L.photoSlots),
  ];

  // 間取り枠: 提供時のみ、キャッチ帯下・写真上の隙間にプレースホルダ画像を置く（任意）。
  if (parts.floorPlanImage?.fileUrl && L.floorPlan) {
    elements.push({
      id: "floor-plan", type: "image", x: L.floorPlan.x, y: L.floorPlan.y, w: L.floorPlan.w, h: L.floorPlan.h, z: 1,
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
  const priceText = fmtManYen(o.price);

  return buildSpecSheetDocument({
    heading,
    priceText,
    rows,
    photos: input.photos,
    catchCopy: o.catchCopy,
    salesPoints: o.salesPoints,
    footer: {
      transactionType: o.transactionType,
      adType: o.adType,
      compensation: o.compensation,
      staff: o.staff,
      agent: o.agent,
      specialNotes: o.specialNotes,
    },
    floorPlanImage: input.floorPlanImage,
  });
}

// ---- 売土地 ----
// 自社マイソク様式（キャッチ帯/写真+セールスポイント/全項目スペック表/会社フッター）。
// スペック表の行は field-model(LAND_FIELDS) + sheet-rows(buildSheetRows) に委譲する
// （[F2-A Task3] 旧 baseSheet 版の buildSaleLandDocument を置換）。土地は消費税欄を
// 持たない（非課税・LAND_FIELDS に tax/taxAmount 無し）。
export interface SaleLandOverrides {
  /** 物件種目（売地/借地権/底地権）。DB propertyType は land 単一 enum で非1:1のため常に手入力。 */
  propertyType?: string;
  bestUse?: string;
  // 価格
  price?: string;
  unitPrice?: string;
  // 所在・交通
  access?: string;
  // 土地
  landArea?: string;
  areaMethod?: string;
  /**
   * 地目（複数選択）。field-model 上は multiselect(string[])。
   * 旧 API 契約（単一 string）を送る呼び出し側（legacy `sales-sheet/preview` route 等）との
   * 後方互換のため string も受け付け、buildLandValues 内で配列に正規化する（[F2-A Task3]）。
   */
  landCategory?: string[] | string;
  privateRoad?: string;
  terrain?: string;
  setback?: string;
  setbackUnit?: string;
  buildCondition?: string;
  // 法令
  roadDirections?: string[];
  /**
   * 接道幅員（override）。property.roadWidth（自動反映）より精度の高い値を手入力したい
   * 場合に優先される（mansion の builtYearMonth と同じ「override優先＋auto fallback」）。
   */
  roadWidth?: string;
  cityPlanning?: string[];
  landPermit?: string;
  /** 用途地域の追加選択（自動反映=zoningDistrict 1件 + これ）。 */
  useDistrict?: string[];
  areaZone?: string[];
  legalRestriction?: string;
  // 設備・現況
  equipment?: string;
  /**
   * 現況（更地/上物有）。override が無い場合のデフォルトは
   * `mapOccupancyStatusToLandOccupancy`（occupancy.ts）が occupancyStatus から決定的に
   * 写像する（mansion の occupancy と同じくフェッチのタイミングに依存しない）。
   */
  occupancy?: string;
  delivery?: string;
  /** @deprecated 旧キー名。`delivery` の別名として後方互換のみに残す（[F2-A Task3]）。 */
  deliveryTiming?: string;
  remarks?: string;
  // 会社（フッター。LAND_FIELDS の section:"会社" と対応）
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
  photos?: { fileUrl: string }[];
  /** @deprecated 単数写真（legacy `sales-sheet/preview` route 用）。新規呼び出しは
   *  複数対応の `photos` を使うこと（[F2-A Task3]）。両方指定時は `photos` を優先する。 */
  photo?: { fileUrl: string } | null;
  /** 間取り図（任意）。指定時のみキャッチ帯下にプレースホルダ画像を配置する。 */
  floorPlanImage?: { fileUrl: string } | null;
  overrides?: SaleLandOverrides;
}

/** LAND_FIELDS の会社セクション（フッター用）を除いたスペック表用フィールド。 */
const LAND_SPEC_FIELDS = LAND_FIELDS.filter((f) => f.section !== "会社");

/** property の自動反映値 + overrides から sheet-rows 用の values を組む。 */
function buildLandValues(input: SaleLandInput): SheetValues {
  const o = input.overrides ?? {};
  const p = input.property;

  // 用途地域: 自動反映(zoningDistrict) 1件 + overrides の追加選択（空は除外・mansion と同方式）。
  const useDistrict = [p.zoningDistrict, ...(o.useDistrict ?? [])].filter(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );
  // 地目: multiselect だが legacy 呼び出し側は単一 string を送りうるため配列へ正規化する。
  const landCategory = Array.isArray(o.landCategory)
    ? o.landCategory
    : o.landCategory
      ? [o.landCategory]
      : undefined;

  return {
    // 価格
    propertyType: o.propertyType,
    bestUse: o.bestUse,
    price: o.price,
    unitPrice: o.unitPrice,
    // 所在・交通
    address: p.address,
    access: o.access,
    // 土地: 土地面積は面積計測方式(公簿/実測)と、セットバックは単位(m/㎡)と合成した
    // 1つの表示値に組み立てる（field-model の landArea/setback は unit を持たないため、
    // sheet-rows 側での二重付与を防ぐ・fmtExclusiveArea と同じ理由）。
    landArea: fmtAreaWithMethod(o.landArea, o.areaMethod),
    areaMethod: o.areaMethod,
    landCategory,
    privateRoad: o.privateRoad,
    terrain: o.terrain,
    setback: fmtValueWithUnit(o.setback, o.setbackUnit),
    setbackUnit: o.setbackUnit,
    buildCondition: o.buildCondition,
    // 法令
    roadKind: p.roadType ?? undefined,
    roadWidth: o.roadWidth ?? p.roadWidth ?? undefined,
    roadDirections: o.roadDirections,
    cityPlanning: o.cityPlanning,
    landPermit: o.landPermit,
    useDistrict,
    areaZone: o.areaZone,
    coverageRatio: p.buildingCoverageRatio ?? undefined,
    floorRatio: p.floorAreaRatio ?? undefined,
    legalRestriction: o.legalRestriction,
    // 設備・現況
    equipment: o.equipment,
    // 現況: override 優先、無ければ occupancyStatus からの決定的写像（作成ダイアログの
    // 自動反映プレビューと同一関数＝フェッチのタイミングに依存しない）。
    occupancy: o.occupancy ?? mapOccupancyStatusToLandOccupancy(p.occupancyStatus),
    delivery: o.delivery ?? o.deliveryTiming,
    remarks: o.remarks,
  };
}

export function buildSaleLandDocument(input: SaleLandInput): SalesSheetDocument {
  const o = input.overrides ?? {};

  const values = buildLandValues(input);
  const rows = buildSheetRows(LAND_SPEC_FIELDS, values);

  const priceText = fmtManYen(o.price);
  // photos(複数)優先・無ければ legacy な photo(単数)を1枚配列として扱う。
  const photos = input.photos ?? (input.photo ? [input.photo] : undefined);

  return buildSpecSheetDocument({
    heading: "売土地",
    priceText,
    rows,
    photos,
    catchCopy: o.catchCopy,
    salesPoints: o.salesPoints,
    footer: {
      transactionType: o.transactionType,
      adType: o.adType,
      compensation: o.compensation,
      staff: o.staff,
      agent: o.agent,
      specialNotes: o.specialNotes,
    },
    floorPlanImage: input.floorPlanImage,
  });
}

/** DB データ → 写真を data: 展開済みの検証可能な document。 */
export async function buildInitialSalesSheetDocument(
  input: SaleLandInput,
): Promise<SalesSheetDocument> {
  return inlineDocumentImages(buildSaleLandDocument(input));
}

// ---- 売戸建 ----
// 自社マイソク様式（キャッチ帯/写真+セールスポイント/全項目スペック表/会社フッター）。
// スペック表の行は field-model(HOUSE_FIELDS) + sheet-rows(buildSheetRows) に委譲する
// （[F2-B Task2] 旧 baseSheet 版の buildSaleHouseDocument を置換）。マンションと同じく
// 消費税(課税/不課税)欄を持つ（土地と異なり戸建は課税対象）。house は building relation を
// 配線しない(現行踏襲)ため、建物構造/築年月/増改築年月/各階面積/地上階・地下階は
// 常に手入力（mansion のような building フォールバックを持たない）。
export interface SaleHouseOverrides {
  /** 物件種目（新築戸建/中古戸建等）。DB propertyType は house 単一 enum で非1:1のため常に手入力。 */
  propertyType?: string;
  // 価格
  price?: string;
  tax?: string;
  taxAmount?: string;
  // 所在・交通
  access?: string;
  // 土地
  landArea?: string;
  areaMethod?: string;
  landRight?: string;
  privateRoad?: string;
  /** 地目（複数選択）。field-model 上は multiselect(string[])。 */
  landCategory?: string[];
  setback?: string;
  setbackUnit?: string;
  terrain?: string;
  // 建物
  buildingArea?: string;
  floor1Area?: string;
  floor2Area?: string;
  floor3Area?: string;
  /** 建物構造。house に building relation を配線しないため常に手入力（現行踏襲）。 */
  structure?: string;
  aboveFloors?: string;
  basementFloors?: string;
  parking?: string;
  /** 築年月。house に building relation を配線しないため常に手入力（現行踏襲）。 */
  builtYearMonth?: string;
  renovYearMonth?: string;
  // 法令
  roadDirections?: string[];
  /**
   * 接道幅員（override）。property.roadWidth（自動反映）より精度の高い値を手入力したい
   * 場合に優先される（LAND_FIELDS.roadWidth と同じ「override優先＋auto fallback」）。
   */
  roadWidth?: string;
  cityPlanning?: string[];
  /** 用途地域の追加選択（自動反映=zoningDistrict 1件 + これ）。 */
  useDistrict?: string[];
  areaZone?: string[];
  buildingConfirm?: string;
  rebuild?: string;
  legalRestriction?: string;
  // 設備・現況
  equipment?: string;
  /**
   * 現況（居住中/空家/賃貸中/未完成）。override が無い場合のデフォルトは
   * `mapOccupancyStatusToMansionOccupancy`（occupancy.ts）が occupancyStatus から
   * 決定的に写像する（戸建の現況語彙はマンションと同一のため再利用）。
   * override があれば常にそれを優先する。
   */
  occupancy?: string;
  delivery?: string;
  /** @deprecated 旧キー名。`delivery` の別名として後方互換のみに残す（LAND_FIELDS と同じ経緯）。 */
  deliveryTiming?: string;
  remarks?: string;
  // 会社（フッター。HOUSE_FIELDS の section:"会社" と対応）
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
  /** 間取り図（任意）。指定時のみキャッチ帯下にプレースホルダ画像を配置する。 */
  floorPlanImage?: { fileUrl: string } | null;
  overrides?: SaleHouseOverrides;
}

/** HOUSE_FIELDS の会社セクション（フッター用）を除いたスペック表用フィールド。 */
const HOUSE_SPEC_FIELDS = HOUSE_FIELDS.filter((f) => f.section !== "会社");

/** property の自動反映値 + overrides から sheet-rows 用の values を組む。 */
function buildHouseValues(input: SaleHouseInput): SheetValues {
  const o = input.overrides ?? {};
  const p = input.property;

  // 用途地域: 自動反映(zoningDistrict) 1件 + overrides の追加選択（空は除外・mansion/land と同方式）。
  const useDistrict = [p.zoningDistrict, ...(o.useDistrict ?? [])].filter(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );

  return {
    // 価格
    propertyType: o.propertyType,
    price: o.price,
    tax: o.tax,
    taxAmount: o.taxAmount,
    // 所在・交通
    address: p.address,
    access: o.access,
    // 土地: 土地面積は面積計測方式(公簿/実測)と、セットバックは単位(m/㎡)と合成した
    // 1つの表示値に組み立てる（field-model の landArea/setback は unit を持たないため、
    // sheet-rows 側での二重付与を防ぐ・buildLandValues と同じ理由）。
    landArea: fmtAreaWithMethod(o.landArea, o.areaMethod),
    areaMethod: o.areaMethod,
    landRight: o.landRight,
    privateRoad: o.privateRoad,
    landCategory: o.landCategory,
    setback: fmtValueWithUnit(o.setback, o.setbackUnit),
    setbackUnit: o.setbackUnit,
    terrain: o.terrain,
    // 建物: house は building relation を配線しない（現行踏襲）ため、建物構造/築年月/
    // 増改築年月/各階面積/地上階・地下階は常に手入力（mansion のような building
    // フォールバックを持たない）。
    buildingArea: o.buildingArea,
    floor1Area: o.floor1Area,
    floor2Area: o.floor2Area,
    floor3Area: o.floor3Area,
    structure: o.structure,
    aboveFloors: o.aboveFloors,
    basementFloors: o.basementFloors,
    layout: p.layoutType ?? undefined,
    parking: o.parking,
    builtYearMonth: o.builtYearMonth,
    renovYearMonth: o.renovYearMonth,
    // 法令
    roadKind: p.roadType ?? undefined,
    roadWidth: o.roadWidth ?? p.roadWidth ?? undefined,
    roadDirections: o.roadDirections,
    cityPlanning: o.cityPlanning,
    useDistrict,
    areaZone: o.areaZone,
    coverageRatio: p.buildingCoverageRatio ?? undefined,
    floorRatio: p.floorAreaRatio ?? undefined,
    buildingConfirm: o.buildingConfirm,
    rebuild: o.rebuild,
    legalRestriction: o.legalRestriction,
    // 設備・現況
    equipment: o.equipment,
    // 現況: override 優先、無ければ occupancyStatus からの決定的写像（戸建の現況語彙は
    // マンションと同一のため mapOccupancyStatusToMansionOccupancy を再利用。作成ダイアログの
    // 自動反映プレビューと同一関数＝フェッチのタイミングに依存しない）。
    occupancy: o.occupancy ?? mapOccupancyStatusToMansionOccupancy(p.occupancyStatus),
    delivery: o.delivery ?? o.deliveryTiming,
    remarks: o.remarks,
    // 会社（フッター）
    transactionType: o.transactionType,
    compensation: o.compensation,
    adType: o.adType,
    staff: o.staff,
    agent: o.agent,
    specialNotes: o.specialNotes,
  };
}

export function buildSaleHouseDocument(input: SaleHouseInput): SalesSheetDocument {
  const o = input.overrides ?? {};

  const values = buildHouseValues(input);
  const rows = buildSheetRows(HOUSE_SPEC_FIELDS, values);

  const priceText = fmtManYen(o.price);

  return buildSpecSheetDocument({
    heading: "売戸建",
    priceText,
    rows,
    photos: input.photos,
    catchCopy: o.catchCopy,
    salesPoints: o.salesPoints,
    footer: {
      transactionType: o.transactionType,
      adType: o.adType,
      compensation: o.compensation,
      staff: o.staff,
      agent: o.agent,
      specialNotes: o.specialNotes,
    },
    floorPlanImage: input.floorPlanImage,
  });
}

// ---- 一棟（マンション / アパート） ----
// 自社マイソク様式（キャッチ帯/写真+セールスポイント/全項目スペック表/会社フッター）。
// スペック表の行は field-model(BUILDING_FIELDS) + sheet-rows(buildSheetRows) に委譲する
// （[F2-C Task2] 旧 baseSheet 版の buildSaleBuildingDocument を置換）。売戸建と同じく消費税
// (課税/不課税)欄を持ち、加えて収益系(総戸数/想定利回り/満室想定収入)・付帯権利を持つ。
// house 同様 building relation は配線しない(現行踏襲)ため構造/築年月/収益系は常に手入力。
// 見出しは kind により一棟マンション/一棟アパートに二分岐する（route が propertyType から決定）。
export interface SaleBuildingOverrides {
  /** 物件種目（一棟マンション/一棟アパート/一棟ビル等）。DB propertyType とは非1:1のため常に手入力。 */
  propertyType?: string;
  // 価格
  price?: string;
  tax?: string;
  taxAmount?: string;
  // 所在・交通
  access?: string;
  // 土地
  landArea?: string;
  areaMethod?: string;
  /** 付帯権利（LAND_RIGHT を再利用）。 */
  landRight?: string;
  privateRoad?: string;
  /** 地目（複数選択）。field-model 上は multiselect(string[])。 */
  landCategory?: string[];
  setback?: string;
  setbackUnit?: string;
  terrain?: string;
  // 建物（building relation 非配線=現行踏襲のため常に手入力）
  totalFloorArea?: string;
  structure?: string;
  aboveFloors?: string;
  basementFloors?: string;
  builtYearMonth?: string;
  renovYearMonth?: string;
  parking?: string;
  // 収益（一棟固有）
  totalUnits?: string;
  grossYield?: string;
  expectedIncome?: string;
  // 法令
  roadDirections?: string[];
  /** 接道幅員（override）。property.roadWidth より精度の高い値を手入力する場合に優先。 */
  roadWidth?: string;
  cityPlanning?: string[];
  /** 用途地域の追加選択（自動反映=zoningDistrict 1件 + これ）。 */
  useDistrict?: string[];
  areaZone?: string[];
  buildingConfirm?: string;
  rebuild?: string;
  legalRestriction?: string;
  // 設備・現況
  equipment?: string;
  /**
   * 現況（居住中/空家/賃貸中/未完成）。override が無い場合のデフォルトは
   * `mapOccupancyStatusToMansionOccupancy`（occupancy.ts）が occupancyStatus から決定的に
   * 写像する（一棟の現況語彙はマンション/戸建と同一のため再利用）。override 優先。
   */
  occupancy?: string;
  delivery?: string;
  /** @deprecated 旧キー名。`delivery` の別名として後方互換のみに残す（house/land と同じ経緯）。 */
  deliveryTiming?: string;
  remarks?: string;
  // 会社（フッター。BUILDING_FIELDS の section:"会社" と対応）
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
  /** DB propertyType(apartment_building/apartment_block)由来。見出しの二分岐に使う（route が決定）。 */
  kind?: "mansion" | "apartment";
  photos?: { fileUrl: string }[];
  /** 間取り図（任意）。指定時のみキャッチ帯下にプレースホルダ画像を配置する。 */
  floorPlanImage?: { fileUrl: string } | null;
  overrides?: SaleBuildingOverrides;
}

/** BUILDING_FIELDS の会社セクション（フッター用）を除いたスペック表用フィールド。 */
const BUILDING_SPEC_FIELDS = BUILDING_FIELDS.filter((f) => f.section !== "会社");

/** property の自動反映値 + overrides から sheet-rows 用の values を組む。 */
function buildBuildingValues(input: SaleBuildingInput): SheetValues {
  const o = input.overrides ?? {};
  const p = input.property;

  // 用途地域: 自動反映(zoningDistrict) 1件 + overrides の追加選択（空は除外・他種別と同方式）。
  const useDistrict = [p.zoningDistrict, ...(o.useDistrict ?? [])].filter(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );

  return {
    // 価格
    propertyType: o.propertyType,
    price: o.price,
    tax: o.tax,
    taxAmount: o.taxAmount,
    // 所在・交通
    address: p.address,
    access: o.access,
    // 土地: 土地面積は面積計測方式(公簿/実測)と、セットバックは単位(m/㎡)と合成した
    // 1つの表示値に組み立てる（field-model の landArea/setback は unit を持たないため、
    // sheet-rows 側での二重付与を防ぐ・buildHouseValues と同じ理由）。
    landArea: fmtAreaWithMethod(o.landArea, o.areaMethod),
    areaMethod: o.areaMethod,
    landRight: o.landRight,
    privateRoad: o.privateRoad,
    landCategory: o.landCategory,
    setback: fmtValueWithUnit(o.setback, o.setbackUnit),
    setbackUnit: o.setbackUnit,
    terrain: o.terrain,
    // 建物: building relation 非配線=現行踏襲のため常に手入力。各階面積は持たず延床面積で表す。
    totalFloorArea: o.totalFloorArea,
    structure: o.structure,
    aboveFloors: o.aboveFloors,
    basementFloors: o.basementFloors,
    builtYearMonth: o.builtYearMonth,
    renovYearMonth: o.renovYearMonth,
    parking: o.parking,
    // 収益: 想定利回り(%)/満室想定収入(万円)は field-model に unit を持たせず、ここで合成する
    // （キャッシュ済みクライアントの単位付き自由入力での二重付与を防ぐ）。総戸数は unit"戸"で
    // sheet-rows が付与する（旧 fmtUnits 相当）。
    totalUnits: o.totalUnits,
    grossYield: fmtPercent(o.grossYield),
    expectedIncome: fmtAnnualIncome(o.expectedIncome),
    // 法令
    roadKind: p.roadType ?? undefined,
    roadWidth: o.roadWidth ?? p.roadWidth ?? undefined,
    roadDirections: o.roadDirections,
    cityPlanning: o.cityPlanning,
    useDistrict,
    areaZone: o.areaZone,
    coverageRatio: p.buildingCoverageRatio ?? undefined,
    floorRatio: p.floorAreaRatio ?? undefined,
    buildingConfirm: o.buildingConfirm,
    rebuild: o.rebuild,
    legalRestriction: o.legalRestriction,
    // 設備・現況
    equipment: o.equipment,
    // 現況: override 優先、無ければ occupancyStatus からの決定的写像（一棟の現況語彙は
    // マンション/戸建と同一のため mapOccupancyStatusToMansionOccupancy を再利用。作成
    // ダイアログの自動反映プレビューと同一関数＝フェッチのタイミングに依存しない）。
    occupancy: o.occupancy ?? mapOccupancyStatusToMansionOccupancy(p.occupancyStatus),
    delivery: o.delivery ?? o.deliveryTiming,
    remarks: o.remarks,
    // 会社（フッター）
    transactionType: o.transactionType,
    compensation: o.compensation,
    adType: o.adType,
    staff: o.staff,
    agent: o.agent,
    specialNotes: o.specialNotes,
  };
}

export function buildSaleBuildingDocument(input: SaleBuildingInput): SalesSheetDocument {
  const o = input.overrides ?? {};

  const values = buildBuildingValues(input);
  const rows = buildSheetRows(BUILDING_SPEC_FIELDS, values);

  // 見出し: kind により二分岐（apartment=一棟アパート・それ以外/未指定=一棟マンション）。
  const heading = input.kind === "apartment" ? "一棟アパート" : "一棟マンション";
  const priceText = fmtManYen(o.price);

  return buildSpecSheetDocument({
    heading,
    priceText,
    rows,
    photos: input.photos,
    catchCopy: o.catchCopy,
    salesPoints: o.salesPoints,
    footer: {
      transactionType: o.transactionType,
      adType: o.adType,
      compensation: o.compensation,
      staff: o.staff,
      agent: o.agent,
      specialNotes: o.specialNotes,
    },
    floorPlanImage: input.floorPlanImage,
  });
}
