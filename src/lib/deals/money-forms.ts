import { yen } from "./calc/format";
import type { OverrideKey, Overrides } from "./schemas";

/** 金額の入力 → 円の整数。カンマ・円・空白は無視。空・小数・マイナス・数字以外は null。 */
export function parseYen(s: string): number | null {
  // 全角の数字・カンマも読む(日本語入力のまま打たれることが多い)。
  const t = s.normalize("NFKC").replace(/[,円\s]/g, "");
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

export const yenText = (n: number | null) => (n === null ? "" : yen(n));

/** 1/100 % の整数 → 画面の % の文字(1000 → "10"・850 → "8.5")。 */
export const bpToPercentText = (bp: number) => String(bp / 100);

/** 画面の % の文字 → 1/100 % の整数。小数は2桁まで。 */
export function percentTextToBp(s: string): number | null {
  const t = s.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/**
 * 空でないのに金額として読めない欄の名前(最終レビュー I-1)。読めない値を null で送ると保存済みの金額が消えるため、
 * 1つでもあれば保存しない。
 */
export function invalidYenLabels(fields: [label: string, value: string][]): string[] {
  return fields.filter(([, v]) => v.trim() !== "" && parseYen(v) === null).map(([label]) => label);
}

/**
 * 上書きの保存用の map(最終レビュー I-2)。自分のパネルの鍵だけを差し替え、ほかのパネルの鍵は今の保存済みの値を残す。
 */
export function mergeOverrides(saved: Overrides, mine: Overrides, myKeys: readonly OverrideKey[]): Overrides {
  const out: Overrides = { ...saved };
  for (const k of myKeys) {
    if (mine[k] === undefined) delete out[k];
    else out[k] = mine[k];
  }
  return out;
}

export const MONEY_OVERRIDE_KEYS = ["brokerageFee", "buildingPrice", "buildingTax"] as const satisfies readonly OverrideKey[];
export const SETTLEMENT_OVERRIDE_KEYS = ["settlement.propertyTax", "settlement.management", "settlement.rent"] as const satisfies readonly OverrideKey[];

/** そのパネルの鍵だけを取り出す(パネルの key 用)。 */
export function pickOverrides(o: Overrides, keys: readonly OverrideKey[]): Overrides {
  const out: Overrides = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

/** 行の金額の欄を、入力の文字のまま持つ形にする(打ち間違いを 0 に置き換えないため・@codex)。 */
export type Texted<T, K extends keyof T> = Omit<T, K> & Record<K, string>;

export function textify<T extends object, K extends keyof T>(row: T, keys: readonly K[]): Texted<T, K> {
  const out = { ...row } as Record<string, unknown>;
  for (const k of keys) out[k as string] = String(row[k] ?? "");
  return out as Texted<T, K>;
}

/** 保存のときに読む。空は 0。読めない欄は bad に名前を入れる(1つでもあれば保存しない)。 */
export function untextify<T extends object, K extends keyof T>(
  form: Texted<T, K>,
  keys: readonly K[],
  labelOf: (k: K) => string,
): { value: T; bad: string[] } {
  const out = { ...form } as Record<string, unknown>;
  const bad: string[] = [];
  for (const k of keys) {
    const raw = (form as Record<string, unknown>)[k as string] as string;
    const n = raw.trim() === "" ? 0 : parseYen(raw);
    if (n === null) bad.push(labelOf(k));
    out[k as string] = n ?? 0;
  }
  return { value: out as T, bad };
}
