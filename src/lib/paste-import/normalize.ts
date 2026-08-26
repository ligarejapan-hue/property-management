/**
 * 貼り付け取込で全段が共有する正規化。純関数のみ。
 * ⚠ Prisma / next / node:fs を import しないこと。
 */

/** 全角の英数字・記号を半角へ。**カナや漢字は変換しない**（氏名を壊さないため）。 */
export function toHalfWidth(s: string): string {
  return s
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0),
    )
    .replace(/[－ー−―]/g, "-");
}

/**
 * `toHalfWidth` の**逆向き**（半角英数→全角・半角ハイフン→全角ハイフン）。
 *
 * ⚠正規化ではない。「同じ値の**別の書き方**」を作るためだけに使う
 *   (@codex PR#414 2巡目 P2)。CSV取込は外部キーを生値のまま保存するため、
 *   全角で入った既存行を探すには全角形でも引く必要がある。
 *   ⚠**保存する値や助言ロックの鍵には使わない**（そちらは常に toHalfWidth 側）。
 */
export function toFullWidth(s: string): string {
  return s
    .replace(/[A-Za-z0-9]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))
    .replace(/-/g, "－");
}

/** 元号の開始年（その元号の1年＝この西暦）。 */
const ERAS: { name: string; startYear: number }[] = [
  { name: "令和", startYear: 2019 },
  { name: "平成", startYear: 1989 },
  { name: "昭和", startYear: 1926 },
  { name: "大正", startYear: 1912 },
  { name: "明治", startYear: 1868 },
];

/**
 * 和暦（平成8年 など）を西暦に。西暦がそのまま書かれていればその数値を返す。
 * 読み取れなければ null（**推測しない**）。
 */
export function warekiToSeireki(raw: string): number | null {
  const s = toHalfWidth(raw).replace(/[\s　]/g, "");
  if (s === "") return null;

  for (const era of ERAS) {
    if (!s.includes(era.name)) continue;
    const m = new RegExp(`${era.name}(元|\\d{1,2})年`).exec(s);
    if (!m) return null;
    const nth = m[1] === "元" ? 1 : Number(m[1]);
    if (!Number.isFinite(nth) || nth < 1) return null;
    return era.startYear + nth - 1;
  }

  // 西暦（4桁）。年号らしき語が無いときだけ採用する。
  const seireki = /(1[89]\d{2}|20\d{2})\s*年?/.exec(s);
  return seireki ? Number(seireki[1]) : null;
}

/**
 * 面積として受け付ける単位の書き方（数値を取り除いた残り。空白は除去済み）。
 * ⚠**平米だと明示されたものだけ**。空文字＝単位なしの素の数値も認める。
 */
const AREA_SQM_UNITS: ReadonlySet<string> = new Set([
  "",
  "m2",
  "m²",
  "㎡",
  "平米",
  "平方m",
  // ⚠toHalfWidth は長音記号(ー)もハイフンに寄せるため、「平方メートル」は
  //   ここに来る時点で「平方メ-トル」になっている。両方を載せておく
  //   (toHalfWidth の挙動は他から使われているので変えない)。
  "平方メートル",
  "平方メ-トル",
]);

/**
 * 「70 平米」「70.55㎡」などを数値へ。**平米だと分かるものだけ**を採り、
 * それ以外は null（数値が無い / 単位が坪・帖・畳 / 数値が複数 など）。
 *
 * ⚠**最初に見つけた数値を拾ってはいけない**（@codex PR#414 4巡目）。
 *   `20坪（66.1㎡）` から 20 を取ると、確認画面は「20 m²」と表示し、
 *   **66.1㎡ の物件が 20㎡ として登録される**。これはこの機能の設計原則
 *   「拾えなかったから推測で埋める、は行わない」に正面から反する:
 *   値を捨てるのではなく**意味を静かに書き換えている**ので、空欄より悪い。
 * ⚠**坪を換算しない**。換算は新たな推測になる。人が確認画面で入力する。
 */
export function parseAreaSqm(raw: string): number | null {
  // ⚠`m2` の「2」を面積の数値と数え違えないよう、先に `㎡` へ畳んでから数える
  //   (`70m2` が「70 と 2 の2つ」に見えて null になっていた)。
  const s = toHalfWidth(raw)
    .replace(/,/g, "")
    .replace(/[mM][\s　]*2(?![0-9.])/g, "㎡");
  const numbers = s.match(/\d+(?:\.\d+)?/g) ?? [];
  // 数値が無い / 2つ以上（例: `20坪（66.1㎡）`）はどちらが面積か決められない。
  if (numbers.length !== 1) return null;
  const n = Number(numbers[0]);
  if (!Number.isFinite(n)) return null;
  // 数値以外に何が書かれているか（空白は無視して単位だけを見る）。
  const unit = s.replace(numbers[0], "").replace(/[\s　]/g, "");
  if (!AREA_SQM_UNITS.has(unit)) return null;
  return n;
}

/**
 * 住所の括弧書きに入っている地番を分離する。
 * 実サンプル: `世田谷区池尻4丁目26-8（地番552-2）`
 *
 * ⚠ 住居表示と地番は別物で、登記は地番でしか引けない。ここで分けそこねると
 *   後から謄本が取れなくなる。**地番と明記された括弧だけ**を対象にし、
 *   それ以外の括弧書きは住所に残す（勝手に消さない）。
 */
export function splitLotNumberFromAddress(raw: string): {
  address: string;
  lotNumber: string | null;
} {
  const re = /[（(]\s*地番\s*[:：]?\s*([^）)]+?)\s*[）)]/;
  const m = re.exec(raw);
  if (!m) return { address: raw.trim(), lotNumber: null };
  const address = raw.replace(re, "").replace(/[\s　]+$/, "").trim();
  return { address, lotNumber: m[1].trim() };
}

/**
 * 住所の先頭にある**CJK(漢字・かな)の連なり**を返す。DB への前方一致に使う。
 *
 * ⚠なぜ必要か（本番実測 2026-08-26・properties の is_archived=false 669件）:
 *     全角英数を含む       665件（99.4%）
 *     全角ハイフン類を含む 659件
 *   本番の住所はほぼ全件が全角。一方、貼り付け元(Webフォーム)の住所は半角。
 *   生の値で `contains` すると**ほぼ1件も候補にならず**、住所による重複警告が
 *   実質的に機能していなかった（査定ナンバーが無い「空き家相談」の書式では
 *   住所が唯一の手がかりなので、その経路の二重登録が無警告で通っていた）。
 *
 * ⚠氏名で採ったのと同じ形（広く取って、JS側で正規化一致に絞る）。
 *   住所の先頭は都道府県〜町名まで CJK が続き、**全角/半角の別が存在しない**ため、
 *   ここまでを前方一致の種にすれば幅のゆれで取りこぼさない。数字・英字が現れた
 *   ところで打ち切る（そこから先は幅がゆれる）。
 *   最終的な同一判定は find-duplicates.ts の normalizeForCompare が行う。
 */
const CJK_RUN = /^[々〆〇぀-ヿ㐀-䶿一-鿿豈-﫿々ヶヵ]+/;

export function addressSearchPrefix(address: string): string | null {
  const trimmed = address.replace(/^[\s　]+/, "");
  const m = CJK_RUN.exec(trimmed);
  if (!m) return null;
  const prefix = m[0];
  return prefix === "" ? null : prefix;
}
