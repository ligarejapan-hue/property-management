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

/** 漢数字を算用数字にする（丁目の比較用・「十」までで足りる）。 */
function kanjiNumToArabic(k: string): string {
  const d = "〇一二三四五六七八九";
  if (k === "十") return "10";
  const m = k.match(/^十(.)$/u);
  if (m) return `1${d.indexOf(m[1])}`;
  const m2 = k.match(/^(.)十(.)?$/u);
  if (m2) return `${d.indexOf(m2[1])}${m2[2] ? d.indexOf(m2[2]) : 0}`;
  const i = d.indexOf(k);
  return i >= 0 ? String(i) : k;
}

/**
 * 比較用のかたち（全角→半角・空白除去・表記ゆれ吸収）。
 *
 * ⚠**丁目は算用数字にそろえる**(@codex #358 P2)。サイトの一覧は「丸の内一丁目」
 * のように**漢数字**だが、アプリに登録された住所は「丸の内1丁目」のように
 * **算用数字**であることが普通。そろえないと一致せず、
 * **ごく一般的な住所がすべて弾かれる**。
 */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/\s+/gu, "")
    .replace(/[ヶケヵカ]/gu, "ヶ") // 「青ヶ島/青ケ島」「井土ケ谷/井土ヶ谷」の揺れ
    .replace(/([〇一二三四五六七八九十]{1,3})丁目/gu, (_m, k: string) =>
      `${kanjiNumToArabic(k)}丁目`,
    )
    .trim();
}

/**
 * 「丸の内1-1-1」のような郵便表記から、**丁目の部分だけ**を復元する
 * (@codex #358 P2)。
 *
 * アプリの住所欄は「丸の内1-1-1」(丁目-番-号)で入っていることがある。
 * サイトの一覧は「丸の内1丁目」までしか持たない(その先は地番の欄)ので、
 * そのままでは一致しない。先頭の「数字-」を丁目と読み替えて一致させ、
 * 残り(番・号)は地番側の話として後ろに残す。
 *
 * ⚠**そのままで一致しなかったときだけ**使う保険。常に適用すると
 * 「1-1」のような地番そのものを丁目と誤読しかねない。
 */
export function expandChomeShorthand(s: string): string {
  // <地名><数字>-<数字…> の形のときだけ、最初の数字を丁目とみなす。
  return s.replace(/^(\D+?)(\d{1,3})-(?=\d)/u, "$1$2丁目");
}

/**
 * **先頭の数字だけ**を丁目として読む(「2-18-3」→「2丁目18-3」)。
 *
 * ⚠`expandChomeShorthand` との違いは**地名が付いていない**こと。
 * 町名を選び終えた次の段が「一丁目」「二丁目」…と**丁目だけを並べる**作りの
 * 地域では、住所の残りが「2-18-3」のように数字から始まる。
 *
 * ⚠この読み替えは**丁目だけが並ぶ段でしか使ってはいけない**
 * (`isChomeOnlyLevel` で確認する)。地名が並ぶ段で使うと、地番「18-3」を
 * 「18丁目」と読み替えて**無関係な区域を選ぶ**恐れがある。
 */
export function expandLeadingChome(s: string): string {
  const m = /^(\d{1,3})(?:-(?=\d)|$)/u.exec(s);
  if (!m) return s;
  return `${m[1]}丁目${s.slice(m[0].length)}`;
}

/**
 * いま出ている選択肢が**丁目だけ**か(「一丁目」「二丁目」…)。
 *
 * ⚠2026-08-10 本番実障害の核心: 「世田谷区若林2-18-3」は
 * 区 → 町名(若林) → **丁目** の3段で、3段目に来たとき残りは「2-18-3」。
 * これを地番とみなして降りるのをやめると、丁目を選び残したまま
 * サイトの「確定」が有効にならず(`canFix=NO`)、所在が決まらない。
 */
export function isChomeOnlyLevel(items: ShozaiDialogItem[]): boolean {
  if (items.length === 0) return false;
  return items.every((it) => /^\d{1,3}丁目$/u.test(normalizeForMatch(it.text)));
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
  // ⚠タブ重複(全部タブ+五十音タブの同一区域コピー)を先に畳む。畳まないと
  // どの区域も「同名2件=決められない」に当たり全住所が中止になる(実障害)。
  const deduped = dedupeShozaiDialogItems(items);
  const want = normalizeForMatch(remaining);
  const direct = matchOnce(deduped, want);
  if (direct) return direct;
  // ⚠そのままで当たらないときだけ、郵便表記の丁目を復元して再挑戦する
  // (「丸の内1-1-1」→「丸の内1丁目1-1」)。常に適用すると地番を丁目と誤読する。
  const expanded = expandChomeShorthand(want);
  if (expanded !== want) {
    const hit = matchOnce(deduped, expanded);
    if (hit) return hit;
  }
  // ⚠**丁目だけが並ぶ段**では、残りの先頭の数字が丁目そのもの
  // (「2-18-3」→「2丁目」+地番「18-3」)。地名が並ぶ段では絶対に使わない
  // =`isChomeOnlyLevel` で守る(2026-08-10 本番実障害)。
  if (isChomeOnlyLevel(deduped)) {
    const lead = expandLeadingChome(want);
    if (lead !== want) return matchOnce(deduped, lead);
  }
  return null;
}

/** 一覧に対する最長前方一致を1回だけ試す（同じ長さで複数なら決めない）。 */
function matchOnce(
  items: ShozaiDialogItem[],
  want: string,
): DialogPrefixMatch | null {
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

/**
 * 残りが「地番のかたち」か（数字・ハイフン・番・号だけ）。
 *
 * ⚠ダイアログで選ぶのは**地番区域まで**で、地番は別の欄に入れる。
 * 区域を選び終えた後に数字だけが残るのは正常なので、**それを理由に
 * 所在を弾かない**。弾くと「丸の内1丁目1-1」のような普通の住所が通らない。
 */
export function looksLikeLotTail(s: string): boolean {
  const t = normalizeForMatch(s);
  if (!t) return true;
  return /^[0-9\-番地号の]+$/u.test(t);
}

/** ダイアログの1項目 (probe で採った td の姿)。 */
export interface ShozaiDialogItem {
  id: string;
  text: string;
  /**
   * 区域コード (td の onclick=`GKuikiDialogNext('402','青ヶ島村',…)` の第1引数)。
   * 同名の td がコピー(タブ重複)なのか別区域なのかを見分ける唯一の手がかり。
   */
  code?: string;
  /** 見えているタブの中の td か (隠れタブ= `.ui-tabs-hide` 配下は false)。 */
  visible?: boolean;
}

/**
 * ⚠**区域の td は全部タブ+五十音タブで DOM に2回ずつ現れる**(2026-08-07 本番実障害)。
 *
 * ダイアログはタブ構造(全部/あ/か/…)で、**全タブ分の td が同時に DOM にある**
 * (隠れタブは `ui-tabs-hide` で見えないだけ)。そのまま突き合わせると
 * 「横浜市」が2件ヒット=「同名2件は決められない」の安全装置に当たり、
 * **すべての住所が1段目で中止**になっていた。
 *
 * 同じ名前でも**区域コードが同じならコピー**なので1件に畳む。押せるのは
 * 見えている方だけなので、**visible のコピーを優先**して残す。
 * ⚠コードが**違う**同名や、コードが**読めない**同名は畳まない(別区域の
 * 可能性を潰せないときは、従来どおり「決められない=中止」に倒す)。
 */
export function dedupeShozaiDialogItems(
  items: ShozaiDialogItem[],
): ShozaiDialogItem[] {
  const groups = new Map<string, ShozaiDialogItem[]>();
  const order: string[] = [];
  for (const it of items) {
    const key = normalizeForMatch(it.text);
    if (!key) continue;
    const g = groups.get(key);
    if (g) {
      g.push(it);
    } else {
      groups.set(key, [it]);
      order.push(key);
    }
  }
  const out: ShozaiDialogItem[] = [];
  for (const key of order) {
    const g = groups.get(key)!;
    if (g.length === 1) {
      out.push(g[0]);
      continue;
    }
    const codes = g.map((x) => (x.code ?? "").trim());
    const distinct = new Set(codes.filter((c) => c.length > 0));
    if (distinct.size !== 1 || codes.some((c) => c.length === 0)) {
      // コード違い/コード不明の同名＝コピーと断定できない。全員残す
      // (→ 呼び出し側の「同名2件=決められない」で安全に中止する)。
      out.push(...g);
      continue;
    }
    out.push(g.find((x) => x.visible !== false) ?? g[0]);
  }
  return out;
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
