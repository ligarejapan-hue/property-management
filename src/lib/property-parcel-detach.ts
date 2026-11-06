import { readExtraParcels, type ExtraParcel } from "@/lib/property-parcels";

/**
 * 「この筆を別の物件にする」(2026-11-06 発注者 案A 3回目の3つ目)。
 * 足した行(2筆目以降の土地・2棟目以降の建物)を1つ、新しい物件の1筆目・1棟目にして、元の物件から外す。
 * 発注者決定: 写すのは基本(所在・番号・不動産番号・面積・種別・担当・取扱区分)と所有者のつながりだけ
 * (写真・添付・DM履歴・取引は写さない)・つながりは両方のコメントにリンク・その行を選んでいる取引があれば止める。
 * ⚠Prisma を読まない(純関数)。
 */

export interface DetachSource {
  propertyType: string;
  address: string;
  postalCode: string | null;
  extraParcels: unknown;
}

export interface DetachedPropertyFields {
  propertyType: "land" | string;
  address: string;
  /** 所在を入れた行は物件の住所と違う場所なので、郵便番号は写さない。 */
  postalCode: string | null;
  lotNumber: string | null;
  buildingNumber: string | null;
  realEstateNumber: string | null;
  landArea: number | null;
  totalFloorArea: number | null;
}

export type DetachPlan =
  | { ok: true; row: ExtraParcel; remaining: ExtraParcel[]; fields: DetachedPropertyFields }
  | { ok: false; message: string };

/**
 * 新しい物件の種別。土地の行=土地。建物の行=元の種別(元が土地・不明なら戸建)。
 * ⚠区分マンションは足した行を使わない(呼び出し側で止める)。
 */
export function detachedPropertyType(kind: ExtraParcel["kind"], original: string): string {
  if (kind === "land") return "land";
  return original === "land" || original === "unknown" ? "house" : original;
}

export function planParcelDetach(p: DetachSource, rowId: string): DetachPlan {
  const rows = readExtraParcels(p.extraParcels);
  const row = rows.find((x) => x.id === rowId);
  if (!row) return { ok: false, message: "別の物件にする土地・建物が見つかりません" };
  const location = row.location?.trim() || null;
  return {
    ok: true,
    row,
    remaining: rows.filter((x) => x.id !== rowId),
    fields: {
      propertyType: detachedPropertyType(row.kind, p.propertyType),
      address: location ?? p.address,
      postalCode: location ? null : p.postalCode,
      lotNumber: row.kind === "land" ? row.number : null,
      buildingNumber: row.kind === "building" ? row.number : null,
      realEstateNumber: row.realEstateNumber,
      landArea: row.kind === "land" ? row.area : null,
      totalFloorArea: row.kind === "building" ? row.area : null,
    },
  };
}

const rowLabel = (row: ExtraParcel) => `${row.kind === "land" ? "土地" : "建物"} ${row.location ? `${row.location} ` : ""}${row.number}`;

/** 元の物件のコメント(新しい物件へのリンクつき)。 */
export function detachCommentForOriginal(row: ExtraParcel, newPropertyId: string): string {
  return `この物件の${rowLabel(row)}を別の物件にしました：/properties/${newPropertyId}`;
}

/** 新しい物件のコメント(元の物件へのリンクつき)。 */
export function detachCommentForNew(row: ExtraParcel, originalPropertyId: string): string {
  return `元の物件の${rowLabel(row)}から分けて作りました：/properties/${originalPropertyId}`;
}
