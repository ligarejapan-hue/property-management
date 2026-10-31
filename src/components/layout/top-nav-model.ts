import { isNavItemActive, type NavGroup, type NavLeaf } from "./sidebar-model";

// 見た目の設定 段階3(2026-10-31): 上部ナビの並び。左メニューと同じ定義(SIDEBAR_GROUPS→visibleSidebar)から作る
// =項目を足すのは sidebar-model の1か所だけ。並べ方の規則:
// - 見出しの無いグループ(ホーム)の項目は、そのままリンク
// - 柱: 中が1つならその画面へのリンク(柱の名前で)・複数なら開くメニュー(左メニューと同じ)
// - 柱でないグループ(物件データ編集・システム管理・資料)は「その他」1つにまとめ、中に見出しごと並べる(横幅に収めるため)

export type TopNavEntry =
  | { kind: "link"; key: string; label: string; icon?: React.ReactNode; item: NavLeaf }
  | {
      kind: "menu";
      key: string;
      label: string;
      icon?: React.ReactNode;
      sections: { label: string | null; description?: string; items: NavLeaf[] }[];
    };

export const OTHER_MENU_LABEL = "その他";

export function topNavEntries(groups: NavGroup[]): TopNavEntry[] {
  const entries: TopNavEntry[] = [];
  const others: { label: string | null; description?: string; items: NavLeaf[] }[] = [];
  for (const g of groups) {
    if (!g.label) {
      for (const item of g.items) entries.push({ kind: "link", key: item.href, label: item.label, icon: item.icon, item });
    } else if (g.pillar) {
      if (g.items.length === 1) {
        entries.push({ kind: "link", key: g.key, label: g.label, icon: g.icon, item: g.items[0] });
      } else {
        entries.push({ kind: "menu", key: g.key, label: g.label, icon: g.icon, sections: [{ label: null, description: g.description, items: g.items }] });
      }
    } else {
      others.push({ label: g.label, description: g.description, items: g.items });
    }
  }
  if (others.length > 0) entries.push({ kind: "menu", key: "other", label: OTHER_MENU_LABEL, sections: others });
  return entries;
}

/** その並びの中に、いま見ている画面があるか(左メニューと同じ判定 isNavItemActive を使う)。 */
export function isTopEntryActive(entry: TopNavEntry, currentPath: string, currentHash = ""): boolean {
  const items = entry.kind === "link" ? [entry.item] : entry.sections.flatMap((s) => s.items);
  return items.some((i) => isNavItemActive(i.href, currentPath, currentHash));
}

/** 開くメニューの幅(rem)。top-nav.tsx の w-64 と同じ。 */
export const MENU_WIDTH_REM = 16;

/**
 * 開いたメニューを右にそろえるか(右に入りきらないときだけ)。何番目かでは決めない
 * (狭い幅で2行に折り返すと「その他」が左端に来る=右にそろえると左の外へはみ出す)。
 */
export function menuAlignRight(buttonLeft: number, remPx: number, viewportWidth: number): boolean {
  return buttonLeft + MENU_WIDTH_REM * remPx > viewportWidth - 8;
}
