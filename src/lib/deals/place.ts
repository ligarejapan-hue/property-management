/**
 * 契約場所・決済場所の選択肢(発注者指定 2026-10-31)。
 * 保存は今までどおり1つの文字(書類にそのまま印字する)。銀行だけは「銀行名 全角空白 支店名」で持ち、
 * 開き直したときに欄へ戻す。選択肢に無い今までの手入力は「その他」の欄に残す。
 */
const FIXED_KINDS = ["当社事務所", "仲介事務所", "売主宅", "買主宅"];
export const PLACE_KIND_BANK = "銀行";
export const PLACE_KIND_OTHER = "その他";
const BANK_SEPARATOR = "　";
/** 2つの欄と区切りの1字で列の上限(200字)に収まる長さ。 */
export const PLACE_BANK_PART_MAX = 90;
export const PLACE_OTHER_MAX = 200;

export interface PlaceForm { kind: string; other: string; bank: string; branch: string }
export const EMPTY_PLACE: PlaceForm = { kind: "", other: "", bank: "", branch: "" };

/** 銀行は決済場所だけ。 */
export function placeKindsFor(allowBank: boolean): string[] {
  return [...FIXED_KINDS, ...(allowBank ? [PLACE_KIND_BANK] : []), PLACE_KIND_OTHER];
}

export function parsePlace(saved: string | null, allowBank: boolean): PlaceForm {
  const v = (saved ?? "").trim();
  if (v === "") return EMPTY_PLACE;
  if (FIXED_KINDS.includes(v)) return { ...EMPTY_PLACE, kind: v };
  const parts = v.split(BANK_SEPARATOR);
  if (allowBank && parts.length === 2 && parts[0] && parts[1]) {
    return { ...EMPTY_PLACE, kind: PLACE_KIND_BANK, bank: parts[0], branch: parts[1] };
  }
  return { ...EMPTY_PLACE, kind: PLACE_KIND_OTHER, other: v };
}

/** 手入力の全角空白は半角に(銀行の区切りと取り違えない)。 */
const typed = (v: string) => v.replaceAll(BANK_SEPARATOR, " ").trim();

export function composePlace(f: PlaceForm): string {
  if (f.kind === PLACE_KIND_OTHER) return typed(f.other);
  if (f.kind === PLACE_KIND_BANK) return [typed(f.bank), typed(f.branch)].filter(Boolean).join(BANK_SEPARATOR);
  return f.kind;
}

/** 保存できない理由(手入力の欄が空)。問題なければ null。 */
export function placeProblem(f: PlaceForm): string | null {
  if (f.kind === PLACE_KIND_OTHER && !typed(f.other)) return "場所を入れてください";
  if (f.kind === PLACE_KIND_BANK && (!typed(f.bank) || !typed(f.branch))) return "銀行名と支店名を入れてください";
  return null;
}
