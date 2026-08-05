/**
 * 所在（地番区域）の指定を「所在選択ダイアログ」で行うための純ロジック。
 *
 * 発注者判断 (2026-08-04): **B案 = サイト推奨のダイアログ方式**で直す。
 *
 * ⚠なぜ直接入力をやめるのか:
 * 直接入力モードで所在欄に住所を入れる方式だと、実機で
 * 「**請求できない所在です**。直接入力のチェックを外し、所在選択ボタンを
 *  クリックし、ダイアログから所在を選択してください」と赤字で止まる。
 * 登記の「所在」は住所ではなく**地番区域**で、サイトが持つコードで
 * 確定させないと請求まで進めない。
 *
 * ダイアログの作り (2026-08-05 本番probe で採取):
 *  - 都道府県を選ぶまで「所在選択」ボタンは押せない (disabled)
 *  - 押すと `#kuikiDialogArea` が開き、中身は**後から読み込む**
 *    (「読み込み中・・・・」が消えるまで待つ)
 *  - 区域は `<td id="GKuikiN" onclick="GKuikiDialogFixed(code, name, ...)">名前</td>`
 *  - 上部に選択済みの階層 (例「東京都>渋谷区>」) が出る
 *  - ボタンは 確定 / 戻る / 取消 (id なし・文言で引く)
 *
 * この階層は市区町村までのこともあれば、その下に大字・丁目が続くこともある。
 * **段数を決め打ちにしない**で「住所の残りを、出てきた選択肢と突き合わせて
 * 進めるところまで進む」形にする。
 */

/** 全角英数字・記号を半角へ寄せ、空白を落とした比較用のかたち。 */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/\s+/gu, "")
    .replace(/[ヶケヵカ]/gu, "ヶ") // 「青ヶ島/青ケ島」「井土ケ谷/井土ヶ谷」の揺れ
    .trim();
}

/**
 * ⚠**住所を自前の規則で切らない**(@codex #358 P2)。
 *
 * 「市区町村郡」の文字で切る方式は、**その文字を名前の途中に含む自治体**で壊れる:
 *   東村山市 → 「東村」「山市」/ 四日市市 → 「四日市」「市」/ 大町市 → 「大町」「市」
 * 切り損ねた断片は次の段の選択肢に一致せず、**その住所が永久に検索できなくなる**。
 *
 * 正解はサイトが持っている。各段で出てくる選択肢のうち、**住所の残りの先頭に
 * 一致するもの**を選び、一致した分だけ residual を削って次の段へ進む。
 * こうすれば自治体名の綴りを此方が知っている必要がない。
 */

/** 前方一致で1段ぶんを決めた結果。 */
export interface DialogPrefixMatch {
  item: ShozaiDialogItem;
  /** 一致した分を取り除いた「住所の残り」。 */
  rest: string;
}

/**
 * いま出ている選択肢から、住所の残りの**先頭に一致するもの**を1つ決める。
 *
 * ⚠**最長一致**を採る。「大田区」と「大田」が両方あれば長い方が正しい段。
 * ⚠**同じ長さで複数**に当たったら決めない(null)。当てずっぽうで選ぶと、
 * 利用者が意図しない土地の謄本を後段で買うことになる。
 */
export function matchDialogItemByPrefix(
  items: ShozaiDialogItem[],
  remaining: string,
): DialogPrefixMatch | null {
  const want = normalizeForMatch(remaining);
  if (!want) return null;
  let best: { item: ShozaiDialogItem; len: number } | null = null;
  let tie = false;
  for (const it of items) {
    const t = normalizeForMatch(it.text);
    if (!t || !want.startsWith(t)) continue;
    if (!best || t.length > best.len) {
      best = { item: it, len: t.length };
      tie = false;
    } else if (t.length === best.len) {
      tie = true; // 同じ長さの別候補＝どちらか決められない
    }
  }
  if (!best || tie) return null;
  return { item: best.item, rest: want.slice(best.len) };
}

/** ダイアログの1項目 (probe で採った td の姿)。 */
export interface ShozaiDialogItem {
  id: string;
  text: string;
}

/**
 * 出ている選択肢の中から、次に選ぶべき項目を決める。
 *
 * 判定は段階的にゆるめる:
 *  1. 完全一致（最も安全）
 *  2. 選択肢が住所断片で始まる（「南区」に対する「南区」など）
 *  3. 住所断片が選択肢で始まる（住所側が細かいとき）
 *
 * ⚠**あいまい一致で複数に当たったら選ばない**。別の区域を勝手に選ぶと、
 * 利用者が意図しない土地の謄本を（後段で）請求してしまう。
 * 決められないときは null を返し、呼び出し側が中止する。
 */
export function pickDialogItem(
  items: ShozaiDialogItem[],
  segment: string,
): ShozaiDialogItem | null {
  const want = normalizeForMatch(segment);
  if (!want) return null;
  const norm = items.map((it) => ({ it, t: normalizeForMatch(it.text) }));

  const exact = norm.filter((x) => x.t === want);
  if (exact.length === 1) return exact[0].it;
  if (exact.length > 1) return null; // 同名が複数＝決められない

  const startsWith = norm.filter((x) => x.t.startsWith(want));
  if (startsWith.length === 1) return startsWith[0].it;
  if (startsWith.length > 1) return null;

  const contained = norm.filter((x) => want.startsWith(x.t));
  if (contained.length === 1) return contained[0].it;
  return null;
}

/**
 * 選択済みの階層表示（例「東京都>渋谷区>」）を段の配列にする。
 * 進んだかどうかの判定に使う（同じままなら選択が効いていない）。
 */
export function parseSelectedPath(text: string): string[] {
  return normalizeForMatch(text)
    .split(">")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/** ダイアログのボタン文言（id を持たないため文言で引く）。 */
export const SHOZAI_DIALOG_BUTTONS = {
  fix: "確定",
  back: "戻る",
  cancel: "取消",
} as const;

/**
 * ⚠**ページ本体の「確定」(fuBtnForward) と混同しない**ための番人。
 *
 * ページ本体の確定は**カートに未請求の行を作る**ため、所在選択の段階で
 * 押してはいけない。ダイアログ内の「確定」は選んだ所在を欄に入れるだけで
 * 課金にもカートにも触れない。文言が同じなので、探す範囲を
 * **ダイアログのボタン列に限定する**ことでしか区別できない。
 */
export const SHOZAI_DIALOG_BUTTON_SCOPE = ".ui-dialog-buttonpane button";
