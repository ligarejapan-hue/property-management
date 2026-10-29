/**
 * 項目の表(設計 第2段階 §3.3)。入力画面・PDF・Excel の行は、すべてこの表から作る(項目がずれないように)。
 * ⚠ただのデータにする(関数を入れない)。出せる書類の API がそのまま画面へ渡す。
 */
export interface FormChoice { value: string; label: string }
/**
 * 書き込み欄。key は表の中で重ならない名前(項目の鍵とも重ならない)。
 * after = 下線の後ろに名前を出す(「＿年」)・pre = 下線の前に出す書式の字(「時期：」「（資料名：」など)。
 */
export interface FormField { key: string; label: string; max: number; lines?: number; after?: boolean; pre?: string }
export interface FormItem {
  kind: "item";
  key: string;
  label: string;
  /** 選び方(無ければ書き込みだけの項目)。 */
  choices?: FormChoice[];
  /** いくつでも選べる(チェックボックス)。 */
  multiple?: boolean;
  fields?: FormField[];
  /** when を選んだときだけ出す注意書き。 */
  note?: { when: string; text: string };
  /** タブ(FormDef.tabs)の値がこの中のときだけ出す。無ければいつも出す。 */
  only?: string[];
  /** 番号の行の下の行(PDF では項目の欄を空け、状況の欄の頭に見出しを出す・告知書)。 */
  sub?: boolean;
  /** 入力欄だけに出し、PDF・Excel には出さない(説明のページを付けるかなどの設定)。 */
  noPrint?: boolean;
  /** 下線の後ろに字を出す欄を、見出しと選択肢より前に出す(告知書 ⑭「方角:＿側／所有者：□売主」)。 */
  fieldsFirst?: boolean;
  /** 下線の後ろに字を出す欄を、この選択肢のすぐ後ろに括弧で囲んで出す(PDF・告知書 ⑤「実施している(＿年＿月頃)」・2026-10-30)。 */
  fieldsAt?: { choice: string; open: string; close: string };
  /** 選択肢を囲む書式の字(PDF・告知書 ⑧「（□報告書・□概要）」・2026-10-30)。 */
  around?: [string, string];
  /** 入力欄と Excel での名前(書式の字が同じ見出しが2つあるとき・PDF は label のまま・2026-10-30)。 */
  name?: string;
}
export type FormEntry = { kind: "section"; title: string; only?: string[] } | FormItem;
export interface FormDef {
  key: string;
  /**
   * 選ばなかった選択肢の PDF での出方。box(無ければ)= □ を並べる・plain = 丸も □ も付けず、書き込み欄は下線のまま
   * (媒介契約書・付帯設備表は書式の字に丸を付ける形なので plain)。入力欄の空欄の選択肢の説明に使う(2026-10-30)。
   */
  blankStyle?: "box" | "plain";
  /** 一番上のタブ(同じ書類の中で型を切り替える・第2段階 段D)。値は key の欄に入る(空欄にはならない)。 */
  tabs?: { key: string; label: string; choices: FormChoice[] };
  entries: FormEntry[];
}
/** 発行のときの値(平らな1つの表)。選ぶ項目=値か null(いくつでも=配列)・書き込み欄=文字か null。 */
export type FormValues = Record<string, string | string[] | null>;
