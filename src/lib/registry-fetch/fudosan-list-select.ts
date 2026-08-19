/**
 * 請求リスト(/TeikyoUketsuke/reqf/fudosan-list)の行選択(純関数)。
 *
 * probe13(2026-08-17)で実測確定した迷子箇所の修正の心臓部:
 * 確定(fuBtnForward)の着地はマイページではなく**請求リスト**。発注者指示
 * (2026-08-18・過去にも同指摘)によりここから**直接請求**する:
 * 「対象行の checkbox(#sentaku_N)を1つだけ check →【請求】(#btn_seikyu)」。
 * マイページへ登録してから請求する遠回りはしない。
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

import {
  isReadableChiban,
  normalizeChibanForDialog,
} from "@/lib/registry-fetch/chiban-input";

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
  /** 種別セル(td[3]・「土地」/「建物」・probe13 実測)。 */
  kind: string;
}

/**
 * サイトが埋め込む数値文字参照(&#31070; / &#x795E; 形式)を実文字へ戻す。
 *
 * ⚠**実測(2026-08-19 第6回テスト・課金ゼロで停止)**: 請求リストの行の
 * 隠しデータ `#chibanKuiki_N` だけは値が**二重エスケープ**されており、
 * 実行時に読める文字列は「神奈川県横浜市南区井土ケ谷中町」ではなく
 * `&#31070;&#22856;…` という ASCII 文字列だった(地番・請求種別・土地/建物は
 * 素の日本語)。素のまま比較すると所在が永久に一致せず、確定後に必ず
 * 「対象の行を特定できません」で止まる(=課金前中止だが取得もできない)。
 * 実在の住所に `&#...;` は現れないので、比較前に解くのは安全。
 */
export function decodeSiteNumericEntities(raw: string): string {
  // ⚠16進は `&#x…;` / `&#X…;` の両方が正しい形(@codex #391 R1: 大文字Xを
  // 受けないと下の startsWith("X") 分岐が死に、解けないまま no-match になる)。
  return raw.replace(/&#([xX][0-9a-fA-F]+|[0-9]+);/g, (_m, code: string) => {
    const isHex = code[0] === "x" || code[0] === "X";
    const n = isHex
      ? Number.parseInt(code.slice(1), 16)
      : Number.parseInt(code, 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : _m;
  });
}

/**
 * 所在の比較用正規化。数値文字参照を解いたうえで、全角/半角・空白の揺れを
 * 吸収する(NFKC+全空白除去)。数字抽出はしない(所在は文字列そのものが同一性)。
 */
export function normalizeKuikiForCompare(raw: string): string {
  return decodeSiteNumericEntities(raw).normalize("NFKC").replace(/\s+/g, "");
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
    /**
     * 期待する不動産種別(「土地」/「建物」・@codex #390 R5 P1)。同じ区域に
     * 同番号の土地(地番)と建物(家屋番号)が両方未請求で居ると、他の4条件だけ
     * では両方一致し、**別種の登記に課金**し得る。
     */
    kindLabel: string;
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
        r.kind.trim() === expected.kindLabel &&
        r.seikyuzumi.trim() === "false",
    )
    .sort((a, b) => a.index - b.index);
  if (matches.length === 0) return { ok: false, reason: "no-match" };
  return { ok: true, index: matches[0].index, duplicateCount: matches.length - 1 };
}

/**
 * マイページ一覧の「所在」セルが対象の地番/家屋番号を指しているかの判定。
 * ⚠部分一致は禁物(@codex #345 P1): 「1-1」は「1-10」「11-1」にも部分一致し
 * 別の登記を掴む。正規化後の**末尾一致+直前文字が数字/ハイフンでない**を要求。
 * (auto-fetch.ts から移動。ブラウザ内 evaluate と対で維持=片方だけ直さない)
 */
export function registryRowMatchesChiban(
  cellText: string,
  normalizedTarget: string,
): boolean {
  const norm = normalizeChibanForDialog(cellText);
  if (normalizedTarget.length === 0) return false;
  if (!norm.endsWith(normalizedTarget)) return false;
  const prev = norm[norm.length - normalizedTarget.length - 1];
  return prev === undefined || !/[0-9-]/.test(prev);
}

/** マイページ一覧の1行(課金後の同定用に読む列だけ)。 */
export interface MyPageScanRow {
  /**
   * **受付番号**(td[6] の2段目・16桁。`<br>` で請求日時と同居)。
   * ⚠2026-08-19 第8回テストで実測: `td[1]`(class=myPageRowId)は受付番号ではなく
   * **画面上の連番(No.)**で、並び順が変わると同じ値が別の行に付く。これを同定キーに
   * していたため、課金直後に最上段へ来た「いま買った行」が No=1 のまま基準に含まれ、
   * 「新規ではない」と除外されて永久に見つからなかった(課金済み・PDF未取得)。
   * 受付番号は行に固有で並び順に影響されない。**必ずこちらを使う**。
   */
  receiptNo: string;
  /** 所在セル(列4)=地番区域+地番。⚠PII: Node のメモリ内のみで扱い、ログに出さない。 */
  shozai: string;
  /**
   * 請求種別セル(列2)の文字。例「不動産登記 （所有者事項）」(probe16 実測)。
   * ⚠所有者事項と全部事項は**別の商品**。同じ筆で両方買っていると、ここを見ないと
   *   取り違える(@codex #394 P1)。
   */
  seikyuType: string;
  /** 状態(列5)。「請求済」のみDL可。 */
  status: string;
  /** 請求日時(td[6] の1段目)。文字列比較で新しさを判定(表示順に依存しない)。 */
  when: string;
  /** PDF有効期限(列9)。空=準備前・「期間超過」=DL不可。 */
  expiry: string;
}

/**
 * 物件の所在(address)の**末尾に入っている対象地番**を外し、照合用の区域だけにする。
 *
 * ⚠なぜ要るか(2026-08-19 本番データ実測): properties.address は
 * 「神奈川県横浜市南区井土ケ谷中町69-2」のように**地番まで入っている**ことがある。
 * これをそのまま区域キーにすると、マイページの所在「土地・…中町６９－２」から
 * 前半を除いた残りが**空**になり、`pickChargedMyPageRow` の②(残りが地番として
 * 説明でき、対象地番と完全一致)を満たせず、**正しい行まで弾いてしまう**。
 *
 * ⚠外すのは**末尾が対象地番と一致するときだけ**。それ以外は1文字も削らない
 * (削ると区域が短くなり「中町」が「中町東」の行を通す=別の筆に化ける)。
 * 判定は正規化後(NFKC・空白除去)の文字列で行い、戻り値も正規化後の区域キー。
 */
export function stripTrailingChibanFromKuiki(
  address: string,
  targetKey: string,
): string {
  const full = normalizeKuikiForCompare(address);
  const target = targetKey.trim();
  if (!full || !target) return full;
  // 末尾から順に切り出し、対象地番そのものになる切れ目を探す(通常は1つだけ)。
  for (let cut = full.length - 1; cut >= 1; cut--) {
    // ⚠**数字/ハイフンの途中では切らない**(提出前レビュー指摘)。
    //   「…中町169-2」から「69-2」を切り出すと区域が「…中町1」になり、
    //   マイページの「…中町１６９－２」の行が残り「69-2」で一致してしまう
    //   =**別の筆(169-2)のPDFを69-2の物件に貼る**。境界でなければ諦める
    //   (=見つからない扱い)方が安全。registryRowMatchesChiban と同じ規則。
    const prev = full[cut - 1];
    if (prev !== undefined && /[0-9-]/.test(prev)) continue;
    const tail = full.slice(cut);
    if (!isReadableChiban(tail)) continue;
    if (normalizeChibanForDialog(tail) !== target) continue;
    return full.slice(0, cut);
  }
  return full;
}

/**
 * 所在の末尾に付いている識別子を外して区域だけにする(@codex #394 R9 P2)。
 *
 * ⚠建物(家屋番号)で探すとき、物件の所在の末尾には**地番**が入っていることが
 * ある(実データ: 「…中町69-2」)。対象キー(家屋番号)しか見ないと外せず、
 * 区域が合わずに『見つかりません』になる。**対象 → もう一方**の順に試す。
 */
export function stripTrailingIdentifierFromKuiki(
  address: string,
  keys: Array<string | null | undefined>,
): string {
  const out = normalizeKuikiForCompare(address);
  for (const key of keys) {
    const k = (key ?? "").trim();
    if (!k) continue;
    const stripped = stripTrailingChibanFromKuiki(out, normalizeChibanForDialog(k));
    if (stripped !== out) return stripped;
  }
  return out;
}


/** 取り込める行か(請求済 × 期限が入っていて期間超過でない)。 */
function isDownloadableRow(r: { status: string; expiry: string }): boolean {
  const status = r.status.trim();
  const expiry = r.expiry.trim();
  return status === "請求済" && expiry !== "" && expiry !== "期間超過";
}

/**
 * 課金直後の「いま買った行」をマイページ全履歴から同定する(提出前レビュー指摘・
 * confidence 82 対応)。⚠マイページは**口座の全物件の履歴**であり、地番の末尾一致
 * だけでは**別の町の同一地番**(例: どこにでもある「1-1」)の行を掴み、他人の筆の
 * PDF を添付し得る。同定は
 *   ①所在の前半が期待の地番区域(都道府県込み)で始まる(別の町を排除)
 *   ②**前半を除いた残り**が、地番として全部説明でき(isReadableChiban)、かつ
 *     正規化して対象地番と**完全一致**する(@codex #390 R1 P1: startsWith だけだと
 *     「中町」が「中町東」を通す=町名が延長された別区域に化ける。残り完全一致なら
 *     「中町東６９－２」の残り「東６９－２」は説明不能で弾かれ、「１６９－２」は
 *     「169-2」≠「69-2」で弾かれる)
 *   ③その中で**受付日時が最新**の行(=いま課金した行。過去の同じ筆の購入より新しい)
 * の3段。**同一性が先・準備状態(readyNow)は後**: 最新行がまだ準備中でも、古い
 * ready 行へ乗り換えない(乗り換えると古い購入のPDFを「今回の結果」として添付する)。
 */
export function pickChargedMyPageRow(
  rows: MyPageScanRow[],
  expected: {
    targetKey: string;
    kuiki: string;
    /**
     * 期待する不動産種別(「土地」/「建物」)。マイページの所在セルは先頭に
     * 種別が付く(2026-08-19 probe16 実測)。地番での請求=土地 / 家屋番号=建物。
     */
    kindLabel: string;
    /**
     * 課金**前**に控えた既存行の**受付番号**(@codex #390 R2 P1)。ここに載っている
     * 行は「今回の課金で作られた行」ではあり得ないため同定から除外する。
     * 新行が非同期でまだ表に出ていない間に、同じ筆の**古い**請求済行だけが
     * 見えている局面で、それを「最新の見えている行」として掴む事故を塞ぐ。
     * ⚠キーは受付番号(td[6]2段目)。並び順で変わる No.(td[1])を使ってはいけない
     * (2026-08-19 第8回テストの実害: 買った行が基準に含まれ永久に見つからなかった)。
     */
    baselineReceiptNos: ReadonlySet<string>;
    /**
     * 期待する謄本の種類(owner=所有者事項 / all=全部事項)。同じ筆で両方買って
     * いると種別を見ないと取り違える(@codex #394 P1)。
     * ⚠**読めた上での不一致だけ弾く**。表記が読めない行は落とさない: 課金後の
     *   同定でここを fail-closed にすると、表記違いだけで**払ったのにPDFを失う**。
     */
    certificateType: "owner" | "all";
    /**
     * 【回収】**取り込める行**(請求済 × 期限内)だけを候補にする(@codex #394 R9 P2)。
     * ⚠有料取得では **false のまま**にする: あちらは『いま買った行』の同定なので、
     *   まだ準備中(請求中)でも**その行**でなければならない。古い ready 行へ
     *   乗り換えると、払った分と違うPDFを『今回の結果』として添付してしまう。
     * 回収は逆に『買ってあるもののうち、いま取り込めるもの』が目的なので true。
     */
    requireReady?: boolean;
  },
): { receiptNo: string; readyNow: boolean; status: string } | null {
  const kuikiKey = normalizeKuikiForCompare(expected.kuiki);
  if (!kuikiKey) return null;
  const matches = rows
    .filter((r) => {
      // 受付番号を持たない行=未請求(まだ買っていない)。買った行は必ず持つ。
      if (r.receiptNo.trim() === "") return false;
      if (expected.baselineReceiptNos.has(r.receiptNo.trim())) return false;
      // ⚠所在セルの先頭の「土地・」「建物・」を外してから比べる(実測)。
      const split = splitMyPageShozai(r.shozai);
      if (split.kindLabel !== expected.kindLabel) return false;
      // 請求種別(所有者事項/全部事項)。読めた場合だけ突き合わせる。
      const rowCert = mypageCertificateTypeOf(r.seikyuType);
      if (rowCert !== null && rowCert !== expected.certificateType) return false;
      const cellKey = normalizeKuikiForCompare(split.rest);
      if (!cellKey.startsWith(kuikiKey)) return false;
      const remainder = cellKey.slice(kuikiKey.length);
      return (
        remainder !== "" &&
        isReadableChiban(remainder) &&
        normalizeChibanForDialog(remainder) === expected.targetKey
      );
    })
    .filter((r) =>
      expected.requireReady === true ? isDownloadableRow(r) : true,
    )
    .sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : 0));
  if (matches.length === 0) return null;
  const best = matches[0];
  const status = best.status.trim();
  const readyNow = isDownloadableRow(best);
  return { receiptNo: best.receiptNo.trim(), readyNow, status };
}

/**
 * 課金前の基準(既存行の受付番号)を1回分の走査から組み立てる(@codex #390 R3 の
 * all-or-nothing を、受付番号ベースへ移した版)。
 *
 * ⚠**未請求の行は受付番号を持たないのが正常**(2026-08-19 実測: td[6] が空)。
 * 旧実装は「空IDが1つでもあれば基準無効」だったが、それを受付番号に適用すると
 * 未請求行があるだけで永久に中止してしまう。⇒ 無効にするのは
 * **「未請求でないのに受付番号が空」**(=読み取り途中/構造想定違い)のときだけ。
 */
export function collectBaselineReceiptNos(
  rows: Array<{ receiptNo: string; status: string }>,
): { ok: boolean; receiptNos: Set<string> } {
  const receiptNos = new Set<string>();
  for (const r of rows) {
    const receiptNo = r.receiptNo.trim();
    const status = r.status.trim();
    if (receiptNo === "") {
      if (status !== "未請求") return { ok: false, receiptNos };
      continue; // 未請求=まだ受付番号が無い(正常)
    }
    receiptNos.add(receiptNo);
  }
  return { ok: true, receiptNos };
}

/**
 * マイページ一覧の1行を、**セルの innerHTML 配列**から組み立てる(純関数)。
 *
 * ⚠**解釈は必ずここに集約する**(@codex #393 R1)。ブラウザ側(evaluate)は
 * 「td の innerHTML を順に返すだけ」に留め、どの列が何かの判断・`<br>` の分解は
 * この関数だけが持つ。列を取り違えても走査テストが緑のまま実運用で落ちる、という
 * 事故(2026-08-19 第8回: td[1]=No. を受付番号と誤認し、課金済みでPDF未取得)を
 * 二度と起こさないため、**実HTMLのセル並びをそのままテストに置く**。
 *
 * 実測の列(2026-08-19 probe16・td数=10):
 *   0=checkbox / 1=No. / 2=請求種別 / 3=請求詳細 / 4=所在 / 5=ステータス /
 *   6=請求日時<br>受付番号 / 7=金額 / 8=PDFサイズ / 9=PDF取得期限
 */
export function parseMyPageRowCells(cellHtmls: string[]): MyPageScanRow | null {
  if (cellHtmls.length < 7) return null; // 実データ行でない(空状態の行など)
  const plain = (html: string): string =>
    html
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const lines = (html: string): string[] =>
    html
      .split(/<br\s*\/?>/i)
      .map((part) => plain(part))
      .filter((part) => part !== "");
  const dateAndReceipt = lines(cellHtmls[6] ?? "");
  return {
    // ⚠受付番号は td[6] の2段目。td[1](No.)は並び順で変わるので使わない。
    receiptNo: dateAndReceipt[1] ?? "",
    when: dateAndReceipt[0] ?? "",
    seikyuType: plain(cellHtmls[2] ?? ""),
    shozai: plain(cellHtmls[4] ?? ""),
    status: plain(cellHtmls[5] ?? ""),
    // 期限も `2026/<br>08/24` のように改行を含むため、行を連結して1つの文字列にする。
    expiry: lines(cellHtmls[9] ?? "").join(""),
  };
}

/**
 * マイページの請求種別セルから**謄本の種類**を読む(読めなければ null)。
 *
 * 実測(probe16): 「不動産登記（所有者事項）」。全部事項の表記は未実測のため、
 * **読めた場合だけ**判断材料にする(下の照合は『読めた上での不一致』だけ弾く)。
 */
export function mypageCertificateTypeOf(
  raw: string,
): "owner" | "all" | null {
  const text = (raw ?? "").normalize("NFKC").replace(/\s+/g, "");
  if (text.includes("所有者事項")) return "owner";
  if (text.includes("全部事項")) return "all";
  return null;
}

/** マイページの所在セルの先頭に付く不動産種別(2026-08-19 probe16 実測)。 */
export const MYPAGE_KIND_PREFIXES = ["土地・", "建物・"] as const;

/**
 * マイページ一覧の所在セルから**種別の接頭辞**を分離する。
 *
 * ⚠実測(probe16): マイページの所在は `土地・神奈川県横浜市南区井土ケ谷中町６９－２`
 * のように**先頭に「土地・」「建物・」が付く**(請求リスト側の hidden とは形が違う)。
 * これを外さずに「所在の前半が期待の地番区域で始まる」を判定すると**常に不一致**に
 * なり、課金後に自分が買った行を永久に見つけられない。
 * 接頭辞は種別の裏取りにも使える(地番での請求=土地 / 家屋番号での請求=建物)。
 */
export function splitMyPageShozai(raw: string): {
  kindLabel: string;
  rest: string;
} {
  const text = raw.trim();
  for (const prefix of MYPAGE_KIND_PREFIXES) {
    if (text.startsWith(prefix)) {
      return { kindLabel: prefix.slice(0, -1), rest: text.slice(prefix.length) };
    }
  }
  return { kindLabel: "", rest: text };
}
