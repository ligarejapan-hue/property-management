import { z } from "zod";

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
      fontFamily: z.string().optional(),
      color: z.string().optional(),
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
  src: z.string().min(1),
  fit: z.enum(["cover", "contain"]).default("cover"),
  radiusMm: z.number().nonnegative().optional(),
  alt: z.string().optional(),
});

export const tableElementSchema = z.object({
  ...baseElement,
  type: z.literal("table"),
  rows: z.array(z.object({ label: z.string(), value: z.string() })),
  style: z
    .object({
      fontSizePt: z.number().positive().optional(),
      labelColor: z.string().optional(),
      valueColor: z.string().optional(),
      borderColor: z.string().optional(),
    })
    .default({}),
});

export const badgeElementSchema = z.object({
  ...baseElement,
  type: z.literal("badge"),
  label: z.string(),
  shape: z.enum(["rounded", "pill", "ribbon"]).default("rounded"),
  bg: z.string(),
  fg: z.string(),
  fontSizePt: z.number().positive().optional(),
});

export const shapeElementSchema = z.object({
  ...baseElement,
  type: z.literal("shape"),
  shape: z.enum(["rect", "line"]).default("rect"),
  fill: z.string().optional(),
  stroke: z.string().optional(),
  strokeWidthMm: z.number().nonnegative().optional(),
  radiusMm: z.number().nonnegative().optional(),
});

export const qrElementSchema = z.object({
  ...baseElement,
  type: z.literal("qr"),
  /** 生成済みQR画像の data URL（生成は後続Plan）。 */
  dataUrl: z.string().min(1),
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

export const themeSchema = z.object({
  fontFamily: z.string(),
  accentColor: z.string(),
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
