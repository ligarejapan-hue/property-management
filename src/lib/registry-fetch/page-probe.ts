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
 *  - 見えている文字（列見出し・ボタン名）は {@link maskProbeText} で **2桁以上の数字列を伏せる**。
 *    所在・地番・受付番号は必ず数字を含むため、万一まぎれても復元できない。
 *  - id / onclick は**コード上の識別子**（静的）なのでそのまま残す。これが無いと
 *    セレクタを特定できず診断の意味が無い。
 */

/** ログ1行に載せる上限（journald を溢れさせない）。 */
const MAX_TABLES = 12;
const MAX_BUTTONS = 24;
const MAX_TABS = 12;
const MAX_HEADERS = 8;
/** 見えている文字の最大長。 */
export const MAX_PROBE_TEXT = 40;
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
 * 見えている文字を安全な形にする。**数字列は1桁でも `＊` へ潰す**。
 *
 * ⚠当初「2桁以上」にしたが、地番「69-2」が「＊-2」になり**末尾の1桁が残る**＝
 * 部分的に読めてしまう。列見出し・ボタン名に数字は要らない（要るのは id 側で、
 * そちらは {@link clipId} が数字を保つ）ので、**全桁潰すほうが安全で失うものが無い**。
 */
export function maskProbeText(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  const masked = collapsed.replace(/[0-9０-９]+/g, "＊");
  return masked.length > MAX_PROBE_TEXT
    ? `${masked.slice(0, MAX_PROBE_TEXT - 1)}…`
    : masked;
}

/** id / name は静的な識別子なので数字を保つ（`#cbnDlgChibanType0` の 0 が要る）。長さだけ切る。 */
function clipId(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_ID ? `${collapsed.slice(0, MAX_ID - 1)}…` : collapsed;
}

/**
 * onclick は**関数名だけ**を残し、引数の数字を潰す。
 *
 * ⚠id と扱いを分ける理由: onclick は `myPageDownload(12345)` のように**その行の識別子**
 * （受付番号相当）を引数に取り得る。診断に要るのは関数名（`selectTab`・`fuBtnForward`）
 * だけなので、数字を落としても情報は失われない。
 */
export function maskProbeOnclick(raw: string): string {
  return clipId(raw.replace(/[0-9０-９]+/g, "＊"));
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
      const headers = h.shown.map(maskProbeText).join("|") + suffix(h.rest);
      return `${clipId(tbl.id) || "(no-id)"}(rows=${tbl.rowCount}${headers ? `:${headers}` : ""})`;
    })
    .join(" ");

  const b = take(probe.buttons, MAX_BUTTONS);
  const buttons = b.shown
    .map((btn) => {
      const who =
        clipId(btn.id) || maskProbeOnclick(btn.onclick ?? "") || "(no-id)";
      return `${who}[${maskProbeText(btn.label)}${btn.disabled ? ",disabled" : ""}]`;
    })
    .join(" ");

  const tb = take(probe.tabs, MAX_TABS);
  const tabs = tb.shown
    .map((tab) => `${maskProbeText(tab.label)}->${maskProbeOnclick(tab.onclick)}`)
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
