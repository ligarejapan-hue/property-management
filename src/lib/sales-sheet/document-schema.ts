import { z } from "zod";
import { isSafeImageSrc, isCssColor, isSafeFontFamily } from "./css-safety";

export { isSafeImageSrc };

/** 幾何は mm。フォントサイズのみ pt。z は重ね順(整数)。 */
const baseElement = {
  id: z.string().min(1),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  z: z.number().int(),
};

export const textElementSchema = z.object({
  ...baseElement,
  type: z.literal("text"),
  content: z.string(),
  style: z
    .object({
      fontSizePt: z.number().positive().optional(),
      fontFamily: z.string().refine(isSafeFontFamily, "unsafe font-family").optional(),
      color: z.string().refine(isCssColor, "unsafe color").optional(),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      underline: z.boolean().optional(),
      align: z.enum(["left", "center", "right"]).optional(),
      lineHeight: z.number().positive().optional(),
    })
    .default({}),
});

export const imageElementSchema = z.object({
  ...baseElement,
  type: z.literal("image"),
  src: z.string().min(1).refine(isSafeImageSrc, "unsafe image src"),
  fit: z.enum(["cover", "contain"]).default("cover"),
  radiusMm: z.number().nonnegative().optional(),
  alt: z.string().optional(),
  /** 焦点位置(%)。cover トリミング時に見せる位置。既定は中央(50,50)。
   *  CSS object-position に反映（数値のみ＝注入不可）。 */
  focalX: z.number().min(0).max(100).optional(),
  focalY: z.number().min(0).max(100).optional(),
});

export const tableElementSchema = z.object({
  ...baseElement,
  type: z.literal("table"),
  rows: z.array(z.object({ label: z.string(), value: z.string() })),
  style: z
    .object({
      fontSizePt: z.number().positive().optional(),
      labelColor: z.string().refine(isCssColor, "unsafe color").optional(),
      valueColor: z.string().refine(isCssColor, "unsafe color").optional(),
      borderColor: z.string().refine(isCssColor, "unsafe color").optional(),
      /** 罫線を出さない(消費者向けひな型)。未指定=従来どおり罫線あり。 */
      borderless: z.boolean().optional(),
      /**
       * 行の間隔を均等に広げて枠の底まで埋める(消費者向けひな型の主要表)。borderless の
       * 表にのみ効く。行数が少ない表(詳細表)に付けると間延びするため opt-in。
       */
      fillHeight: z.boolean().optional(),
      /** 偶数行(2,4,…行目)のセル背景色。 */
      stripeColor: z.string().refine(isCssColor, "unsafe color").optional(),
      /** セル余白(mm)。上下=値・左右=値×1.2。未指定=0.5mm 1mm。 */
      cellPaddingMm: z.number().nonnegative().optional(),
    })
    .default({}),
});

export const badgeElementSchema = z.object({
  ...baseElement,
  type: z.literal("badge"),
  label: z.string(),
  shape: z.enum(["rounded", "pill", "ribbon"]).default("rounded"),
  bg: z.string().refine(isCssColor, "unsafe color"),
  fg: z.string().refine(isCssColor, "unsafe color"),
  fontSizePt: z.number().positive().optional(),
});

export const shapeElementSchema = z.object({
  ...baseElement,
  type: z.literal("shape"),
  shape: z.enum(["rect", "line"]).default("rect"),
  fill: z.string().refine(isCssColor, "unsafe color").optional(),
  stroke: z.string().refine(isCssColor, "unsafe color").optional(),
  strokeWidthMm: z.number().nonnegative().optional(),
  radiusMm: z.number().nonnegative().optional(),
});

export const qrElementSchema = z.object({
  ...baseElement,
  type: z.literal("qr"),
  /** 生成済みQR画像の data URL。 */
  dataUrl: z.string().min(1).refine((s) => s.startsWith("data:image/"), "qr dataUrl must be a data:image URL"),
  /** QR の中身（URL 等）。エディタでの再編集→再生成用の元テキスト（任意・後方互換）。 */
  content: z.string().optional(),
});

export const elementSchema = z.discriminatedUnion("type", [
  textElementSchema,
  imageElementSchema,
  tableElementSchema,
  badgeElementSchema,
  shapeElementSchema,
  qrElementSchema,
]);

export const pageSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  orientation: z.enum(["landscape", "portrait"]),
});

/** 消費者向けひな型(2026-09)で作った図面の目印。無い図面は旧ひな型。 */
export const CONSUMER_TEMPLATE = "consumer-2026-09" as const;

export const themeSchema = z.object({
  fontFamily: z.string().refine(isSafeFontFamily, "unsafe font-family"),
  accentColor: z.string().refine(isCssColor, "unsafe color"),
  template: z.literal(CONSUMER_TEMPLATE).optional(),
});

export const salesSheetDocumentSchema = z.object({
  page: pageSchema,
  theme: themeSchema,
  elements: z.array(elementSchema),
});

export type TextElement = z.infer<typeof textElementSchema>;
export type ImageElement = z.infer<typeof imageElementSchema>;
export type TableElement = z.infer<typeof tableElementSchema>;
export type BadgeElement = z.infer<typeof badgeElementSchema>;
export type ShapeElement = z.infer<typeof shapeElementSchema>;
export type QrElement = z.infer<typeof qrElementSchema>;
export type SalesSheetElement = z.infer<typeof elementSchema>;
export type SalesSheetPage = z.infer<typeof pageSchema>;
export type SalesSheetTheme = z.infer<typeof themeSchema>;
export type SalesSheetDocument = z.infer<typeof salesSheetDocumentSchema>;

/** A4 横（既定）/ A4 縦。 */
export const A4_LANDSCAPE: SalesSheetPage = { width: 297, height: 210, orientation: "landscape" };
export const A4_PORTRAIT: SalesSheetPage = { width: 210, height: 297, orientation: "portrait" };

export function parseSalesSheetDocument(input: unknown): SalesSheetDocument {
  return salesSheetDocumentSchema.parse(input);
}

/** 消費者向けひな型で作った図面か(自動整列などの新しい計算が使えるか)。 */
export function isConsumerTemplate(doc: { theme: { template?: string } }): boolean {
  return doc.theme.template === CONSUMER_TEMPLATE;
}
