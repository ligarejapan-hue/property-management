/**
 * LP型の貼り戻し文章を、固定見出しで4部位に切り分ける(設計 2026-09-08 §2.2)。
 * DB を触らない純関数のみ。改行は LF に正規化してから判定する。
 * 文字だけを受け付ける(HTML/URL はそのまま文字として扱い、表示側で escape する)。
 */
import { LETTER_TAGS } from "./tags";

export const LP_SECTIONS = ["見出し", "リード文", "本文", "よくある質問"] as const;
export type LpSection = (typeof LP_SECTIONS)[number];
export const LP_LIMITS = { headline: 60, lead: 300, body: 4000, faqItem: 300, faqCount: 6 } as const;

export type LpFaqItem = { q: string; a: string };
export interface LpTemplateParts { headline: string; lead: string | null; body: string; faq: LpFaqItem[] | null }

export type LpSplitIssue =
  | { code: "MISSING_SECTION" | "DUPLICATE_SECTION" | "ORDER_MISMATCH" | "UNKNOWN_SECTION" | "EMPTY_SECTION" | "HEADLINE_MULTILINE" | "UNKNOWN_TAG"; section: string }
  | { code: "TOO_LONG"; section: string; limit: number }
  | { code: "FAQ_PAIR_MISMATCH" }
  | { code: "FAQ_TOO_MANY"; limit: number };

export type LpSplitResult = { ok: true; parts: LpTemplateParts } | { ok: false; issue: LpSplitIssue };

const HEADING_LINE = /^【([^】]*)】\s*(.*)$/;
const FAQ_Q = /^[QqＱ][.．:：]\s*(.*)$/;
const FAQ_A = /^[AaＡ][.．:：]\s*(.*)$/;

function fail(issue: LpSplitIssue): LpSplitResult {
  return { ok: false, issue };
}

/** 許可タグを取り除いた後に波かっこが残れば未知タグ(body-validation と同じ考え方)。 */
function hasBadTag(text: string): boolean {
  const rest = LETTER_TAGS.reduce((acc, tag) => acc.split(`{{${tag}}}`).join(""), text);
  return rest.includes("{") || rest.includes("}");
}

function parseFaq(lines: string[]): { faq: LpFaqItem[] } | { issue: LpSplitIssue } {
  const items: LpFaqItem[] = [];
  let cur: { q: string; a: string | null } | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const q = FAQ_Q.exec(line);
    const a = FAQ_A.exec(line);
    if (q) {
      if (cur && cur.a === null) return { issue: { code: "FAQ_PAIR_MISMATCH" } };
      if (cur) items.push({ q: cur.q, a: cur.a as string });
      cur = { q: q[1].trim(), a: null };
    } else if (a) {
      if (!cur || cur.a !== null) return { issue: { code: "FAQ_PAIR_MISMATCH" } };
      cur.a = a[1].trim();
    } else {
      // 続きの行: 直前の Q か A に結合する。
      if (!cur) return { issue: { code: "FAQ_PAIR_MISMATCH" } };
      if (cur.a === null) cur.q = `${cur.q}\n${line}`;
      else cur.a = `${cur.a}\n${line}`;
    }
  }
  if (cur) {
    if (cur.a === null) return { issue: { code: "FAQ_PAIR_MISMATCH" } };
    items.push({ q: cur.q, a: cur.a });
  }
  return { faq: items };
}

export function splitLpTemplate(raw: string): LpSplitResult {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const found = new Map<LpSection, string[]>();
  let current: LpSection | null = null;
  let lastIndex = -1;

  for (const line of lines) {
    const m = HEADING_LINE.exec(line.trim());
    if (m) {
      const name = m[1].trim();
      const idx = (LP_SECTIONS as readonly string[]).indexOf(name);
      if (idx < 0) return fail({ code: "UNKNOWN_SECTION", section: name });
      const section = LP_SECTIONS[idx];
      if (found.has(section)) return fail({ code: "DUPLICATE_SECTION", section });
      if (idx < lastIndex) return fail({ code: "ORDER_MISMATCH", section });
      lastIndex = idx;
      current = section;
      found.set(section, m[2] ? [m[2]] : []);
      continue;
    }
    if (current === null) {
      if (line.trim().length === 0) continue;
      return fail({ code: "UNKNOWN_SECTION", section: "(見出しの前)" });
    }
    found.get(current)!.push(line);
  }

  for (const required of ["見出し", "本文"] as const) {
    if (!found.has(required)) return fail({ code: "MISSING_SECTION", section: required });
  }

  const text = (s: LpSection) => (found.get(s) ?? []).join("\n").trim();

  const headline = text("見出し");
  if (headline.length === 0) return fail({ code: "EMPTY_SECTION", section: "見出し" });
  if (headline.includes("\n")) return fail({ code: "HEADLINE_MULTILINE", section: "見出し" });
  if (headline.length > LP_LIMITS.headline) return fail({ code: "TOO_LONG", section: "見出し", limit: LP_LIMITS.headline });
  if (hasBadTag(headline)) return fail({ code: "UNKNOWN_TAG", section: "見出し" });

  let lead: string | null = null;
  if (found.has("リード文")) {
    lead = text("リード文");
    if (lead.length === 0) return fail({ code: "EMPTY_SECTION", section: "リード文" });
    if (lead.length > LP_LIMITS.lead) return fail({ code: "TOO_LONG", section: "リード文", limit: LP_LIMITS.lead });
    if (hasBadTag(lead)) return fail({ code: "UNKNOWN_TAG", section: "リード文" });
  }

  const body = text("本文");
  if (body.length === 0) return fail({ code: "EMPTY_SECTION", section: "本文" });
  if (body.length > LP_LIMITS.body) return fail({ code: "TOO_LONG", section: "本文", limit: LP_LIMITS.body });
  if (hasBadTag(body)) return fail({ code: "UNKNOWN_TAG", section: "本文" });

  let faq: LpFaqItem[] | null = null;
  if (found.has("よくある質問")) {
    const parsed = parseFaq(found.get("よくある質問") ?? []);
    if ("issue" in parsed) return fail(parsed.issue);
    if (parsed.faq.length === 0) return fail({ code: "EMPTY_SECTION", section: "よくある質問" });
    if (parsed.faq.length > LP_LIMITS.faqCount) return fail({ code: "FAQ_TOO_MANY", limit: LP_LIMITS.faqCount });
    for (const item of parsed.faq) {
      if (item.q.length > LP_LIMITS.faqItem || item.a.length > LP_LIMITS.faqItem) {
        return fail({ code: "TOO_LONG", section: "よくある質問", limit: LP_LIMITS.faqItem });
      }
      if (hasBadTag(item.q) || hasBadTag(item.a)) return fail({ code: "UNKNOWN_TAG", section: "よくある質問" });
    }
    faq = parsed.faq;
  }

  return { ok: true, parts: { headline, lead, body, faq } };
}

export function lpSplitIssueMessage(issue: LpSplitIssue): string {
  switch (issue.code) {
    case "MISSING_SECTION": return `【${issue.section}】の見出しがありません。指示文どおりの見出しで区切ってください`;
    case "DUPLICATE_SECTION": return `【${issue.section}】の見出しが2回あります`;
    case "ORDER_MISMATCH": return `【${issue.section}】の順番が違います(見出し→リード文→本文→よくある質問)`;
    case "UNKNOWN_SECTION": return `知らない見出し「${issue.section}」があります。使えるのは 見出し・リード文・本文・よくある質問 の4つです`;
    case "EMPTY_SECTION": return `【${issue.section}】の中身が空です`;
    case "HEADLINE_MULTILINE": return "【見出し】は1行にしてください";
    case "UNKNOWN_TAG": return `【${issue.section}】に使えない差し込み記号があります。使えるのは {{物件所在}} と {{物件種別}} だけです`;
    case "TOO_LONG": return `【${issue.section}】が長すぎます(上限 ${issue.limit} 字)`;
    case "FAQ_PAIR_MISMATCH": return "【よくある質問】は Q. と A. を対にして書いてください";
    case "FAQ_TOO_MANY": return `【よくある質問】は ${issue.limit} 組までです`;
  }
}

/** 本文の行頭 ■ の小見出しを順に返す(PR2 の「節ごとの写真/図」で使う)。 */
export function lpBodyHeadings(body: string): string[] {
  return body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("■"))
    .map((l) => l.slice(1).trim())
    .filter((l) => l.length > 0);
}
