/**
 * 公開LP(設計 2026-09-08 §2.4)の描画入力。DB 行 → 純粋な描画入力への変換だけを担う。
 *  - 差し込みは町名までの所在と物件種別の2つだけ(expandLetterTags を共用)。解決できなければ一般語に置換し、
 *    波括弧を所有者の画面に出さない。
 *  - LpRenderInput には氏名・番地・所有者住所を**持たせない**(キー集合をテストで固定)。
 */
import { expandLetterTags, hasUnresolvedTag, coarsePropertyLocation, propertyTypeLabel } from "./tags";
import type { LpFaqItem } from "./lp-template";
import { isFigureKind, type FigureKind } from "./lp-figures";

export type LpMode = "live" | "preview";
export interface LpImage { publicId: string; width: number; height: number }
export type LpSectionMedia = { kind: "asset"; image: LpImage } | { kind: "figure"; figureKind: FigureKind } | null;
export interface LpRenderInput {
  mode: LpMode;
  headline: string;
  lead: string | null;
  intro: string[];
  sections: Array<{ heading: string; paragraphs: string[]; media: LpSectionMedia }>;
  faq: LpFaqItem[];
  hero: LpImage | null;
  company: { name: string | null; contact: string | null; phone: string | null };
  unsubscribeUrl: string | null;
  phoneTapToken: string | null;
  form: null;
}
export const LP_RENDER_INPUT_KEYS = ["mode", "headline", "lead", "intro", "sections", "faq", "hero", "company", "unsubscribeUrl", "phoneTapToken", "form"] as const;

const FALLBACK_LOCATION = "ご所有の物件の周辺";
const FALLBACK_TYPE = "不動産";

export function expandLpText(text: string, values: { location: string | null; propertyType: string | null }): string {
  const expanded = expandLetterTags(text, values);
  if (!hasUnresolvedTag(expanded)) return expanded;
  return expanded.split("{{物件所在}}").join(FALLBACK_LOCATION).split("{{物件種別}}").join(FALLBACK_TYPE);
}

export function extractPhone(contact: string | null): string | null {
  if (!contact) return null;
  const m = contact.match(/0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}/);
  if (!m) return null;
  const digits = m[0].replace(/[-\s]/g, "");
  return digits.length >= 10 && digits.length <= 11 ? digits : null;
}

export function splitBodyIntoSections(body: string): { intro: string[]; sections: Array<{ heading: string; paragraphs: string[] }> } {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const intro: string[] = [];
  const sections: Array<{ heading: string; paragraphs: string[] }> = [];
  let cur: string[] = [];
  let target: string[] = intro;
  const flush = () => { const t = cur.join("\n").trim(); if (t) target.push(t); cur = []; };
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("■")) {
      flush();
      sections.push({ heading: line.slice(1).trim(), paragraphs: [] });
      target = sections[sections.length - 1].paragraphs;
      continue;
    }
    if (line === "") { flush(); continue; }
    cur.push(line);
  }
  flush();
  return { intro, sections: sections.filter((s) => s.heading.length > 0) };
}

export interface LpSourceRows {
  variant: { headline: string; lead: string | null; bodyText: string; faqJson: unknown };
  media: Array<{ slot: string; heading: string | null; figureKind: string | null; asset: { publicId: string; width: number; height: number; deletedAt: Date | null } | null }>;
  property: { address: string | null; propertyType: string | null };
  company: { senderName: string | null; senderContact: string | null };
}

function parseFaq(v: unknown): LpFaqItem[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => (x && typeof x === "object" && typeof (x as LpFaqItem).q === "string" && typeof (x as LpFaqItem).a === "string" ? [{ q: (x as LpFaqItem).q, a: (x as LpFaqItem).a }] : []));
}

function toImage(asset: LpSourceRows["media"][number]["asset"]): LpImage | null {
  if (!asset || asset.deletedAt) return null;
  return { publicId: asset.publicId, width: asset.width, height: asset.height };
}

export function buildLpRenderInput(rows: LpSourceRows, opts: { mode: LpMode; unsubscribeUrl: string | null; phoneTapToken: string | null }): LpRenderInput {
  const values = { location: coarsePropertyLocation(rows.property.address), propertyType: propertyTypeLabel(rows.property.propertyType) };
  const { intro, sections } = splitBodyIntoSections(rows.variant.bodyText);
  const heroRow = rows.media.find((m) => m.slot === "hero");
  const byHeading = new Map<string, LpSourceRows["media"][number]>();
  for (const m of rows.media) if (m.slot === "section" && m.heading) byHeading.set(m.heading, m);
  const mediaFor = (heading: string): LpSectionMedia => {
    const m = byHeading.get(heading);
    if (!m) return null;
    const image = toImage(m.asset);
    if (image) return { kind: "asset", image };
    if (m.figureKind && isFigureKind(m.figureKind)) return { kind: "figure", figureKind: m.figureKind };
    return null;
  };
  return {
    mode: opts.mode,
    headline: expandLpText(rows.variant.headline, values),
    lead: rows.variant.lead ? expandLpText(rows.variant.lead, values) : null,
    intro: intro.map((p) => expandLpText(p, values)),
    sections: sections.map((s) => ({ heading: expandLpText(s.heading, values), paragraphs: s.paragraphs.map((p) => expandLpText(p, values)), media: mediaFor(s.heading) })),
    faq: parseFaq(rows.variant.faqJson).map((f) => ({ q: expandLpText(f.q, values), a: expandLpText(f.a, values) })),
    hero: heroRow ? toImage(heroRow.asset) : null,
    company: { name: rows.company.senderName, contact: rows.company.senderContact, phone: extractPhone(rows.company.senderContact) },
    unsubscribeUrl: opts.unsubscribeUrl,
    phoneTapToken: opts.phoneTapToken,
    form: null,
  };
}
