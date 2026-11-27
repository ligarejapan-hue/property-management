import { canSee } from "@/lib/nav/roles";
import type { AppRole } from "@/lib/nav/roles";
import { isSubsequence, normalizeQuery } from "./normalize";
import { EXTRA_PAGES, PAGE_ALIASES } from "./pages";
import { HOWTO_ENTRIES } from "./howto-entries";
import { manualHrefFor } from "./howto-manual";

/**
 * 検索の枠の引き方(外には何も送らない・同じ言葉なら毎回同じ答え)。
 * 引く相手は2種類:
 * - 画面: メニューの項目+メニューに無い画面(pages.ts)。名前と別名で当てる
 * - やりたいこと: 答え+飛び先(howto-entries.ts)。見出しと探す言葉で当てる
 * 見せるのは、その人の役割で開ける画面だけ(メニューと同じ決まり=canSee)。
 */
export interface QuickJumpResult {
  kind: "page" | "howto";
  key: string;
  title: string;
  /** 画面=どのメニューの中か / やりたいこと=答え */
  detail: string;
  href: string;
  hrefLabel?: string;
  /** やりかたの「マニュアルで見る」の行き先(取り扱いマニュアルの節) */
  manualHref?: string;
  external?: boolean;
  windowName?: string;
  score: number;
}

/**
 * メニューの形(sidebar-model の NavGroup のうち、ここで使う所だけ)。
 * ⚠lib から @/components を読まない決まり(I5)なので、メニューは呼ぶ側(quick-jump.tsx)から渡す。
 */
export interface QuickJumpMenuGroup {
  label: string | null;
  items: { label: string; href: string; minRole: AppRole; external?: boolean; windowName?: string }[];
}

interface Candidate extends Omit<QuickJumpResult, "score"> {
  terms: string[];
}

/** 漢字1字(鍵・税など)は1字でも意味のある言葉として扱う。 */
const SINGLE_KANJI = /^\p{Script=Han}$/u;

/**
 * 言葉の並び(名前・別名)に対する当たりの強さ。0=当たらない。
 * - 打った言葉=登録した言葉 → 100
 * - 登録した言葉の一部を打った(「規約」→「管理規約」) → 60〜90
 * - 字を順番どおりに含む(「取引確認書」→「取引完了確認書」) → 45
 * - 文の中に登録した言葉がある(「鍵の本数を入力したい」の「本数」) → 言葉の長さに応じて足す
 */
export function scoreTerms(q: string, terms: string[]): number {
  if (!q) return 0;
  const qLen = Array.from(q).length;
  let best = 0;
  const contained = new Set<string>();
  for (const term of terms) {
    const t = normalizeQuery(term);
    if (!t) continue;
    const tLen = Array.from(t).length;
    if (t === q) best = Math.max(best, 100);
    else if (t.includes(q)) best = Math.max(best, 60 + Math.round((30 * qLen) / tLen));
    else if (qLen >= 3 && qLen / tLen >= 0.6 && isSubsequence(q, t)) best = Math.max(best, 45);
    if (t !== q && q.includes(t) && (tLen >= 2 || SINGLE_KANJI.test(t))) contained.add(t);
  }
  // 文の中で見つかった言葉: 別の見つかった言葉の一部でしかないもの(「鍵」と「鍵受領書」)は数えない
  const words = [...contained];
  let sum = 0;
  for (const w of words) {
    if (words.some((o) => o !== w && o.includes(w))) continue;
    sum += 12 * Array.from(w).length;
  }
  return best + sum;
}

function candidatesFor(role: string, menu: QuickJumpMenuGroup[]): Candidate[] {
  const menuItems = new Map(menu.flatMap((g) => g.items).map((i) => [i.href, i]));
  const list: Candidate[] = [];
  const seen = new Set<string>();
  for (const g of menu) {
    for (const item of g.items) {
      // メニューと同じ決まりで、その役割に見える項目だけ
      if (!canSee(role, item.minRole) || seen.has(item.href)) continue;
      seen.add(item.href);
      list.push({
        kind: "page",
        key: `page:${item.href}`,
        title: item.label,
        detail: g.label ?? "メニュー",
        href: item.href,
        external: item.external,
        windowName: item.windowName,
        terms: [item.label, ...(PAGE_ALIASES[item.href] ?? [])],
      });
    }
  }
  for (const p of EXTRA_PAGES) {
    if (!canSee(role, p.minRole) || seen.has(p.href)) continue;
    seen.add(p.href);
    list.push({
      kind: "page",
      key: `page:${p.href}`,
      title: p.label,
      detail: p.group,
      href: p.href,
      terms: [p.label, ...(PAGE_ALIASES[p.href] ?? [])],
    });
  }
  for (const h of HOWTO_ENTRIES) {
    if (!canSee(role, h.minRole)) continue;
    list.push({
      kind: "howto",
      key: `howto:${h.id}`,
      title: h.title,
      detail: h.answer,
      href: h.href,
      hrefLabel: h.hrefLabel,
      manualHref: manualHrefFor(h.id),
      // 別の窓で開く画面(資料・反響の受付)は、メニューと同じ開き方にする
      external: menuItems.get(h.href)?.external,
      windowName: menuItems.get(h.href)?.windowName,
      terms: [h.title, ...h.keywords],
    });
  }
  return list;
}

export const QUICK_JUMP_LIMIT = 8;

/** 打った言葉で引く。役割で開けないものは出さない。強い順に最大 limit 件。 */
export function searchQuickJump(
  query: string,
  role: string,
  menu: QuickJumpMenuGroup[],
  limit = QUICK_JUMP_LIMIT,
): QuickJumpResult[] {
  const q = normalizeQuery(query);
  if (!q) return [];
  // ひらがな1字(「の」「を」など)だけでは引かない(ほぼ全部に当たってしまう)
  if (Array.from(q).length === 1 && /^\p{Script=Hiragana}$/u.test(q)) return [];
  const scored: QuickJumpResult[] = [];
  for (const c of candidatesFor(role, menu)) {
    const score = scoreTerms(q, c.terms);
    if (score <= 0) continue;
    const { terms: _terms, ...rest } = c;
    void _terms;
    scored.push({ ...rest, score });
  }
  // 強い順。同じ強さなら やりたいこと(答えがある)→画面、その中は登録の順のまま
  scored.sort((a, b) => b.score - a.score || (a.kind === b.kind ? 0 : a.kind === "howto" ? -1 : 1));
  return scored.slice(0, limit);
}
