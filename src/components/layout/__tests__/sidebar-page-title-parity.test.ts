/**
 * 左メニューの名前と、開いた先のページの題名を一致させる走査
 * (発注者指摘 2026-08-25:「左メニューに出ている名前と開いた先のページの名前が
 *  違う / 名前がない / 文字の位置やサイズが統一されていない」)。
 *
 * この走査が守るのは次の3点だけ:
 *  (1) 左メニューの全項目に、行き先ページの**題名がある**(無題を作らせない)
 *  (2) その題名の文字列が**メニューの名前と一字一句同じ**である
 *  (3) 題名は共通部品 PageHeader で描く(=位置・大きさ・色が全画面で揃う)
 *      ただし COMPACT に挙げた画面だけは、地図の表示面積を守るため小さい
 *      見出し(h1)を許す。その場合も (1)(2) は同じように守らせる。
 *
 * 走査の境界(ここに書いていないものは見ていない):
 *  - 見るのは **左メニューから行ける画面だけ**。それ以外の画面の見出しは対象外。
 *  - 判定材料は **ソース文字列**。実行時に組み立てられる題名(変数・三項)は
 *    リテラルとして現れないので、その画面は必ず失敗する=わざと。
 *  - `#` 付き(同じページの中の場所を指す項目)と external(静的HTML資料)は、
 *    独自の題名を持たないので対象外。
 *  - `?tab=` 付き(同じ画面のタブへ飛ぶ項目)は、そのページの題名ではなく
 *    **飛んだ先のタブの名前**と一致させる(別の describe で見る)。
 *  - 題名は **素の文字列** (`title="…"`) で書く。式で組み立てた題名は機械で
 *    照合できないため null 扱い=失敗させる。
 *  - 画面の部品(src/components)が**自前の `<h1>` を持たない**ことも見る
 *    (@codex #413 R2 P2: ページに題名を足したら、子部品が同じ題名の h1 を
 *    すでに持っていて二重になった)。例外は allow-list に理由を1行で書く。
 *  - パンくず(`<nav>` の末尾の現在地)を**持っている画面だけ**、その文字も同じ
 *    名前かを見る(@codex #413 R1 P2: 題名だけ直してパンくずに旧名が残った)。
 *    パンくずを持たない画面は対象外(持てとは言わない)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { SIDEBAR_GROUPS } from "../sidebar-model";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

/**
 * 題名を **page.tsx ではなく別の部品**が持っている画面。
 * (page.tsx は薄い入れ物で、描画はクライアント部品側にある)
 */
const TITLE_SOURCE: Record<string, string> = {
  "/home": "src/components/home/HomeContent.tsx",
  "/field-survey/candidates": "src/components/field-survey/candidate-queue.tsx",
};

/**
 * PageHeader の既定寸(text-2xl + mb-6)を使わせない画面。
 * 地図は `h-[calc(100dvh-3.5rem)]` で高さを切り詰めているため、
 * 大きい見出しを載せると地図そのものが狭くなる(発注者判断 2026-08-25)。
 */
const COMPACT = new Set<string>(["/field-survey/map"]);

/** 左メニューのうち、独自の題名を持つべき項目。 */
export function titledLeaves(): { label: string; href: string }[] {
  return SIDEBAR_GROUPS.flatMap((g) => g.items)
    .filter((i) => !i.external && !i.href.includes("#") && !i.href.includes("?"))
    .map((i) => ({ label: i.label, href: i.href }));
}

/** href から、題名を書いてあるはずのソースファイルの絶対パスを引く。 */
function sourceOf(href: string): string {
  const override = TITLE_SOURCE[href];
  if (override) return join(ROOT, override);
  return join(ROOT, "src", "app", "(dashboard)" + href, "page.tsx");
}

/**
 * ソース文字列から `<PageHeader ... />` の `title="…"` を取り出す(純関数)。
 * **素の文字列だけを認める**。`title={…}` のように式で組み立てたものは、
 * 機械でメニュー名と照合できないので null(=失敗)にする。
 */
export function extractPageHeaderTitle(src: string): string | null {
  const at = src.indexOf("<PageHeader");
  if (at === -1) return null;
  const t = src.indexOf("title=", at);
  if (t === -1) return null;
  const head = src[t + "title=".length];
  if (head !== '"') return null;
  const start = t + "title=".length + 1;
  const end = src.indexOf('"', start);
  return end === -1 ? null : src.slice(start, end);
}

/** COMPACT 画面用: 最初の `<h1 ...>` の中身(タグを除いた地の文)を取り出す。 */
export function extractH1Text(src: string): string | null {
  const m = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(src);
  if (!m) return null;
  return m[1]
    .replace(/\{[\s\S]*?\}/g, "") // 埋め込み式(件数バッジ等)は落とす
    .replace(/<[^>]*>/g, "")
    .trim();
}

describe("題名の取り出し(走査の道具そのものの検証)", () => {
  it('title="…" を取り出す', () => {
    expect(extractPageHeaderTitle('<PageHeader title="監査ログ" />')).toBe("監査ログ");
  });
  it("式で組み立てた題名は null(機械で照合できないため許さない)", () => {
    expect(
      extractPageHeaderTitle("<PageHeader title={<>物件化の完成待ち{badge}</>} />"),
    ).toBeNull();
  });
  it("PageHeader が無ければ null(=空振りで緑にならない)", () => {
    expect(extractPageHeaderTitle('<h2 className="text-2xl">物件一覧</h2>')).toBeNull();
  });
  it("h1 は埋め込み式とタグを落として地の文だけ返す", () => {
    expect(
      extractH1Text('<h1 className="text-lg">\n  物件化の完成待ち\n  {badge}\n</h1>'),
    ).toBe("物件化の完成待ち");
  });
});

describe("左メニューの名前 = 開いた先のページの題名", () => {
  const leaves = titledLeaves();

  it("走査対象が空振りしていない(項目数の下限を固定)", () => {
    // 空の配列に対して forEach しても緑になってしまうため、件数そのものを固定する。
    expect(leaves.length).toBeGreaterThanOrEqual(26);
  });

  it.each(leaves.map((l) => [l.href, l.label] as const))(
    "%s の題名が「%s」である",
    (href, label) => {
      const file = sourceOf(href);
      expect(existsSync(file), `${href} の題名を書くファイルが無い: ${file}`).toBe(true);
      const src = read(file);

      if (COMPACT.has(href)) {
        expect(extractH1Text(src), `${href} に見出しが無い`).toBe(label);
        return;
      }

      const title = extractPageHeaderTitle(src);
      expect(
        title,
        `${href} は PageHeader で題名を描いていない(手書きの見出しは位置・大きさが揃わない)`,
      ).not.toBeNull();
      expect(title, `${href} の題名がメニューの名前と違う`).toBe(label);
    },
  );
});

/**
 * パンくずの現在地(`<nav>` 内の最後の `text-gray-900` な span)を取り出す(純関数)。
 * パンくずが無ければ null。
 */
export function extractBreadcrumbCurrent(src: string): string | null {
  const nav = /<nav[^>]*>([\s\S]*?)<\/nav>/.exec(src);
  if (!nav) return null;
  const spans = [...nav[1].matchAll(/<span className="text-gray-900[^"]*">([^<]*)<\/span>/g)];
  if (spans.length === 0) return null;
  return spans[spans.length - 1][1].trim();
}

describe("パンくずの現在地(あれば)も同じ名前", () => {
  it("パンくずが無ければ null(持たない画面を落とさない)", () => {
    expect(extractBreadcrumbCurrent("<div>題名だけ</div>")).toBeNull();
  });
  it("末尾の現在地を取り出す", () => {
    expect(
      extractBreadcrumbCurrent(
        '<nav><a>管理</a><span className="mx-2">/</span>' +
          '<span className="text-gray-900 dark:text-gray-100">送付記録の訂正</span></nav>',
      ),
    ).toBe("送付記録の訂正");
  });

  it("パンくずを持つ画面が実際にある(全部 null で空振り緑にならない)", () => {
    const withCrumb = titledLeaves().filter((l) => {
      const f = sourceOf(l.href);
      return existsSync(f) && extractBreadcrumbCurrent(read(f)) !== null;
    });
    expect(withCrumb.length).toBeGreaterThanOrEqual(6);
  });

  it.each(titledLeaves().map((l) => [l.href, l.label] as const))(
    "%s のパンくずは「%s」(パンくずがある場合)",
    (href, label) => {
      const file = sourceOf(href);
      if (!existsSync(file)) return;
      const crumb = extractBreadcrumbCurrent(read(file));
      if (crumb === null) return; // パンくずを持たない画面は対象外
      expect(crumb, `${href} のパンくずの現在地がメニューの名前と違う`).toBe(label);
    },
  );
});

describe("会社情報の置き場所(発注者指示 2026-08-25: 常用しないので システム管理 へ)", () => {
  it("会社情報は システム管理 グループにある", () => {
    const admin = SIDEBAR_GROUPS.find((g) => g.key === "admin");
    expect(admin?.items.some((i) => i.href === "/admin/company-settings")).toBe(true);
  });

  it("販売図面グループには会社情報を置かない", () => {
    const sheet = SIDEBAR_GROUPS.find((g) => g.key === "sheet");
    expect(sheet?.items.some((i) => i.href === "/admin/company-settings")).toBe(false);
  });
});

describe("タブへ飛ぶ項目は、タブの名前と一致させる", () => {
  const tabbed = SIDEBAR_GROUPS.flatMap((g) => g.items).filter((i) =>
    i.href.includes("?tab="),
  );

  it("走査対象が空振りしていない", () => {
    expect(tabbed.length).toBeGreaterThanOrEqual(1);
  });

  it.each(tabbed.map((i) => [i.href, i.label] as const))(
    "%s のタブ名が「%s」である",
    (href, label) => {
      const [path, query] = href.split("?");
      const tabKey = new URLSearchParams(query).get("tab");
      expect(tabKey, `${href} に tab= が無い`).not.toBeNull();
      const src = read(join(ROOT, "src", "app", "(dashboard)" + path, "page.tsx"));
      expect(
        src.includes(`{ key: "${tabKey}", label: "${label}" }`),
        `${href} の飛び先タブの名前がメニューの名前と違う`,
      ).toBe(true);
    },
  );
});

describe("画面の部品は自前の題名(h1)を持たない", () => {
  // 題名は PageHeader 1本に集約する。二重の題名は、読み上げでも見た目でも
  // 「このページの名前はどれか」を壊す(@codex #413 R2 P2 の実例)。
  const ALLOW = new Set([
    "src/components/ui/page-header.tsx", // 題名そのものを描く部品
    "src/components/layout/header.tsx", // 画面上端のアプリ名(ページ題名ではない)
    "src/components/properties/dm-logs-view.tsx", // 物件配下の別画面。左メニューからは行かない
  ]);

  function walkComponents(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === "__tests__") continue;
        walkComponents(full, out);
      } else if (name.endsWith(".tsx")) {
        out.push(full);
      }
    }
    return out;
  }

  it("allow-list 以外の部品に <h1 が無い", () => {
    const files = walkComponents(join(ROOT, "src", "components"));
    expect(files.length).toBeGreaterThan(50); // 空振り防止
    const offenders = files
      .map((f) => relative(ROOT, f).split(sep).join("/"))
      .filter((r) => !ALLOW.has(r))
      .filter((r) => read(join(ROOT, r)).includes("<h1"));
    expect(offenders).toEqual([]);
  });
});
