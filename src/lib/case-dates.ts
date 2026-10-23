/**
 * 契約予定日・決済予定日(案件ステータスが 契約予定/契約完了/決済完了 のときだけ出る欄)の決まり。
 * 2026-10-23 発注者指示。Prisma・DOM を持ち込まない純関数(画面・API・CSV で共有)。
 *
 * - 保存する欄は2つだけ(contractPlannedOn / settlementPlannedOn)。NULL=未定。
 * - 見出しだけが進み具合で変わる(契約予定日→契約日、決済予定日→決済日)。
 * - 日付は "YYYY-MM-DD" で画面と行き来する(DB は DATE・Prisma は UTC の 0 時の Date)。
 */

export const CASE_DATE_STATUSES = ["contract_planned", "contracted", "sold"] as const;
export const CASE_DATE_FIELDS = ["contractPlannedOn", "settlementPlannedOn"] as const;
export type CaseDateField = (typeof CASE_DATE_FIELDS)[number];

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** 欄を出すステータスか(契約予定・契約完了・決済完了)。 */
export function showsCaseDates(caseStatus: string): boolean {
  return (CASE_DATE_STATUSES as readonly string[]).includes(caseStatus);
}

/** 2欄の見出し。値は同じでも、進むと「契約日」「決済日」に変わる。 */
export function caseDateLabels(caseStatus: string): { contract: string; settlement: string } {
  switch (caseStatus) {
    case "contracted":
      return { contract: "契約日", settlement: "決済予定日" };
    case "sold":
      return { contract: "契約日", settlement: "決済日" };
    default:
      return { contract: "契約予定日", settlement: "決済予定日" };
  }
}

/** "YYYY-MM-DD" を暦で検査して UTC の 0 時の Date にする。暦にない日・形が違う→ null。 */
export function parseDateOnly(s: string): Date | null {
  const m = DATE_ONLY_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}

/** Date(UTC の 0 時)・ISO 文字列・"YYYY-MM-DD" → "YYYY-MM-DD"。空・壊れた値は null。 */
export function dateOnlyString(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }
  const head = v.slice(0, 10);
  return parseDateOnly(head) ? head : null;
}

/** 画面の表示。"2026/11/15"(年なしは "11/15")。未定(null)は「未定」。 */
export function formatDateOnlyJa(s: string | null | undefined, opts: { withYear?: boolean } = {}): string {
  const d = s ? parseDateOnly(s) : null;
  if (!d) return "未定";
  const mo = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return opts.withYear === false ? `${mo}/${day}` : `${d.getUTCFullYear()}/${String(mo).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
}

/** 端末の時刻で今日の "YYYY-MM-DD"(画面の「あと N 日」の基準)。 */
export function todayDateOnly(now: Date = new Date()): string {
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

function daysBetween(from: string, to: string): number | null {
  const a = parseDateOnly(from);
  const b = parseDateOnly(to);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

/**
 * 予定日の前後の知らせ。
 * - 契約予定: 契約予定日を見る。過ぎていれば「契約予定日を N 日過ぎています」(琥珀色)、先なら「契約まであと N 日」。
 * - 契約完了: 決済予定日を同じように見る。
 * - 決済完了・それ以外・未定: 知らせない(null)。
 */
export function caseDateNotice(
  caseStatus: string,
  contractOn: string | null,
  settlementOn: string | null,
  today: string,
): { kind: "overdue" | "soon"; text: string } | null {
  let target: string | null;
  let name: string;
  if (caseStatus === "contract_planned") {
    target = contractOn;
    name = "契約";
  } else if (caseStatus === "contracted") {
    target = settlementOn;
    name = "決済";
  } else {
    return null;
  }
  if (!target) return null;
  const diff = daysBetween(today, target);
  if (diff == null) return null;
  if (diff < 0) return { kind: "overdue", text: `${name}予定日を ${-diff} 日過ぎています` };
  if (diff === 0) return { kind: "soon", text: `${name}は今日` };
  return { kind: "soon", text: `${name}まであと ${diff} 日` };
}

/** 一覧の2行目。「契約 11/15 ・ 決済 未定」。欄を出さないステータスでは null。 */
export function caseDatesSummary(caseStatus: string, contractOn: string | null, settlementOn: string | null): string | null {
  if (!showsCaseDates(caseStatus)) return null;
  return `契約 ${formatDateOnlyJa(contractOn, { withYear: false })} ・ 決済 ${formatDateOnlyJa(settlementOn, { withYear: false })}`;
}
