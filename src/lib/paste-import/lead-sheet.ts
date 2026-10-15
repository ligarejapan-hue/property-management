/**
 * 査定サイトの反響を書き溜めた**顧客管理表(Excel)**の1行を、
 * 「貼り付けて物件化」と同じ下書き(buildPasteDraft)に通せる文章へ組み直す。純関数のみ。
 *
 * ⚠読み取りの規則は**貼り付けと1つ**にする。ここは「表の1行 → 見出し：値の文章」
 *   の変換だけを持ち、住所・種別・面積・築年の解釈は build-draft に任せる
 *   (同じ反響を貼っても Excel から入れても同じ結果になる)。
 * ⚠**物件の備考(誰でも見える欄)へ流れうる文章に、管理の列を入れない**。
 *   見込度・担当者・メモ・年齢などは所有者の備考(owner_note の権限で守られる欄)
 *   へ回す。build-draft が備考へ入れなかった項目(withheldFromNote)も同じ行き先。
 *
 * 対応する書式(発注者の実物 2026-09-28 で確認):
 *   form_text … 1行目=表題・2行目=見出し。URL列に反響メール本文がまるごと入る
 *               (HOME4U・タカウル)。本文が無い行は 姓名/住所 物件名/物件種別 の列で補う。
 *   columns   … 1行目=見出し。項目ごとに列が分かれる(リビンマッチ)。
 *
 * ⚠ Prisma / next / node:fs を import しないこと(純関数を保つため)。
 */
import type { PasteDraft } from "./types";
import { supportsUnitFields } from "@/lib/property-building-name";

export type LeadSheetFormat = "form_text" | "columns";

export interface LeadRow {
  sheetName: string;
  /** Excel 上の行番号(1始まり)。人が元の表と突き合わせるために持つ。 */
  rowNumber: number;
  /** 下書きに通す文章(「見出し：値」の行)。 */
  text: string;
  /** 所有者の備考へ入れる行(管理の列・メモなど)。 */
  ownerNoteLines: string[];
  /**
   * 反響番号が無い行の鍵の材料。**依頼日・氏名・物件の住所だけ**から作る
   * (メモや進み具合を書き足した表を取り込み直しても同じ鍵になり、二重登録しない)。
   */
  keySeed: string;
  /**
   * 所有者の備考に入る**依頼日の行**(例「依頼日付: 2025/07/22」)。無ければ null。
   * 前に Excel で入れた本人かを確かめる手がかり(paste-import-duplicates.ts の
   * findEarlierExcelImport)。同じ人・同じ住所でも依頼日が違えば別の申込とみなす。
   */
  requestDateNoteLine: string | null;
}

/**
 * 依頼日の文字を「年-月-日」に揃える(読めなければ null)。
 * ⚠**同じセルでも Excel の表示形式で文字が変わる**(本番 2026-10-15: 10/13 の取込では
 *   「2024/12/10」、同じ表の今の版では「12/10/24」)。文字のまま比べると同じ申込を
 *   別物と見る。対応する形: 2024/12/10・2024-12-10・2024年12月10日・12/10/24・
 *   12/10/2024(月/日/年=Excel の既定の短い日付)。時刻が後ろに付いていても日付だけ見る。
 */
export function normalizeRequestDate(raw: string): string | null {
  const s = raw.normalize("NFKC").trim();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ok = (y: number, m: number, d: number) =>
    m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : null;
  let m = s.match(/^(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})日?(?:\s|$)/);
  if (m) return ok(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:\s|$)/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return ok(y, Number(m[1]), Number(m[2]));
  }
  return null;
}

/**
 * 備考の2つの依頼日の行(「依頼日付: …」)が同じ申込の日か。
 * 見出しが同じで、日付として同じ(読めないときは文字が同じ)ときだけ true。
 */
export function sameRequestDateLine(a: string, b: string): boolean {
  const split = (l: string) => {
    const i = l.indexOf(":");
    return i === -1 ? null : { key: norm(l.slice(0, i)), value: l.slice(i + 1).trim() };
  };
  const x = split(a);
  const y = split(b);
  if (!x || !y || x.key !== y.key || x.value === "" || y.value === "") return false;
  const dx = normalizeRequestDate(x.value);
  const dy = normalizeRequestDate(y.value);
  return dx !== null && dy !== null ? dx === dy : x.value === y.value;
}

/** 備考の行のうち、依頼日(登録日時)の行。 */
function requestDateLine(ownerNoteLines: readonly string[]): string | null {
  return (
    ownerNoteLines.find((l) => {
      const i = l.indexOf(":");
      const key = i === -1 ? "" : norm(l.slice(0, i));
      return key === norm(FORM.date) || key === norm(COLUMN_DATE);
    }) ?? null
  );
}

export interface LeadSheetResult {
  sheetName: string;
  format: LeadSheetFormat | null;
  rows: LeadRow[];
}

/** 見出しを探す範囲(空でない行の数。表題が数行あっても届くように)。 */
const HEADER_SCAN_ROWS = 5;

/** 見出しの比較用に空白を落とす。 */
function norm(s: string): string {
  return s.replace(/[\s　]/g, "");
}

/** セルの値を1行にまとめる(行単位の読み取りで項目が割れないように)。 */
function oneLine(s: string): string {
  return s.replace(/\r\n|\r|\n/g, " ").replace(/[\s　]+$/, "").replace(/^[\s　]+/, "");
}

/**
 * columns 書式の見出し → 下書きの見出し。**前方一致**(実物の見出しは
 * 「建物面積 」「土地面積 土地面積単位」のように後ろに余計な語が付く)。
 * ⚠ここに無い列はすべて所有者の備考へ回す(文章に入れない)。
 */
const COLUMN_TO_LABEL: readonly { prefix: string; label: string }[] = [
  { prefix: "案件ID", label: "反響番号" },
  { prefix: "姓名", label: "お名前" },
  { prefix: "ふりがな", label: "フリガナ" },
  { prefix: "フリガナ", label: "フリガナ" },
  { prefix: "連絡先住所", label: "ご住所" },
  { prefix: "電話番号", label: "電話番号" },
  { prefix: "メールアドレス", label: "メールアドレス" },
  { prefix: "物件種別", label: "物件種別" },
  { prefix: "建物面積", label: "建物面積" },
  { prefix: "土地面積", label: "土地面積" },
  { prefix: "間取り", label: "間取り" },
  { prefix: "築年", label: "築年" },
  { prefix: "物件の現況", label: "現況" },
];
/** 物件の住所は2列に分かれている(物件所在地 + 所在地(町名以下))。 */
const COLUMN_ADDRESS_HEAD = "物件所在地";
const COLUMN_ADDRESS_TAIL = "所在地(町名以下)";
/** 鍵の材料に使う登録日時の列。 */
const COLUMN_DATE = "登録日時";

/** form_text 書式の列(見出しは空白を落として比べる)。 */
const FORM = {
  date: "依頼日付",
  name: "姓名",
  address: "住所物件名",
  type: "物件種別",
  mail: "URL",
} as const;

function detect(header: readonly string[]): LeadSheetFormat | null {
  const h = header.map(norm);
  if (!h.includes(FORM.name)) return null;
  if (h.includes(FORM.mail) && h.includes(FORM.address)) return "form_text";
  if (h.includes(norm(COLUMN_ADDRESS_HEAD))) return "columns";
  return null;
}

/** 反響メール本文らしいか(「見出し：値」の行が3つ以上)。 */
function looksLikeLabeledText(s: string): boolean {
  return (s.match(/^[^\n：:]{1,30}[：:]/gm) ?? []).length >= 3;
}

function formRow(header: readonly string[], cells: readonly string[]): Omit<LeadRow, "sheetName" | "rowNumber"> {
  const h = header.map(norm);
  const at = (key: string) => {
    const i = h.indexOf(key);
    return i === -1 ? "" : (cells[i] ?? "").trim();
  };
  const mail = at(FORM.mail);
  const lines: string[] = [];
  if (looksLikeLabeledText(mail)) lines.push(mail);
  // ⚠列の値は**本文に無いときの補い**として後ろに足す(下書きは同じ見出しの
  //   先勝ち＝本文の値が優先される)。
  const name = oneLine(at(FORM.name));
  const address = oneLine(at(FORM.address));
  const type = oneLine(at(FORM.type));
  if (name) lines.push(`お名前：${name}`);
  if (address) lines.push(`物件所在地：${address}`);
  if (type) lines.push(`物件種別：${type}`);

  const used = new Set<string>([FORM.name, FORM.address, FORM.type, FORM.mail]);
  const ownerNoteLines: string[] = [];
  header.forEach((label, i) => {
    const key = norm(label);
    if (key === "" || used.has(key)) return;
    const v = (cells[i] ?? "").trim();
    if (v !== "") ownerNoteLines.push(`${label.trim()}: ${v}`);
  });

  return {
    text: lines.join("\n"),
    ownerNoteLines,
    keySeed: [at(FORM.date), name, address].join("|"),
    requestDateNoteLine: requestDateLine(ownerNoteLines),
  };
}

function columnsRow(header: readonly string[], cells: readonly string[]): Omit<LeadRow, "sheetName" | "rowNumber"> {
  const lines: string[] = [];
  const ownerNoteLines: string[] = [];
  let addrHead = "";
  let addrTail = "";
  let date = "";
  let name = "";

  header.forEach((rawLabel, i) => {
    const label = rawLabel.trim();
    const key = norm(label);
    const v = (cells[i] ?? "").trim();
    if (key === "" || v === "") return;
    if (key === norm(COLUMN_ADDRESS_TAIL)) { addrTail = oneLine(v); return; }
    if (key === norm(COLUMN_ADDRESS_HEAD)) { addrHead = oneLine(v); return; }
    if (key === COLUMN_DATE) date = v;
    const mapped = COLUMN_TO_LABEL.find((m) => key.startsWith(norm(m.prefix)));
    if (mapped) {
      if (mapped.label === "お名前") name = oneLine(v);
      lines.push(`${mapped.label}：${oneLine(v)}`);
      return;
    }
    ownerNoteLines.push(`${label}: ${v}`);
  });

  const address = `${addrHead}${addrTail}`;
  if (address !== "") lines.push(`物件所在地：${address}`);
  return {
    text: lines.join("\n"),
    ownerNoteLines,
    keySeed: [date, name, address].join("|"),
    requestDateNoteLine: requestDateLine(ownerNoteLines),
  };
}

/**
 * シート1枚(セルの文字列の2次元配列)を読む。見出しが見つからなければ行を返さない。
 */
export function readLeadSheet(sheetName: string, aoa: readonly (readonly string[])[]): LeadSheetResult {
  let headerIdx = -1;
  let format: LeadSheetFormat | null = null;
  // ⚠空行は数えない(表が下の方から始まるシートでも見出しに届くように)。
  let scanned = 0;
  for (let i = 0; i < aoa.length && scanned < HEADER_SCAN_ROWS; i++) {
    const cells = aoa[i].map((c) => String(c ?? ""));
    if (cells.every((c) => c.trim() === "")) continue;
    scanned++;
    const f = detect(cells);
    if (f) { headerIdx = i; format = f; break; }
  }
  if (format === null) return { sheetName, format: null, rows: [] };

  const header = aoa[headerIdx].map((c) => String(c ?? ""));
  const rows: LeadRow[] = [];
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const cells = aoa[i].map((c) => String(c ?? ""));
    if (cells.every((c) => c.trim() === "")) continue;
    const built = format === "form_text" ? formRow(header, cells) : columnsRow(header, cells);
    if (built.text.trim() === "") continue; // 氏名も住所も本文も無い行(集計行など)
    rows.push({ sheetName, rowNumber: i + 1, ...built });
  }
  return { sheetName, format, rows };
}

/**
 * 反響番号が読めない行に、鍵の行を足す。
 * ⚠鍵は**本文の末尾に「反響番号」として足す**。貼り付け画面へ回した行でも
 *   同じ鍵が付いたまま登録され、どちらの入口から入れても二重登録を止められる。
 */
export function withFallbackLinkKey(text: string, draft: PasteDraft, key: string): string {
  if (draft.externalLinkKey !== null) return text;
  // ⚠**先頭に**置く(@codex PR#491 4巡目)。末尾だと、本文が送り元の署名欄の途中で
  //   切れているとき(閉じる罫線が無い)、署名欄として読み飛ばされて鍵が消える。
  //   反響番号が読めない文章にだけ足すので、本文の番号と先勝ちで競合しない。
  return `反響番号：${key}\n${text}`;
}

/**
 * Excel から入れた所有者の備考の**先頭**。取り込み直しのとき「前に Excel で入れた本人」を
 * 見分ける目印に使う(paste-import-duplicates.ts の findEarlierExcelImport)。
 */
export const EXCEL_IMPORT_NOTE_PREFIX = "Excel取込:";

/**
 * 所有者の備考の中身。取込元の行・管理の列・物件の備考へ入れなかった項目・
 * 見出しの無い行をまとめる(どれも捨てない)。
 */
export function composeLeadOwnerNote(
  row: Pick<LeadRow, "sheetName" | "rowNumber" | "ownerNoteLines">,
  draft: PasteDraft,
): string {
  const lines = [`${EXCEL_IMPORT_NOTE_PREFIX} ${row.sheetName} ${row.rowNumber}行目`, ...row.ownerNoteLines];
  for (const w of draft.withheldFromNote) lines.push(`${w.label}: ${w.value}`);
  for (const u of draft.unlabeled) lines.push(u);
  return lines.join("\n");
}

export type LeadRowStatus = "ready" | "review" | "registered";

/** 区分マンションで専用の欄に入る項目(読めないと空のまま登録される)。 */
const UNIT_FIELD_LABELS: Record<string, string> = {
  exclusiveArea: "専有面積",
  occupancyStatus: "現況",
};

/**
 * まとめて登録してよい行かを決める。
 * ⚠**迷う行は自動で登録しない**(人が1件ずつ確かめる)。既存の物件・所有者へ
 *   自動でつなぐことは一切しない(地番だけの突き合わせで別の区へ誤リンクした
 *   事故 2026-09-10 の教訓)。
 */
export function leadRowStatus(
  draft: PasteDraft,
  dup: {
    blocked: boolean;
    similarCount: number;
    ownerCandidateCount: number;
    ownerCandidatesTruncated: boolean;
  },
): { status: LeadRowStatus; reasons: string[] } {
  if (dup.blocked) return { status: "registered", reasons: [] };
  const reasons: string[] = [];
  if (!draft.property.address.value) reasons.push("物件の住所が読み取れません");
  if (!draft.owner?.name.value) reasons.push("氏名が読み取れません");
  if (!draft.property.propertyType.value || draft.property.propertyType.value === "unknown") {
    reasons.push("物件種別が分かりません");
  }
  // ⚠値を読めなかった項目は、登録すると**専用の欄が空のまま**になるものだけ止める
  //   (@codex PR#456 2巡目 ②)。区分マンションの専有面積・現況がそれに当たる。
  //   築年・土地面積(専用の欄が無い)や区分以外の面積・現況は、原文がそのまま
  //   備考に残る＝貼り付けの確認画面で人が見ても同じ結果になるので止めない。
  if (supportsUnitFields(draft.property.propertyType.value)) {
    for (const w of draft.warnings) {
      if (w.code !== "value_unreadable" || !w.field) continue;
      const label = UNIT_FIELD_LABELS[w.field];
      if (label) reasons.push(`${label}を読み取れません`);
    }
  }
  // ⚠人に確かめてもらう前提の警告は、まとめて登録しない(@codex PR#491 1巡目)。
  //   所有者と申込者が別=申込者の連絡先を所有者名で保存することになる/
  //   部屋番号の食い違い=どちらが正しいか読み取りでは決められない。
  const codes = new Set(draft.warnings.map((w) => w.code));
  if (codes.has("owner_differs_from_applicant")) {
    reasons.push("所有者と申込者が別の方です(連絡先は申込者のもの)");
  }
  if (codes.has("owner_contact_unconfirmed")) {
    reasons.push("申込者のお名前が無く、連絡先が所有者本人のものか分かりません");
  }
  if (codes.has("room_no_conflict")) reasons.push("部屋番号が所在地と建物名で食い違っています");
  if (dup.similarCount > 0) reasons.push("同じ住所の物件がすでにあります");
  if (dup.ownerCandidateCount > 0) reasons.push("同じ名前の所有者がすでにいます");
  if (dup.ownerCandidatesTruncated) reasons.push("同じ名前の所有者が多く、確認しきれません");
  return { status: reasons.length === 0 ? "ready" : "review", reasons };
}
