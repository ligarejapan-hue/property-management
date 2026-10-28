/** 全宅連の物件状況確認書(告知書)から写した文面(設計 第2段階 §3.4)。scripts/deals/extract-zentaku-disclosure.py が作る。 */
export type GuideBlock = { kind: "note"; text: string } | { kind: "row"; item: string; text: string };
export interface DisclosureSource {
  source: string;
  created: string;
  modified: string;
  /** 表紙(「…ご記入にあたって」と売主様へのお願い)。 */
  coverTitle: string;
  cover: string[];
  /** 「ご記入にあたって」(記入の要領)。 */
  guideTitle: string;
  guide: GuideBlock[];
  /** 告知書の頁のセルの文字(並びはシートの行の順)。項目の表の文字の突き合わせに使う。 */
  formCells: string[];
}
