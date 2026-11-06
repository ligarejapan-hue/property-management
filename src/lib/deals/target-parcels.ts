import { readExtraParcels, type ParcelKind } from "@/lib/property-parcels";

/**
 * この取引の土地・建物(2026-11-06 発注者 案A 3回目の1つ目「取引ごとの対象から」)。
 * 2筆以上・2棟以上の物件で、分筆して一部だけ売るときなどに、取引が扱う筆・棟を選ぶ。
 * 取引の target_parcels 列: null=全部(今までどおり)。選んだときは鍵の配列
 * (1筆目=MAIN_LAND_KEY・1棟目=MAIN_BUILDING_KEY・足した行=行の id)。
 * 選んだものは、写しの所在・地番/家屋番号と、照合・段取り・書類確認書の謄本の見方に使う。
 * ⚠Prisma を読まない(画面からも使う)。
 */

export const MAIN_LAND_KEY = "main:land";
export const MAIN_BUILDING_KEY = "main:building";

export interface ParcelSource {
  lotNumber: string | null;
  buildingNumber: string | null;
  extraParcels: unknown;
}

/** 足した行。⚠1筆目・1棟目の鍵と同じ形の id(「main:」で始まる)の行は選べない(取り違えない)。 */
const extrasOf = (p: ParcelSource) => readExtraParcels(p.extraParcels).filter((x) => !x.id.startsWith("main:"));

export interface DealParcelOption {
  key: string;
  kind: ParcelKind;
  label: string;
}

/**
 * 選べる土地・建物。足した行が無い物件は空(=選ぶ欄を出さない・今までどおり全部)。
 * always=足した行が無くても1筆目・1棟目を返す(合筆で最後の足した行が消えたあとも、取引の選びを効かせる・@codex P1)。
 */
export function dealParcelOptions(p: ParcelSource, o: { always?: boolean } = {}): DealParcelOption[] {
  const extras = extrasOf(p);
  if (!extras.length && !o.always) return [];
  const lot = p.lotNumber?.trim();
  const building = p.buildingNumber?.trim();
  return [
    ...(lot ? [{ key: MAIN_LAND_KEY, kind: "land" as const, label: `土地 ${lot}（1筆目）` }] : []),
    ...(building ? [{ key: MAIN_BUILDING_KEY, kind: "building" as const, label: `建物 ${building}（1棟目）` }] : []),
    ...extras.map((x) => ({
      key: x.id, kind: x.kind, label: `${x.kind === "land" ? "土地" : "建物"} ${x.location ? `${x.location} ` : ""}${x.number}`,
    })),
  ];
}

/** 保存してある値を読む。文字の配列(1つ以上)だけ。それ以外は全部(null)。 */
export function readTargetParcels(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || !raw.length || !raw.every((v) => typeof v === "string")) return null;
  return raw as string[];
}

/**
 * 保存する値にする。全部を選んだら null(物件に行を足したとき、その行も入る=今までどおり)。
 * 物件の並びにそろえる。物件に無い鍵・空の選択は不正(黙って全部にしない)。
 */
export function normalizeTargetParcels(
  keys: readonly string[] | null, options: readonly DealParcelOption[],
): { ok: true; value: string[] | null } | { ok: false } {
  if (keys === null) return { ok: true, value: null };
  if (!keys.length || !options.length) return { ok: false };
  const known = new Set(options.map((o) => o.key));
  if (keys.some((k) => !known.has(k))) return { ok: false };
  const picked = new Set(keys);
  const value = options.filter((o) => picked.has(o.key)).map((o) => o.key);
  return { ok: true, value: value.length === options.length ? null : value };
}

/**
 * 今の物件で選ばれているもの。物件から消えた行(番号を空にした1筆目も)は外す。
 * 1つも残らなければ null=全部(何も見ない取引にしない)。
 */
export function selectedParcelKeys(p: ParcelSource, target: readonly string[] | null): string[] | null {
  if (!target) return null;
  // ⚠足した行が無くなった物件でも、選んでいた1筆目・1棟目は効かせる(全部に戻すと選ばなかった建物が書類に入る)。
  const known = new Set(dealParcelOptions(p, { always: true }).map((o) => o.key));
  const keys = target.filter((k) => known.has(k));
  return keys.length ? keys : null;
}

/**
 * 選んだ土地・建物だけの物件の形(写し・照合はこれを今までの部品に渡す)。
 * 選ばなかった1筆目・1棟目は番号を空に、足した行は選んだものだけ。
 */
export function applyTargetParcels<T extends ParcelSource>(p: T, target: readonly string[] | null): ParcelSource {
  const keys = selectedParcelKeys(p, target);
  if (!keys) return { lotNumber: p.lotNumber, buildingNumber: p.buildingNumber, extraParcels: p.extraParcels };
  const picked = new Set(keys);
  return {
    lotNumber: picked.has(MAIN_LAND_KEY) ? p.lotNumber : null,
    buildingNumber: picked.has(MAIN_BUILDING_KEY) ? p.buildingNumber : null,
    extraParcels: extrasOf(p).filter((x) => picked.has(x.id)),
  };
}
