/** 全宅連の媒介契約書から写した文面(設計 第2段階 §3.4)。scripts/deals/extract-zentaku-mediation.py が作る。 */
export interface MediationText {
  /** 元の Word のファイル名と、その作成日・更新日。 */
  source: string;
  created: string;
  modified: string;
  /** 題名(例: 専任媒介契約書)。 */
  title: string;
  /** 契約書の頁の段落(依頼者・宅建業者の欄と日付の行は除く・書き込み欄は「＿」)。 */
  contract: string[];
  /** 約款の題名と段落。 */
  clausesTitle: string;
  clauses: string[];
}
