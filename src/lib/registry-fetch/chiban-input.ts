/**
 * 地番/家屋番号の「読める形か」の判定。
 *
 * 設計: docs/superpowers/specs/2026-08-12-registry-chiban-popup-design.md §4.3
 *
 * ## なぜ必要か
 * `normalizeChibanForDialog` は数字とハイフン以外を**全部削除する**ので、
 * `abc1x2` も `1号2` も同じ `12` になる。`12` は**別の筆**を指し得るうえ、
 * 一括取得は候補が1件なら自動で買うので、**誤った登記を買って添付・取込まで進む**。
 *
 * ## 文字クラスはここが正本
 * ⚠ `normalizeChibanForDialog`（auto-fetch.ts）も**ここの正規表現を使う**。
 * 2か所に書くと、片方に表記が足されたときにずれ、
 * 「入力の検査は通ったのに、正規化すると別の筆を指す」状態ができる。
 *
 * ⚠ 受理する範囲を勝手に狭めない。既に保存されている物件や取込済みのCSVに
 * 「1番地2」「1ノ2」のような表記が入っており、狭めると**今まで取れていたものが
 * 取れなくなる**。
 */

/**
 * 区切りとして受理する表記。
 * ⚠「号」は入れない（地番の区切りではなく別の意味を持つため。
 *   入れると `1号2` が `1-2` として通り、別の筆を指す）。
 */
export const CHIBAN_SEPARATOR_SOURCE = "番地|番|の|ノ";

/** ハイフンへ寄せるダッシュ・長音記号。 */
export const CHIBAN_DASH_SOURCE = "[‐‑‒–—―−ー－]";

/** 全角数字。 */
export const CHIBAN_FULLWIDTH_DIGIT_SOURCE = "[０-９]";

/**
 * 全角数字を半角へ寄せる（正規化と判定で共用）。
 * ⚠ 正規表現はここで都度作る（`g` フラグ付きを使い回すと `lastIndex` を持ち越す）。
 */
export function toHalfWidthDigits(input: string): string {
  return input.replace(
    new RegExp(CHIBAN_FULLWIDTH_DIGIT_SOURCE, "g"),
    (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0),
  );
}

/** 区切り表記をハイフンへ寄せる。 */
export function unifyChibanSeparators(input: string): string {
  return input
    .replace(new RegExp(CHIBAN_SEPARATOR_SOURCE, "g"), "-")
    .replace(new RegExp(CHIBAN_DASH_SOURCE, "g"), "-");
}

/**
 * 「正規化してみて、元の文字が全部説明できるか」で判定する。
 *
 * 元の文字のうち、次のいずれでもない文字が1つでもあれば **読めない形**:
 *  - 数字（全角を半角へ寄せた後）
 *  - 区切り（番地 / 番 / の / ノ）
 *  - ハイフン・ダッシュ・長音記号
 *
 * さらに、**数字が1つも残らない**値も読めない形とする（`あ番` → 空・`-` → 空）。
 *
 * ⚠ 表を人手で写した allowlist にしない。上の定数から導くことで、
 *   正規化側に表記が足された/削られたときに片方だけずれるのを防ぐ。
 */
export function isReadableChiban(raw: string | null | undefined): boolean {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (trimmed === "") return false;

  const halfWidth = toHalfWidthDigits(trimmed);

  // 説明できる文字をすべて取り除いた残りが空なら「全部説明できた」。
  const rest = unifyChibanSeparators(halfWidth).replace(/[0-9-]/g, "");
  if (rest !== "") return false;

  // 数字が残らない値は宛先にならない。
  return /[0-9]/.test(halfWidth);
}

/**
 * 地番/家屋番号を、地番検索ダイアログの「数字・ハイフンのみ」欄(#cbnDlgChibanType0 +
 * #cbnDlgSearchChibanStart)が受理する形へ正規化する(@codex P1)。リポジトリの通常表記
 * (pdf-registry-parser 由来の「1番1」「1937番31」や全角「１－１」)をそのまま数字専用欄へ
 * 渡すと弾かれ候補ゼロになるため、全角数字→半角・「番(地)」→ハイフン・各種ダッシュ→半角
 * ハイフンに変換し、数字/ハイフン以外を除去する。純関数(テスト可能)。
 * 区切り「番(地)」「の(ノ)」はハイフンへ変換する(@codex P2)。「の」は registry-address-cleanup が
 * 地番/家屋番号の区切りとして認識する形式(例「1番2の3」)で、除去して隣接数字を連結すると別物件に
 * なるため、除去前にハイフン化する。
 * 例: 「1番1」→「1-1」/「1937番31」→「1937-31」/「1番2の3」→「1-2-3」/「５番」→「5」/「１－１」→「1-1」。
 * (もとは auto-fetch.ts に居たが、請求リストの行照合(fudosan-list-select.ts)とも
 *  共有するため文字クラスの正本であるこのファイルへ移動。auto-fetch は再エクスポート)
 */
export function normalizeChibanForDialog(raw: string): string {
  return unifyChibanSeparators(toHalfWidthDigits(raw.trim()))
    .replace(/[^0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}
