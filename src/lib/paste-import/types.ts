import type { SourceProfileId } from "./source-profiles";

export type DraftWarningCode =
  | "no_labeled_lines"
  | "lot_number_missing"
  | "property_type_unknown"
  | "address_missing";

export interface DraftWarning {
  code: DraftWarningCode;
  message: string;
}

/** 1つの欄。**どの見出しから来たか**を持つ（確認画面で原文と照らすため）。 */
export interface DraftField {
  value: string | null;
  sourceLabel: string | null;
}

export interface PasteDraft {
  sourceProfile: SourceProfileId;
  sourceProfileLabel: string;
  property: {
    address: DraftField;
    lotNumber: DraftField;
    buildingName: DraftField;
    roomNo: DraftField;
    /** PropertyType の値（land / house / apartment_unit …）。 */
    propertyType: DraftField;
    exclusiveArea: DraftField;
    landArea: DraftField;
    layoutType: DraftField;
    /** OccupancyStatus の値（vacant / occupied / unknown）。 */
    occupancyStatus: DraftField;
    builtYear: DraftField;
  };
  owner: {
    name: DraftField;
    nameKana: DraftField;
    phone: DraftField;
    email: DraftField;
    /** ⚠現住所。登記上住所(address)には入れない（発注者承認 2026-08-26）。 */
    currentAddress: DraftField;
  } | null;
  externalLinkKey: string | null;
  warnings: DraftWarning[];
  unmapped: { label: string; value: string }[];
  /**
   * 区切りが無く「見出し: 値」に割れなかった行（設計書 §4.2）。
   * ⚠**捨てない**。確認画面で原文と突き合わせるとき、および
   *   「なぜこの項目が拾えなかったのか」を人が調べるときに必要になる。
   */
  unlabeled: string[];
  /** 備考へそのまま入れる文字列（辞書に無かった見出しをまとめたもの）。 */
  noteFromUnmapped: string;
}
