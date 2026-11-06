import { extraParcelsSchema, parcelNumberKey, readExtraParcels, type ExtraParcel } from "@/lib/property-parcels";
import { toHalfWidthDigits } from "@/lib/registry-fetch/chiban-input";
import { MAIN_LAND_KEY } from "@/lib/deals/target-parcels";

/**
 * 分筆・合筆の記録(2026-11-06 発注者 案A 3回目の2つ目)。土地だけ(建物の分割・合併は「土地・建物を足す」で手で直す)。
 * 鍵は取引の「この取引の土地・建物」と同じ(1筆目=MAIN_LAND_KEY・足した行=行の id)。
 * - 分筆: 1つの筆を2つ以上に分ける。1つ目は元の筆のまま(1筆目の欄・行の id・所在・不動産番号を残す)、
 *   残りは足した行(元の筆と同じ所在)としてすぐ後ろに入れる。
 * - 合筆: 2つ以上の筆を1つにまとめる。物件の並びで最初の筆(1筆目を含めば1筆目)に入れ、ほかの行は消す。
 * 元の地番は物件のコメントに残す(発注者決定 2026-11-06)。
 * ⚠Prisma を読まない(純関数)。
 */

export const SPLIT_PIECES_MAX = 10;
export const PARCEL_NUMBER_MAX = 50;

export type ParcelChangeInput =
  | { op: "split"; source: string; pieces: { number: string; area: number | null }[] }
  | { op: "merge"; keys: string[]; number: string; area: number | null };

export interface ParcelChangeSource {
  lotNumber: string | null;
  extraParcels: unknown;
}

/** 取引の選びを直すのに使う結果(addedKeys=分筆で足した行・removedKeys=合筆で消えた行・resultKey=残った筆)。 */
export interface ParcelChangeKeys {
  op: "split" | "merge";
  source: string | null;
  addedKeys: string[];
  removedKeys: string[];
  resultKey: string;
}

export type ParcelChangeResult =
  | ({ ok: true; lotNumber: string | null; extraParcels: ExtraParcel[]; comment: string } & ParcelChangeKeys)
  | { ok: false; message: string };

const fail = (message: string): ParcelChangeResult => ({ ok: false, message });
const cleanNumber = (v: string) => toHalfWidthDigits(v.trim());
const areaText = (a: number | null) => (a === null ? "" : `（${a}㎡）`);
const landLabel = (number: string, location: string | null) => `${location ? `${location} ` : ""}${number}`;

/** 物件の土地の筆(並び順)。1筆目は地番があるときだけ(画面の選ぶ欄にも使う)。 */
export function landChoices(p: ParcelChangeSource): { key: string; number: string; location: string | null }[] {
  const lot = p.lotNumber?.trim();
  return [
    ...(lot ? [{ key: MAIN_LAND_KEY, number: lot, location: null }] : []),
    ...readExtraParcels(p.extraParcels).filter((x) => x.kind === "land" && !x.id.startsWith("main:"))
      .map((x) => ({ key: x.id, number: x.number, location: x.location })),
  ];
}

/** 番号の確かめ(空・長すぎ・同じ番号を弾く)。 */
function checkNumbers(numbers: string[]): string | null {
  if (numbers.some((v) => !v)) return "地番を入れてください";
  if (numbers.some((v) => v.length > PARCEL_NUMBER_MAX)) return `地番は${PARCEL_NUMBER_MAX}文字以内で入力してください`;
  if (new Set(numbers.map((v) => parcelNumberKey(v))).size !== numbers.length) return "同じ地番が2つあります";
  return null;
}

/** 行の一覧の決まり(件数・面積の形)を、物件の保存と同じ形で確かめる。 */
function checkRows(rows: ExtraParcel[]): string | null {
  const r = extraParcelsSchema.safeParse(rows);
  return r.success ? null : (r.error.issues[0]?.message ?? "ほかの土地・建物を確かめてください");
}

export function applyParcelChange(p: ParcelChangeSource, input: ParcelChangeInput, newId: () => string): ParcelChangeResult {
  const all = landChoices(p);
  const extras = readExtraParcels(p.extraParcels);

  if (input.op === "split") {
    const src = all.find((x) => x.key === input.source);
    if (!src) return fail("分ける土地が見つかりません");
    if (input.pieces.length < 2) return fail("2つ以上に分けてください");
    if (input.pieces.length > SPLIT_PIECES_MAX) return fail(`一度に分けられるのは${SPLIT_PIECES_MAX}筆までです`);
    const pieces = input.pieces.map((x) => ({ number: cleanNumber(x.number), area: x.area }));
    const bad = checkNumbers(pieces.map((x) => x.number));
    if (bad) return fail(bad);
    const added: ExtraParcel[] = pieces.slice(1).map((x) => ({
      id: newId(), kind: "land", location: src.location, number: x.number, realEstateNumber: null, area: x.area,
    }));
    let rows: ExtraParcel[];
    let lotNumber = p.lotNumber;
    if (src.key === MAIN_LAND_KEY) {
      lotNumber = pieces[0].number;
      rows = [...added, ...extras];
    } else {
      rows = extras.flatMap((x) => (x.id === src.key ? [{ ...x, number: pieces[0].number, area: pieces[0].area }, ...added] : [x]));
    }
    const badRows = checkRows(rows);
    if (badRows) return fail(badRows);
    return {
      ok: true, op: "split", source: src.key, lotNumber, extraParcels: rows,
      addedKeys: added.map((x) => x.id), removedKeys: [], resultKey: src.key,
      comment: `分筆を記録しました：土地 ${landLabel(src.number, src.location)} → ${pieces.map((x) => `${x.number}${areaText(x.area)}`).join("・")}`,
    };
  }

  if (input.keys.length < 2 || new Set(input.keys).size !== input.keys.length) return fail("2つ以上の土地を選んでください");
  const picked = all.filter((x) => input.keys.includes(x.key));
  if (picked.length !== input.keys.length) return fail("合わせる土地が見つかりません");
  const number = cleanNumber(input.number);
  const bad = checkNumbers([number]);
  if (bad) return fail(bad);
  const [result, ...removed] = picked;
  const removedIds = new Set(removed.map((x) => x.key));
  const rows = extras
    .filter((x) => !removedIds.has(x.id))
    .map((x) => (x.id === result.key ? { ...x, number, area: input.area } : x));
  const badRows = checkRows(rows);
  if (badRows) return fail(badRows);
  return {
    ok: true, op: "merge", source: null,
    lotNumber: result.key === MAIN_LAND_KEY ? number : p.lotNumber, extraParcels: rows,
    addedKeys: [], removedKeys: [...removedIds], resultKey: result.key,
    comment: `合筆を記録しました：土地 ${picked.map((x, i) => (i === 0 ? landLabel(x.number, x.location) : x.number)).join("・")} → ${number}${areaText(input.area)}`,
  };
}

/**
 * 取引の「この取引の土地・建物」を分筆・合筆に合わせる(発注者決定 2026-11-06「分けた筆も自動で足す」)。
 * - 分筆: 元の筆を選んでいた取引に、分けてできた筆を元の筆のすぐ後ろに足す(扱う土地の広さを変えない)。
 * - 合筆: 合わせた筆のどれかを選んでいた取引は、消えた行を外して残った筆を入れる。
 * 戻り値 undefined=変えない(選んでいない取引・全部(null)の取引)。
 */
export function retargetDealParcels(target: readonly string[] | null, change: ParcelChangeKeys): string[] | undefined {
  if (!target) return undefined;
  if (change.op === "split") {
    if (!change.source || !target.includes(change.source)) return undefined;
    return target.flatMap((k) => (k === change.source ? [k, ...change.addedKeys.filter((a) => !target.includes(a))] : [k]));
  }
  // 消えた行を選んでいた取引だけ(残った筆だけを選んでいた取引は変わらない=版を上げない)。
  if (!target.some((k) => change.removedKeys.includes(k))) return undefined;
  const out: string[] = [];
  for (const k of target) {
    const next = change.removedKeys.includes(k) ? change.resultKey : k;
    if (!out.includes(next)) out.push(next);
  }
  return out;
}
