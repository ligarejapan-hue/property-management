import type { SourceProfileId } from "./source-profiles";

export type DraftWarningCode =
  | "no_labeled_lines"
  | "lot_number_missing"
  | "property_type_unknown"
  | "address_missing"
  /**
   * 見出しは辞書にあったのに、**値を解釈できなかった**。
   * ⚠捨てて黙る（＝確認画面に「元の資料に記載がありません」と出る）のは
   *   **利用者への嘘**になる。元資料には書いてあるのだから、
   *   ①警告を出す ②生の値を備考へ残す ③欄は空のまま、の3つを同時に行う。
   */
  | "value_unreadable";

export interface DraftWarning {
  code: DraftWarningCode;
  message: string;
  /**
   * どの欄についての警告か（PasteDraft["property"] のキー）。
   * 確認画面はこれを見て、その欄に警告を添え、
   * 「元の資料に記載がありません」を**出さない**ようにする。
   */
  field?: string;
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
   * 辞書に無かった見出しのうち、**所有者の個人情報にあたるため備考へ入れなかった**もの。
   *
   * ⚠`Property.note` は所有者の項目別マスクを通らずに表示されるので、
   *   ここに入れてしまうと、`owner_phone` の権限が無い利用者でも電話番号を
   *   保存でき、しかも物件を見られる全員に見えてしまう
   *   (＝同じPRで入れた項目別権限チェックの迂回路)。
   * ⚠**捨てずに持つ**。確認画面に出して、人が適切な欄へ移せるようにする。
   */
  withheldFromNote: {
    label: string;
    value: string;
    /** label=見出しで判定 / value=値の形で判定 / unclassified=安全と確定できなかった。 */
    reason: "label" | "value" | "unclassified";
  }[];
  /**
   * 値を解釈できず、生値を備考へ回した項目。
   * ⚠**どの欄のものか**を持つ。人がその欄に値を入れたら、備考から**その行を
   *   取り除く**ために要る(追記だけだと `土地面積: 20坪（66.1㎡）` と
   *   `土地面積: 66.1` が並び、矛盾した2行が残る)。
   */
  unreadable: { field: string; label: string; value: string }[];
  /**
   * 区切りが無く「見出し: 値」に割れなかった行（設計書 §4.2）。
   * ⚠**捨てない**。確認画面で原文と突き合わせるとき、および
   *   「なぜこの項目が拾えなかったのか」を人が調べるときに必要になる。
   */
  unlabeled: string[];
  /** 備考へそのまま入れる文字列（辞書に無かった見出しをまとめたもの）。 */
  noteFromUnmapped: string;
}
