/**
 * 問い合わせ者(反響で申し込んできた人の氏名)の決まり。2026-10-24 従業員の指摘(第2弾)・発注者承認。
 * Prisma・DOM を持ち込まない純関数(取込の確定・物件の編集・一覧・変更履歴で共有)。
 *
 * - 貼り付け/Excel の反響取込は、申込者を所有者として登録する(ご所有者様名が別にあればそちらが所有者)。
 *   申込者の氏名は Property.inquirerName に残す(所有者の備考だけに埋もれさせない)。
 * - ⚠**個人情報**。所有者の氏名と同じ扱い: 見せるのは owner:read がある人だけ・所有者の氏名と同じ
 *   表示レベル(maskValue(..., ownerDisplayConfig.name))で伏せる。監査ログの detail には入れない。
 * - 一覧の「問い合わせ者／所有者」の列は、問い合わせ者があればそれを、無ければ所有者を出す
 *   (謄本・DM から来た物件には問い合わせ者がいない)。どちらを出しているかを小さな札で示す。
 */
import { maskValue } from "@/lib/permissions";

/** 問い合わせ者の氏名の上限(整えた後の文字数)。 */
export const INQUIRER_NAME_MAX_LENGTH = 100;
export const INQUIRER_NAME_TOO_LONG_MESSAGE = `問い合わせ者は${INQUIRER_NAME_MAX_LENGTH}文字以内で入力してください`;

/** 前後の空白を除く。空は null。⚠長さは測るだけ(切り詰めない=呼び出し側で断る)。 */
export function normalizeInquirerName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return v === "" ? null : v;
}

export function isInquirerNameTooLong(raw: unknown): boolean {
  return (normalizeInquirerName(raw) ?? "").length > INQUIRER_NAME_MAX_LENGTH;
}

/**
 * API が返す問い合わせ者。owner:read が無ければ **キーごと出さない**(undefined)。
 * ある人には所有者の氏名と同じ表示レベルで伏せる(hidden なら null)。
 */
export function inquirerNameForViewer(
  raw: string | null | undefined,
  ownerNameLevel: string | null,
): string | null | undefined {
  if (ownerNameLevel === null) return undefined;
  return maskValue(raw ?? null, ownerNameLevel);
}

/**
 * 物件の行(Prisma の行をそのまま返す route 用)の問い合わせ者を、見る人に合わせて差し替える。
 * owner:read が無ければキーごと取り除く。⚠物件の行を丸ごと返す route は必ずこれを通す
 * (詳細 GET/PATCH・作成・操作ボタン・棟の部屋一覧/部屋の追加)。
 */
export function applyInquirerNameVisibility<T extends { inquirerName?: string | null }>(
  row: T,
  ownerNameLevel: string | null,
): Omit<T, "inquirerName"> & { inquirerName?: string | null } {
  const { inquirerName, ...rest } = row;
  const shown = inquirerNameForViewer(inquirerName ?? null, ownerNameLevel);
  return shown === undefined ? rest : { ...rest, inquirerName: shown };
}

export interface OwnerColumnDisplay {
  /** inquirer=問い合わせ者を出している / owner=所有者を出している / none=どちらも無い。 */
  kind: "inquirer" | "owner" | "none";
  /** 名前の前に添える小さな札(none は空)。 */
  label: "問合せ" | "所有者" | "";
  names: string[];
}

/** 一覧の「問い合わせ者／所有者」の列に何を出すか。問い合わせ者があればそれだけ。 */
export function ownerColumnDisplay(
  inquirerName: string | null | undefined,
  ownerNames: readonly string[] | null | undefined,
): OwnerColumnDisplay {
  const inquirer = normalizeInquirerName(inquirerName ?? null);
  if (inquirer) return { kind: "inquirer", label: "問合せ", names: [inquirer] };
  const owners = (ownerNames ?? []).filter((n) => n.trim() !== "");
  if (owners.length > 0) return { kind: "owner", label: "所有者", names: owners };
  return { kind: "none", label: "", names: [] };
}

/** 変更履歴に表示するとき伏せる物件の欄(所有者の氏名と同じ扱い)。 */
export const OWNER_LEVEL_PROPERTY_FIELDS = ["inquirerName"] as const;

/** 権限の無い人に見せる変更履歴の値。 */
export const REDACTED_CHANGE_VALUE = "（非表示）";

/**
 * 物件の変更履歴(change_logs・properties)の値を見る人に合わせて伏せる。
 * - 問い合わせ者以外の欄はそのまま。
 * - owner:read が無い(ownerNameLevel=null)→ 値があれば「（非表示）」。
 * - ある → 所有者の氏名と同じ表示レベルで伏せる(hidden なら「（非表示）」)。
 */
export function redactPropertyChangeValue(
  fieldName: string,
  value: string | null,
  ownerNameLevel: string | null,
): string | null {
  if (!(OWNER_LEVEL_PROPERTY_FIELDS as readonly string[]).includes(fieldName)) return value;
  if (value == null || value === "") return value;
  if (ownerNameLevel === null) return REDACTED_CHANGE_VALUE;
  return maskValue(value, ownerNameLevel) ?? REDACTED_CHANGE_VALUE;
}
