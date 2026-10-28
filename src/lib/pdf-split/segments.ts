/**
 * まとめてある PDF(物件概要書・地図・パンフ・図面・証明書・謄本などが1冊になったもの)を
 * 書類ごとに分ける — ページの見分けと分け目(純関数・DB も外部も触らない)。
 *
 * 発注者の依頼(2026-10-28)「こういったまとめてあるPDFが来ることもある」→「分ける仕組みまで作って」。
 * 流れ: 1ページずつ種類を見分ける(文字の無いページは見出しだけ読み取る)→ 続いているページを
 * 1つの書類にまとめた案を出す → 人が分け目と種類を確かめて保存。
 * ⚠見分けられないページは「前の書類の続き」にする(図面の2枚目・パンフの中ほどは題が無いのが普通)。
 * ⚠推測で埋めない=当たらなければ null(=その他)。案は人が直せる。
 */
import { DOC_KINDS, HEADING_ZONE, classifyDocument, normalizeForMatch } from "@/lib/doc-classify/classify";

/** 謄本の部分。保存は謄本(type=registry)として行い、種類の表は使わない。 */
export const REGISTRY_KIND = "registry";
/** 分ける前の1冊(元のファイル)に付ける種類。分けた書類には使わない。 */
export const BUNDLE_ORIGINAL_KIND = "bundle_original";
/** 分けられるページ数の上限(これより多い PDF は分けずに1つで保存)。 */
export const MAX_SPLIT_PAGES = 60;
/** これより文字(空白以外)が少ないページは、画像のページとみなして見出しを読み取る。 */
export const LITTLE_TEXT_CHARS = 30;

export interface Segment {
  /** 1 から数えたページ番号(両端を含む)。 */
  from: number;
  to: number;
  /** 種類の表の code・謄本(REGISTRY_KIND)・null(その他)。 */
  kind: string | null;
}

/** 謄本の見出し(各ページの上に出る)。 */
const REGISTRY_HEADINGS = ["全部事項証明書", "登記事項証明書", "所有者事項証明書", "現在事項証明書", "表題部"] as const;

/** 物件概要書の欄の名前。題が画像で読めなくても、欄が並んでいれば概要書。 */
const SUMMARY_FIELDS = [
  "物件名", "所在地", "交通", "専有面積", "土地面積", "建物面積", "間取り", "構造",
  "用途地域", "建築年月", "築年月", "管理費", "権利形態", "引渡",
] as const;
/** 概要書とみなす欄の数。 */
const SUMMARY_MIN_FIELDS = 5;
/** 概要書は「物件名」の欄から始まる(重要事項説明書のように題が先に来る書類と取り違えない)。 */
const SUMMARY_START_ZONE = 20;

/** 1ページの種類。見分けられなければ null(=前の書類の続き)。 */
export function classifyPageText(text: string): string | null {
  const c = normalizeForMatch(text);
  if (c === "") return null;
  const head = c.slice(0, HEADING_ZONE);
  if (REGISTRY_HEADINGS.some((w) => head.includes(w)) || (c.includes("権利部") && c.includes("甲区"))) {
    return REGISTRY_KIND;
  }
  if (c.slice(0, SUMMARY_START_ZONE).includes("物件名")) {
    const body = c.slice(0, HEADING_ZONE * 2);
    if (SUMMARY_FIELDS.filter((f) => body.includes(f)).length >= SUMMARY_MIN_FIELDS) return "property_summary";
  }
  // 見出しのあたり(high)で当たったときだけ。本文の奥にだけある語では決めない。
  const hit = classifyDocument({ fileName: "", text });
  if (!hit || hit.confidence !== "high") return null;
  return hit.kind;
}

/** 文字がほとんど無い=画像のページ(見出しを読み取りに回す)。 */
export function needsOcr(text: string): boolean {
  let n = 0;
  for (const ch of text) {
    if (!/\s/.test(ch)) n++;
    if (n >= LITTLE_TEXT_CHARS) return false;
  }
  return true;
}

/** 案: 見分けた種類が変わったところで分ける。見分けられないページは前の書類の続き。 */
export function proposeSegments(pageKinds: readonly (string | null)[]): Segment[] {
  const out: Segment[] = [];
  pageKinds.forEach((kind, i) => {
    const page = i + 1;
    const cur = out[out.length - 1];
    if (cur && (kind === null || kind === cur.kind)) {
      cur.to = page;
    } else {
      out.push({ from: page, to: page, kind });
    }
  });
  return out;
}

/** 書類の始まりのページ(1ページ目を除く)= 分け目。 */
export function cutsOf(segments: readonly Segment[]): Set<number> {
  return new Set(segments.slice(1).map((s) => s.from));
}

/**
 * 分け目(書類が始まるページ)から書類の並びを作り直す。種類は、人が選んだもの(始まりのページで覚える)
 * → その範囲で最初に見分けられたページの種類 → その他、の順。
 */
export function segmentsFromCuts(
  pageKinds: readonly (string | null)[],
  cuts: ReadonlySet<number>,
  kindByStart: ReadonlyMap<number, string | null>,
): Segment[] {
  const pageCount = pageKinds.length;
  if (pageCount === 0) return [];
  const starts = [1, ...[...cuts].filter((p) => Number.isInteger(p) && p > 1 && p <= pageCount).sort((a, b) => a - b)];
  return starts.map((from, i) => {
    const to = i + 1 < starts.length ? starts[i + 1] - 1 : pageCount;
    let kind: string | null = null;
    if (kindByStart.has(from)) {
      kind = kindByStart.get(from) ?? null;
    } else {
      for (let p = from; p <= to; p++) {
        const k = pageKinds[p - 1];
        if (k !== null && k !== undefined) {
          kind = k;
          break;
        }
      }
    }
    return { from, to, kind };
  });
}

/** 分けた書類に付けてよい種類(種類の表・謄本・その他)。元のファイルの種類は使えない。 */
export function isSplitKind(kind: unknown): kind is string | null {
  if (kind === null) return true;
  if (typeof kind !== "string") return false;
  if (kind === REGISTRY_KIND) return true;
  return kind !== BUNDLE_ORIGINAL_KIND && DOC_KINDS.some((k) => k.code === kind);
}

/** 保存の前の確かめ: 2つ以上・1ページ目から最後まで隙間も重なりもなく・種類は使えるものだけ。 */
export function validateSegments(
  raw: unknown,
  pageCount: number,
): { ok: true; segments: Segment[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: "分け方の形が正しくありません" };
  if (raw.length < 2) return { ok: false, reason: "2つ以上に分けてください" };
  const segments: Segment[] = [];
  let next = 1;
  for (const item of raw) {
    const o = item as { from?: unknown; to?: unknown; kind?: unknown } | null;
    if (typeof o !== "object" || o === null) return { ok: false, reason: "分け方の形が正しくありません" };
    const { from, to } = o;
    const kind = o.kind ?? null;
    if (typeof from !== "number" || typeof to !== "number" || !Number.isInteger(from) || !Number.isInteger(to)) {
      return { ok: false, reason: "ページの番号が正しくありません" };
    }
    if (from !== next || to < from || to > pageCount) {
      return { ok: false, reason: "ページの範囲が正しくありません" };
    }
    if (!isSplitKind(kind)) return { ok: false, reason: "書類の種類が正しくありません" };
    segments.push({ from, to, kind });
    next = to + 1;
  }
  if (next !== pageCount + 1) return { ok: false, reason: "ページの範囲が最後まで届いていません" };
  return { ok: true, segments };
}

/** 分けた書類のファイル名 = 元の名前 + `_p14-18`(1ページなら `_p1`)+ `.pdf`。 */
export function segmentFileName(originalName: string, seg: { from: number; to: number }): string {
  const base = originalName.replace(/\.pdf$/i, "");
  const range = seg.from === seg.to ? `p${seg.from}` : `p${seg.from}-${seg.to}`;
  return `${base}_${range}.pdf`;
}
