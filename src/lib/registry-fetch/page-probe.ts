/**
 * 実サイト（登記情報提供サービス）の**画面構造だけ**を1回持ち帰るための診断整形。
 *
 * 背景: 有料取得は「確定（無料・カートへ）→ マイページの一覧 → 対象行を選ぶ → 請求（課金）」
 * という順で進む。2026-08-16 の立ち会いテストで **「確定」までは成功し、その次の
 * 「マイページの請求一覧へ移動」で `#myPageTable` 待ちがタイムアウト**した（課金ゼロ）。
 * auto-fetch.ts には開発当初から「⑥以降の画面遷移は実課金テストでしか確定できない」と
 * 注記があり、まさにそこに到達した。**推測で直すとテストを1回無駄にする**ので、
 * 失敗した瞬間の画面構造を記録して持ち帰る。
 *
 * ⚠**PII と物件特定情報を出さないこと**が本モジュールの最重要要件。
 *  - 表の**中身（tbody のセル）は一切読まない**。読むのは `thead` の列見出しと行数だけ。
 *  - 表の**行の中にあるボタン・リンクも走査しない**。行アクションは id を持たず onclick に
 *    その行の識別子が埋まる（@codex 提出前レビュー）。
 *  - 見えている文字（列見出し・ボタン名）は {@link safeLabel} の**許可リスト**を通す。
 *    ⚠当初は「数字を伏せれば安全」としたが、**数字を含まない PII は素通り**した
 *    （所有者名、番地の無い町名。@codex #383 P1）。**伏せ字は匿名化ではない**。
 *  - onclick は {@link maskProbeOnclick} で数字と非 ASCII を落とす（`selectTab('tabMy')` は残す）。
 *  - id / name だけは**コード上の静的な識別子**なのでそのまま残す。これが無いと
 *    セレクタを特定できず診断の意味が無い。
 */

/** ログ1行に載せる上限（journald を溢れさせない）。 */
const MAX_TABLES = 12;
const MAX_BUTTONS = 24;
const MAX_TABS = 12;
const MAX_HEADERS = 8;
/** id / onclick の最大長。 */
const MAX_ID = 60;

/**
 * 切り分けに要る既知セレクタ。**在/不在**を出すことで「どの想定が外れたか」が一目で分かる。
 * ⚠ここに並べる値は auto-fetch.ts の REGISTRY_SELECTORS と一致させる（ずれると診断が嘘をつく）。
 */
export const KNOWN_PROBE_SELECTORS = [
  "#myPageTable",
  "#myPageSeikyu",
  "#siborikomi",
  "#myReloadButton",
  "#fudosanIchiranTbl",
  "a[onclick*=\"selectTab('tabMy')\"]",
] as const;

export interface RegistryPageProbe {
  tables: { id: string; headers: string[]; rowCount: number }[];
  /** onclick は id / name が無いときの識別手段（数字は落とす）。 */
  buttons: { id: string; onclick?: string; label: string; disabled: boolean }[];
  tabs: { label: string; onclick: string }[];
  known: Record<string, boolean>;
}

/**
 * 見えている文字として**そのまま出してよい語**。サイトの固定 UI 文言だけを並べる。
 * ⚠ここに無い語は一切出さない（{@link safeLabel}）。
 */
export const STRUCTURAL_LABELS: readonly string[] = [
  // 操作
  "請求",
  "確定",
  "検索",
  "選択",
  "取消",
  "キャンセル",
  "閉じる",
  "戻る",
  "次へ",
  "前へ",
  "最新表示",
  "表示・保存",
  "ダウンロード",
  "ログアウト",
  "ログイン",
  "すべての選択を取り消す",
  "確定する",
  // 画面・タブ
  "マイページ",
  "不動産請求",
  "地番検索",
  "請求内容選択",
  "お知らせ",
  "社内",
  // 列見出し・状態
  "種別",
  "所在",
  "地番",
  "家屋番号",
  "状態",
  "請求種別",
  "受付番号",
  "請求日時",
  "未請求",
  "請求済",
  "すべて",
  "選択件数",
  "一覧",
  // 請求事項
  "全部事項",
  "所有者事項",
  "地図",
  "土地所在図/地積測量図",
  "地役権図面",
  "建物図面/各階平面図",
  "共同担保目録",
  "信託目録",
  "要",
  "不要",
];

const LABEL_SET = new Set(STRUCTURAL_LABELS);

/**
 * 見えている文字を**許可リスト方式**で安全にする。
 *
 * ⚠当初は「数字を潰せば安全」としたが、**数字を含まない PII は素通り**した
 * （所有者名「田中」、番地を含まない町名「東京都千代田区丸の内」など。@codex #383 P1）。
 * 伏せ字は匿名化ではない。この診断が読むのは**外部サイトの生きたページ**なので、
 * **既知の固定文言だけを通し、それ以外は文字数だけにする**。
 *
 * 診断の価値は落ちない: どのボタン・列が在るかは id と {@link KNOWN_PROBE_SELECTORS} の
 * 在/不在で分かる。未知の文言は「未知が N 個ある」と分かれば足りる。
 */
export function safeLabel(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed === "") return "";
  if (LABEL_SET.has(collapsed)) return collapsed;
  return `(他:${Math.min(collapsed.length, 999)}字)`;
}

/** id / name は静的な識別子なので数字を保つ（`#cbnDlgChibanType0` の 0 が要る）。長さだけ切る。 */
function clipId(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_ID ? `${collapsed.slice(0, MAX_ID - 1)}…` : collapsed;
}

/**
 * onclick は**関数名と ASCII の引数だけ**を残す。
 *
 * ⚠id と扱いを分ける理由:
 *  - `myPageDownload(12345)` のように**その行の識別子**（受付番号相当）を取り得る → 数字を潰す。
 *  - `showOwner('田中')` のように**日本語の引数**を取り得る → **非 ASCII は落とす**。
 * 残したいのは `selectTab('tabMy')` / `fuBtnForward()` のような**ASCII の関数名と引数**で、
 * これがセレクタを組み立てる手がかりになる。日本語も数字も、そこには要らない。
 */
export function maskProbeOnclick(raw: string): string {
  const noDigits = raw.replace(/[0-9０-９]+/g, "＊");

  // ⚠**入力から危ないものを取り除く方式をやめる**。この関数は4度破られた
  // （@codex #383 P1×4）。数字だけ伏せる → 非 ASCII も落とす → 短い英字は通す →
  // 手前で切ると引用符が落ちる → **バッククォート（テンプレート文字列）を見ていない**。
  // 「取り除き漏れ」を1つずつ塞ぐ限り、次の書き方でまた破られる。
  //
  // **許可したものだけで出力を組み立てる**方式に変える。出力に載るのは
  //   ①先頭の関数名（ASCII の識別子）②許可リストに通った引数 ③伏せた引数の文字数
  // だけで、**入力のそれ以外の文字は一切出力へ運ばれない**。
  const head = noDigits.match(/^\s*([A-Za-z_$][A-Za-z_$.＊]{0,40})\s*\(/);
  if (!head) return "(不明な形式)";
  const fnName = head[1];
  const argsPart = noDigits.slice(head[0].length);

  // 引用符が閉じていない＝どこかで切れている。中身を信用できないので失敗側へ倒す。
  if (hasUnbalancedQuotes(argsPart)) return clipId(`${fnName}(…切れた引数は伏せました)`);

  // 引用符（' " ` の3種すべて）で囲まれた引数だけを見る。
  const quoted = [...argsPart.matchAll(/(['"`])(.*?)\1/g)];
  if (quoted.length > 0) {
    const args = quoted
      .slice(0, 4)
      .map(([, , body]) =>
        isSafeOnclickArg(body)
          ? `'${body}'`
          : `'…${Math.min(body.length, 99)}字'`,
      );
    return clipId(`${fnName}(${args.join(",")})`);
  }
  // 引用符で囲まれていない引数は**中身を出さない**（数字は既に ＊ なのでその印だけ残す）。
  const inner = argsPart.slice(0, argsPart.lastIndexOf(")"));
  return clipId(`${fnName}(${inner.trim() === "" ? "" : "＊"})`);
}

/**
 * onclick の文字列引数のうち、そのまま出してよいもの。**完全一致の集合**。
 *
 * ⚠**パターン（前方一致・字数制限）にしない**。`^tab[A-Za-z]{1,15}$` にしたところ
 * **`showOwner('tabitha')`（人名）が通った**（@codex #383 P1・6度目）。
 * 「◯◯で始まれば安全」も推測。安全と言い切れるのは**列挙したものだけ**。
 *
 * ここに載せてよいのは、**コード側が実際にセレクタとして参照している値**に限る。
 * 未知のタブ名は `'…9字'` と文字数だけ出るので、必要になったら**その値を確認してから**
 * 明示的に足す（推測で足さない）。
 */
export const SAFE_ONCLICK_ARGS: ReadonlySet<string> = new Set([
  // auto-fetch.ts の myPageTab セレクタ `a[onclick*="selectTab('tabMy')"]` が参照する値。
  "tabMy",
]);

export function isSafeOnclickArg(body: string): boolean {
  return SAFE_ONCLICK_ARGS.has(body);
}

/**
 * 引用符が閉じていない（＝途中で切れている）か。閉じていなければ失敗側に倒す。
 * ⚠**バッククォートも数える**。テンプレート文字列 `showOwner(`Yamada`)` を見落として
 * 素通りさせた（@codex #383 P1・4度目）。
 */
export function hasUnbalancedQuotes(s: string): boolean {
  return (
    (s.match(/'/g)?.length ?? 0) % 2 !== 0 ||
    (s.match(/"/g)?.length ?? 0) % 2 !== 0 ||
    (s.match(/`/g)?.length ?? 0) % 2 !== 0
  );
}

function take<T>(items: T[], max: number): { shown: T[]; rest: number } {
  return { shown: items.slice(0, max), rest: Math.max(0, items.length - max) };
}

function suffix(rest: number): string {
  return rest > 0 ? ` …他${rest}` : "";
}

/**
 * 1行の診断ログへ整形する。**この文字列がそのまま journald に出る**ので、
 * ここを通っていない生データをログへ渡さないこと。
 */
export function formatRegistryPageProbe(probe: RegistryPageProbe): string {
  const t = take(probe.tables, MAX_TABLES);
  const tables = t.shown
    .map((tbl) => {
      const h = take(tbl.headers, MAX_HEADERS);
      const headers = h.shown.map(safeLabel).join("|") + suffix(h.rest);
      return `${clipId(tbl.id) || "(no-id)"}(rows=${tbl.rowCount}${headers ? `:${headers}` : ""})`;
    })
    .join(" ");

  const b = take(probe.buttons, MAX_BUTTONS);
  const buttons = b.shown
    .map((btn) => {
      const who = clipId(btn.id) || maskProbeOnclick(btn.onclick ?? "") || "(no-id)";
      return `${who}[${safeLabel(btn.label)}${btn.disabled ? ",disabled" : ""}]`;
    })
    .join(" ");

  const tb = take(probe.tabs, MAX_TABS);
  const tabs = tb.shown
    .map((tab) => `${safeLabel(tab.label)}->${maskProbeOnclick(tab.onclick)}`)
    .join(" ");

  const known = Object.entries(probe.known)
    .map(([sel, present]) => `${sel}=${present ? "yes" : "no"}`)
    .join(" ");

  return [
    `tables{${tables}${suffix(t.rest)}}`,
    `buttons{${buttons}${suffix(b.rest)}}`,
    `tabs{${tabs}${suffix(tb.rest)}}`,
    `known{${known}}`,
  ].join(" ");
}
