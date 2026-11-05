import { z } from "zod";
import { normalizeLotNumber } from "@/lib/address-normalizer";
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

/**
 * 書類・依頼文に出す地番・家屋番号(1筆目から順に「、」でつなぐ)。
 * 所在を入れた行は「所在 番号」にする(所在が違う筆を、物件の住所の地番と取り違えない・@codex P2)。
 */
export function joinedParcelNumbers(main: string | null | undefined, raw: unknown, kind: ParcelKind): string | null {
  const all = [main?.trim() || null, ...ofKind(readExtraParcels(raw), kind).map((p) => (p.location ? `${p.location} ${p.number}` : p.number))]
    .filter((v): v is string => !!v);
  return all.length ? all.join("、") : null;
}

/** 地番・家屋番号を比べる形。「1番1」「1番地1」「1-1」「１番１」を同じにする。 */
export function parcelNumberKey(v: string | null | undefined): string | null {
  const s = v?.normalize("NFKC").replace(/番地/g, "番").trim();
  if (!s) return null;
  return normalizeLotNumber(s) || null;
}

/**
 * 謄本がこの物件のどの土地・建物のものか(謄本から読めた地番・家屋番号で決める)。
 * - main: 1筆目・1棟目(今までどおり物件の欄を埋める)。足した行に無い番号で、その種類の物件の欄が空のときも main。
 *   足した行が無い物件で番号を読めないときも main(今までどおり)。
 * - extra: 足した行のどれか(物件の欄は埋めない)。
 * - 同じ番号が2つ以上あるときは謄本の所在で決める(pickParcelByLocation)。決められなければ unknown(ambiguous)=何も入れない。
 * - unknown: 1筆目とも足した行とも違う番号(hasExtras=足した行がある物件か)。足した行がある物件で番号を読めないときも
 *   unknown(kind=null)=どの筆か分からないので物件全体の面積などに入れない(内部レビュー P2)。
 * 建物の謄本は家屋番号で決める(建物の謄本の地番の欄は所在の地番のことがある)。
 * ⚠pdf の番号は registryIdentityOf(表の欄だけを読む)で読んだものを渡す。全文から拾うと、土地の謄本の
 *   共同担保目録にある建物の家屋番号で建物と取り違える(内部レビュー P2)。
 */
export type RegistryParcelTarget =
  | { target: "main" }
  | { target: "extra"; id: string; kind: ParcelKind }
  /** ambiguous=同じ番号の土地・建物が2つ以上あり、所在でも決められない(@codex P1)。 */
  | { target: "unknown"; kind: ParcelKind | null; number: string; hasExtras: boolean; ambiguous?: boolean };

const locationKey = (v: string | null | undefined) => (v ? v.normalize("NFKC").replace(/\s+/g, "") || null : null);

/**
 * 同じ番号の候補から、謄本の所在で1つに決める。決められなければ null。
 * - 所在を入れた候補は、謄本の所在と(どちらかがもう一方を含む形で)合うものだけ。
 * - 合う候補が無ければ、所在が空の候補(=物件の住所と同じ)が1つだけのときそれ。
 * ⚠謄本の所在を読めなければ、候補が2つ以上なら決めない。
 */
export function pickParcelByLocation<T extends { location: string | null }>(candidates: T[], registryAddress: string | null): T | null {
  if (candidates.length <= 1) return candidates[0] ?? null;
  const addr = locationKey(registryAddress);
  if (!addr) return null;
  const matched = candidates.filter((c) => {
    const l = locationKey(c.location);
    return !!l && (addr.includes(l) || l.includes(addr));
  });
  if (matched.length) return matched.length === 1 ? matched[0] : null;
  const implicit = candidates.filter((c) => !locationKey(c.location));
  return implicit.length === 1 ? implicit[0] : null;
}

export function registryParcelTarget(
  pdf: { lotNumber: string | null; buildingNumber: string | null; address?: string | null },
  property: { lotNumber: string | null; buildingNumber: string | null; extraParcels: unknown },
): RegistryParcelTarget {
  const extras = readExtraParcels(property.extraParcels);
  const kind: ParcelKind | null = pdf.buildingNumber ? "building" : pdf.lotNumber ? "land" : null;
  const number = kind === "building" ? pdf.buildingNumber : kind === "land" ? pdf.lotNumber : null;
  const key = parcelNumberKey(number);
  if (!kind || !key) return extras.length ? { target: "unknown", kind: null, number: "", hasExtras: true } : { target: "main" };
  const mainKey = parcelNumberKey(kind === "building" ? property.buildingNumber : property.lotNumber);
  // 1筆目と足した行に同じ番号があれば(所在が違う筆など)、所在で決める(@codex P1)。1筆目の所在は物件の住所=空とみなす。
  const candidates: { location: string | null; id: string | null }[] = [
    ...(mainKey === key ? [{ location: null, id: null }] : []),
    ...extras.filter((p) => p.kind === kind && parcelNumberKey(p.number) === key).map((p) => ({ location: p.location, id: p.id as string | null })),
  ];
  if (!candidates.length) {
    if (!mainKey) return { target: "main" };
    return { target: "unknown", kind, number: number as string, hasExtras: extras.length > 0 };
  }
  const hit = pickParcelByLocation(candidates, pdf.address ?? null);
  if (!hit) return { target: "unknown", kind, number: number as string, hasExtras: true, ambiguous: true };
  return hit.id === null ? { target: "main" } : { target: "extra", id: hit.id, kind };
}

/** 足した行の空いている面積だけを入れた行の一覧。入れるものが無ければ null(書かない)。 */
export function fillExtraParcelArea(raw: unknown, id: string, area: number | null): ExtraParcel[] | null {
  if (area === null || !Number.isFinite(area) || area < 0) return null;
  const ps = readExtraParcels(raw);
  const row = ps.find((p) => p.id === id);
  if (!row || row.area !== null) return null;
  return ps.map((p) => (p.id === id ? { ...p, area: Math.round(area * 100) / 100 } : p));
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
