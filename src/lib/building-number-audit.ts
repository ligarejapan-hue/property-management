/**
 * 家屋番号の点検（read-only）。
 *
 * 背景: 区分建物の全部事項を取り込んだとき、一棟の建物の「専有部分の家屋番号」
 * （全部屋の範囲。例「5-1-1 ～ 5-1-43」）を、その部屋の家屋番号として物件に入れていた
 * （PR #563 で読み取りは修正済み）。家屋番号は謄本の自動取得で建物を探すのに使うため、
 * 範囲が入った物件では家屋番号での取得がうまくいかない。
 *
 * ここでは「範囲が入っていそうな物件」の判定と、添付の謄本から読み直した候補の判定だけを行う
 * （純関数。DB・ファイルの読み書きは route 側）。**自動では書き換えない**。
 */
import { parseRegistryText } from "@/lib/pdf-registry-parser";

/** 一度に点検する物件の上限。超えたら truncated を立てる。 */
export const BUILDING_NUMBER_AUDIT_MAX_TARGETS = 200;
/** 謄本の読み直しにかける時間の上限（nginx の 60 秒に収める）。超えた分は未処理として返す。 */
export const BUILDING_NUMBER_AUDIT_TIME_BUDGET_MS = 40_000;

/** 家屋番号が「範囲」の形か（～ / 〜 を含む）。部屋の家屋番号には～は入らない。 */
export function isRangeBuildingNumber(value: string | null | undefined): boolean {
  return typeof value === "string" && /[～〜]/.test(value);
}

export type BuildingNumberSuggestionStatus =
  /** 謄本から部屋の家屋番号を読めた */
  | "suggested"
  /** 謄本が添付されていない */
  | "no_registry"
  /** 謄本の実体が見つからない・文字を読めない */
  | "unreadable"
  /** 謄本は読めたが、部屋の家屋番号が見つからない */
  | "not_found"
  /** 時間の上限で読み直していない */
  | "not_processed";

export const BUILDING_NUMBER_STATUS_LABELS: Record<BuildingNumberSuggestionStatus, string> = {
  suggested: "候補あり",
  no_registry: "謄本なし（謄本で確認）",
  unreadable: "謄本を読めない（謄本で確認）",
  not_found: "謄本に部屋の家屋番号なし（謄本で確認）",
  not_processed: "未処理（もう一度開く）",
};

/** 謄本の文字から、部屋の家屋番号の候補を読む（範囲は候補にしない）。 */
export function suggestBuildingNumberFromText(text: string): string | null {
  const v = parseRegistryText(text).buildingNumber;
  if (!v || isRangeBuildingNumber(v)) return null;
  return v;
}
