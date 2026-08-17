/**
 * 請求リスト(/TeikyoUketsuke/reqf/fudosan-list)の行選択(純関数)。
 *
 * probe13(2026-08-17)で実測確定した迷子箇所の修正の心臓部:
 * 確定(fuBtnForward)の着地はマイページではなく**請求リスト**で、そこから
 * 「対象行の checkbox(#sentaku_N)を1つだけ check →【マイページへ登録】
 * (btnForward2)」を経てはじめて #myPageTable のある画面に着く。
 *
 * ⚠ここは**お金の一歩手前**: check した行がそのまま請求対象になる。
 *  - 過去のテスト/probe の未請求行が同じカートに累積し得る(実測で複数あり)。
 *    地番だけの一致では足りず、**所在(chibanKuiki)・種別(seikyuType)・
 *    未請求(seikyuzumi=false)まで一致した行だけ**を対象にする。
 *  - 同一内容の重複は「同じ商品」なので先頭の1件を使う(2件 check は二重課金
 *    なので呼び出し側が read-back で「ちょうど1件」を必ず実測する)。
 *  - 迷ったら選ばない(0件/曖昧=課金前中止)。
 *
 * auto-fetch.ts から分離しているのは zero-retry-plan.ts と同じ理由
 * (テストが auto-fetch を import すると依存ごと引き込んで node 環境で落ちる)。
 */

import { normalizeChibanForDialog } from "@/lib/registry-fetch/chiban-input";

/** 行の hidden input の id 接頭辞(probe13 実測・例 #chiban_1)。 */
export const FUDOSAN_LIST_HIDDEN_PREFIX = {
  chiban: "chiban_",
  kuiki: "chibanKuiki_",
  seikyuType: "seikyuType_",
  seikyuzumi: "seikyuzumi_",
  ryokin: "ryokin_",
} as const;

/** 行の checkbox(probe13 実測: id=sentaku_N / name="sentaku" / onclick=chkSentaku(this))。 */
export const FUDOSAN_LIST_CHECKBOX_NAME = "sentaku";

export interface FudosanListRow {
  /** 行番号(hidden id の N。checkbox #sentaku_N と対応)。 */
  index: number;
  /** #chiban_N の値(サイトは全角・例「６９－２」)。 */
  chiban: string;
  /** #chibanKuiki_N の値(都道府県から始まる所在・例「神奈川県横浜市南区…」)。 */
  kuiki: string;
  /** #seikyuType_N の値(例「所有者事項」)。 */
  seikyuType: string;
  /** #seikyuzumi_N の値("false"=未請求)。 */
  seikyuzumi: string;
  /** checkbox の現在の状態(着地時点は未チェックが既定・probe13 実測)。 */
  checked: boolean;
}

/**
 * 所在の比較用正規化。全角/半角・空白の揺れだけ吸収する(NFKC+全空白除去)。
 * 数字抽出はしない(所在は文字列そのものが同一性)。
 */
export function normalizeKuikiForCompare(raw: string): string {
  return raw.normalize("NFKC").replace(/\s+/g, "");
}

export type FudosanListPick =
  | { ok: true; index: number; duplicateCount: number }
  | { ok: false; reason: "kuiki-empty" | "no-rows" | "no-match" };

/**
 * 請求対象の行を決める。
 * - expectedKuiki が空(取得失敗)なら選ばない(所在なしの照合は別の筆を掴み得る)。
 * - 一致条件: 地番(normalizeChibanForDialog 同士)・所在(normalizeKuikiForCompare
 *   同士)・種別(trim 一致)・未請求(seikyuzumi.trim()==="false") の**全部**。
 * - 複数一致は同一内容の重複(過去の未請求の残り)なので index 最小の1件を選び、
 *   duplicateCount で残数を返す(呼び出し側が journal に残す)。
 */
export function selectFudosanListRow(
  rows: FudosanListRow[],
  expected: {
    /** normalizeChibanForDialog 済みの対象地番(auto-fetch の targetKey)。 */
    targetKey: string;
    /** 確定前に #fuChibanKuiki から読んだ所在(生値)。 */
    kuiki: string;
    /** 期待する請求種別ラベル(owner=「所有者事項」/ all=「全部事項」)。 */
    seikyuTypeLabel: string;
  },
): FudosanListPick {
  if (!expected.kuiki.trim()) return { ok: false, reason: "kuiki-empty" };
  if (rows.length === 0) return { ok: false, reason: "no-rows" };
  const kuikiKey = normalizeKuikiForCompare(expected.kuiki);
  const matches = rows
    .filter(
      (r) =>
        normalizeChibanForDialog(r.chiban) === expected.targetKey &&
        normalizeKuikiForCompare(r.kuiki) === kuikiKey &&
        r.seikyuType.trim() === expected.seikyuTypeLabel &&
        r.seikyuzumi.trim() === "false",
    )
    .sort((a, b) => a.index - b.index);
  if (matches.length === 0) return { ok: false, reason: "no-match" };
  return { ok: true, index: matches[0].index, duplicateCount: matches.length - 1 };
}
