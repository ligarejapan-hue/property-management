import { z } from "zod";
import { toHalfWidthDigits } from "@/lib/registry-fetch/chiban-input";

/**
 * 物件の2筆目以降の土地・2棟目以降の建物(2026-11-05 発注者 案A「物件の中に土地・建物の内訳」1回目)。
 * 1筆目・1棟目は今までどおり物件の地番(lotNumber)・家屋番号(buildingNumber)・面積の欄。ここには足した分だけ持つ。
 * 土地面積・建物面積の欄は、今までどおり物件全体の値(内訳の合計は画面で知らせ、入れるのは人が選ぶ)。
 * ⚠Prisma を読まない(画面からも使う)。
 */

export const PARCEL_KINDS = { land: "土地", building: "建物" } as const;
export type ParcelKind = keyof typeof PARCEL_KINDS;
export const EXTRA_PARCELS_MAX = 30;

export interface ExtraParcel {
  id: string;
  kind: ParcelKind;
  /** 所在(空なら物件の住所と同じとみなす)。 */
  location: string | null;
  /** 地番(土地)・家屋番号(建物)。 */
  number: string;
  realEstateNumber: string | null;
  /** 地積・床面積(㎡・小数2桁まで)。 */
  area: number | null;
}

const optText = (max: number, label: string) =>
  z.union([z.string(), z.null()]).optional()
    .transform((v) => (v == null ? null : toHalfWidthDigits(v.trim()) || null))
    .refine((v) => v === null || v.length <= max, `${label}は${max}文字以内で入力してください`);

/** 面積: 数でも文字でも(画面は文字で送る)。空=null・0以上・小数2桁まで。 */
const areaValue = z.union([z.number(), z.string(), z.null()]).optional().transform((v, ctx) => {
  if (v == null) return null;
  const s = String(v).normalize("NFKC").trim().replace(/,/g, "");
  if (s === "") return null;
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(s)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ほかの土地・建物の面積は、0以上・小数2桁までの数で入力してください" });
    return z.NEVER;
  }
  return Number(s);
});

export const extraParcelSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(["land", "building"]),
  location: optText(200, "ほかの土地・建物の所在"),
  number: z.string().transform((v) => toHalfWidthDigits(v.trim()))
    .refine((v) => v.length >= 1, "ほかの土地・建物の地番・家屋番号を入れてください")
    .refine((v) => v.length <= 50, "ほかの土地・建物の地番・家屋番号は50文字以内で入力してください"),
  realEstateNumber: optText(20, "ほかの土地・建物の不動産番号"),
  area: areaValue,
}).strict();

export const extraParcelsSchema = z.array(extraParcelSchema)
  .max(EXTRA_PARCELS_MAX, `ほかの土地・建物は${EXTRA_PARCELS_MAX}件までです`)
  .refine((ps) => new Set(ps.map((p) => p.id)).size === ps.length, "ほかの土地・建物の行が重なっています");

/** 保存してある値を読む。形の合わない行は捨てる(画面を止めない)。 */
export function readExtraParcels(raw: unknown): ExtraParcel[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    const p = extraParcelSchema.safeParse(r);
    return p.success ? [p.data as ExtraParcel] : [];
  });
}

const ofKind = (ps: ExtraParcel[], kind: ParcelKind) => ps.filter((p) => p.kind === kind);

/** 基本情報の地番・家屋番号の見出し。足した分があれば「1番1 ほか1筆」「1番1 ほか1棟」。 */
export function parcelNumberLabel(main: string | null | undefined, raw: unknown, kind: ParcelKind): string | null {
  const extra = ofKind(readExtraParcels(raw), kind).length;
  const m = main?.trim() || null;
  if (!extra) return m;
  const unit = kind === "land" ? "筆" : "棟";
  return m ? `${m} ほか${extra}${unit}` : `ほか${extra}${unit}`;
}

/** 書類・依頼文に出す地番・家屋番号(1筆目から順に「、」でつなぐ)。 */
export function joinedParcelNumbers(main: string | null | undefined, raw: unknown, kind: ParcelKind): string | null {
  const all = [main?.trim() || null, ...ofKind(readExtraParcels(raw), kind).map((p) => p.number)].filter((v): v is string => !!v);
  return all.length ? all.join("、") : null;
}

/** 変更履歴に残す文字(1行に1件)。空なら null。 */
export function extraParcelsText(raw: unknown): string | null {
  const ps = readExtraParcels(raw);
  if (!ps.length) return null;
  return ps.map((p) => [
    PARCEL_KINDS[p.kind], p.location, p.number, p.realEstateNumber && `不動産番号 ${p.realEstateNumber}`, p.area !== null && `${p.area}㎡`,
  ].filter(Boolean).join(" ")).join("\n");
}

/** 編集画面の欄の文字(行の JSON・欄は文字のまま)。足していなければ空文字。 */
export function extraParcelsEditValue(raw: unknown): string {
  const ps = readExtraParcels(raw);
  if (!ps.length) return "";
  return JSON.stringify(ps.map((p) => ({
    id: p.id, kind: p.kind, location: p.location ?? "", number: p.number, realEstateNumber: p.realEstateNumber ?? "", area: p.area === null ? "" : String(p.area),
  })));
}
