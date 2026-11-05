/**
 * 謄本の取得で「どの土地・建物を取るか」(2026-11-06 発注者「始める」=2筆以上・2棟以上の2回目後半)。
 *
 * 物件の画面からの1件ずつの取得だけが行を選べる(一括は1筆目だけ=発注者決定 2026-11-06)。
 * 指定なし=今までどおり物件の欄(地番・家屋番号・不動産番号・住所)。指定あり=足した行(extraParcels)。
 * ⚠行の番号・所在は**サーバーが物件から読み直した値**だけを使う(画面から送られた番号は信じない)。
 * ⚠純関数(DB・外部に触れない)。
 */
import { readExtraParcels, type ExtraParcel } from "@/lib/property-parcels";
import { fingerprintProperty, type PropertyFingerprintSource } from "./candidate-cache";

export interface RegistryTargetSource extends PropertyFingerprintSource {
  extraParcels?: unknown;
}

/** 検索・取得に使う値(物件の欄と同じ形)。parcel=足した行(1筆目なら null)。 */
export interface RegistryTargetView extends PropertyFingerprintSource {
  parcel: ExtraParcel | null;
}

export const TARGET_PARCEL_ID_MAX = 64;

/** 画面から届いた値。省略=指定なし。⚠null・空・文字以外は「壊れた指定」(黙って1筆目に倒さない)。 */
export function parseTargetParcelId(raw: unknown): { ok: true; value: string | null } | { ok: false } {
  if (raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false };
  const v = raw.trim();
  if (!v || v.length > TARGET_PARCEL_ID_MAX) return { ok: false };
  return { ok: true, value: v };
}

/**
 * 取る対象の値。足した行は、その行の種類の番号だけ・所在は行(空なら物件の住所)・不動産番号は使わない
 * (番号での取得は作らない=発注者判断。物件の不動産番号で1筆目を取りに行かないためにも null にする)。
 * 行が見つからなければ null(取得しない)。
 */
export function registryTargetView(p: RegistryTargetSource, targetParcelId: string | null | undefined): RegistryTargetView | null {
  if (!targetParcelId) {
    return { address: p.address, lotNumber: p.lotNumber, buildingNumber: p.buildingNumber, realEstateNumber: p.realEstateNumber, parcel: null };
  }
  const parcel = readExtraParcels(p.extraParcels).find((r) => r.id === targetParcelId);
  if (!parcel) return null;
  return {
    address: parcel.location?.trim() ? parcel.location : p.address,
    lotNumber: parcel.kind === "land" ? parcel.number : null,
    buildingNumber: parcel.kind === "building" ? parcel.number : null,
    realEstateNumber: null,
    parcel,
  };
}

/**
 * 候補を覚えるとき・取得の直前に比べる指紋。指定なしは今までの指紋そのまま(一括の控えと同じ)。
 * 行を指定したときは行の id と検索に使う値を入れる=1筆目で検索した候補を行の取得に使えない(逆も)・
 * 検索のあとで行を直す/消すと取得しない。
 */
export function fingerprintRegistryTarget(p: RegistryTargetSource, targetParcelId: string | null | undefined): string {
  if (!targetParcelId) return fingerprintProperty(p);
  const v = registryTargetView(p, targetParcelId);
  if (!v) return JSON.stringify(["parcel-missing", targetParcelId]);
  return JSON.stringify(["parcel", targetParcelId, v.parcel!.kind, fingerprintProperty(v)]);
}

/**
 * 二重課金の鍵に入れる番号。1筆目は今までどおり(30日の台帳と同じ鍵のまま=前に買った分で止まる)。
 * 足した行は種類をつける(家屋番号が地番と同じ「1番1」でも、土地と建物を同じ買い物にしない)。
 */
export function purchaseIdentifierFor(view: RegistryTargetView, lotOrBuilding: string): string {
  return view.parcel ? `${view.parcel.kind}:${lotOrBuilding}` : lotOrBuilding;
}
