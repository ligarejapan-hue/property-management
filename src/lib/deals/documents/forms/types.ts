/**
 * 項目の表(設計 第2段階 §3.3)。入力画面・PDF・Excel の行は、すべてこの表から作る(項目がずれないように)。
 * ⚠ただのデータにする(関数を入れない)。出せる書類の API がそのまま画面へ渡す。
 */
export interface FormChoice { value: string; label: string }
/** 書き込み欄。key は表の中で重ならない名前(項目の鍵とも重ならない)。 */
export interface FormField { key: string; label: string; max: number; lines?: number }
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
}
export type FormEntry = { kind: "section"; title: string } | FormItem;
export interface FormDef {
  key: string;
  /** 一番上のタブ(同じ書類の中で型を切り替える・第2段階 段D)。値は key の欄に入る(空欄にはならない)。 */
  tabs?: { key: string; label: string; choices: FormChoice[] };
  entries: FormEntry[];
}
/** 発行のときの値(平らな1つの表)。選ぶ項目=値か null(いくつでも=配列)・書き込み欄=文字か null。 */
export type FormValues = Record<string, string | string[] | null>;
