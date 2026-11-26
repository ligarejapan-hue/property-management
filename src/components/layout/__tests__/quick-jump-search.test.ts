import { describe, it, expect } from "vitest";
import { isSubsequence, normalizeQuery } from "@/lib/quick-jump/normalize";
import { scoreTerms, searchQuickJump } from "@/lib/quick-jump/search";
import { HOWTO_ENTRIES } from "@/lib/quick-jump/howto-entries";
import { EXTRA_PAGES, PAGE_ALIASES } from "@/lib/quick-jump/pages";
import { SIDEBAR_GROUPS } from "@/components/layout/sidebar-model";
import { ROLE_LEVEL } from "@/lib/nav/roles";

describe("normalizeQuery", () => {
  it("全角/半角・大小・カタカナ/ひらがな・記号をそろえる", () => {
    expect(normalizeQuery("ＤＭ　の 設定？")).toBe("dmの設定");
    expect(normalizeQuery("ドライブ")).toBe(normalizeQuery("どらいぶ"));
    expect(normalizeQuery("３ヶ月")).toBe(normalizeQuery("3ケ月"));
    expect(normalizeQuery("「鍵受領書」。")).toBe("鍵受領書");
  });
  it("空・記号だけは空", () => {
    expect(normalizeQuery("")).toBe("");
    expect(normalizeQuery(" ？！ ")).toBe("");
  });
});

describe("isSubsequence", () => {
  it("字が順番どおりにあれば真", () => {
    expect(isSubsequence("取引確認書", "取引完了確認書")).toBe(true);
    expect(isSubsequence("確認取引", "取引完了確認書")).toBe(false);
  });
});

describe("scoreTerms", () => {
  it("同じ言葉が一番強い・一部を打っても当たる", () => {
    const exact = scoreTerms(normalizeQuery("管理規約"), ["管理規約"]);
    const part = scoreTerms(normalizeQuery("規約"), ["管理規約"]);
    expect(exact).toBe(100);
    expect(part).toBeGreaterThan(60);
    expect(part).toBeLessThan(exact);
  });
  it("字を抜いた言い方(取引確認書→取引完了確認書)も当たる", () => {
    expect(scoreTerms(normalizeQuery("取引確認書"), ["取引完了確認書"])).toBeGreaterThan(0);
  });
  it("文の中の言葉を拾う(助詞や「したい」は無視)", () => {
    const q = normalizeQuery("鍵の本数を入力したい");
    expect(scoreTerms(q, ["本数", "鍵"])).toBeGreaterThan(scoreTerms(q, ["鍵"]));
    expect(scoreTerms(q, ["謄本"])).toBe(0);
  });
  it("見つかった言葉の一部でしかない言葉は二重に数えない", () => {
    const q = normalizeQuery("鍵受領書を出したい");
    expect(scoreTerms(q, ["鍵受領書", "鍵", "受領"])).toBe(scoreTerms(q, ["鍵受領書"]));
  });
});

describe("searchQuickJump", () => {
  it("空・ひらがな1字では何も出さない", () => {
    expect(searchQuickJump("", "admin", SIDEBAR_GROUPS)).toEqual([]);
    expect(searchQuickJump("の", "admin", SIDEBAR_GROUPS)).toEqual([]);
  });
  it("画面の名前で飛べる", () => {
    const r = searchQuickJump("取引", "field_staff", SIDEBAR_GROUPS);
    expect(r.some((x) => x.kind === "page" && x.href === "/deals")).toBe(true);
  });
  it("別名でも飛べる(規約→マンション棟)", () => {
    const r = searchQuickJump("規約", "office_staff", SIDEBAR_GROUPS);
    expect(r.some((x) => x.kind === "page" && x.href === "/buildings")).toBe(true);
  });
  it("役割で開けない画面は出さない", () => {
    const r = searchQuickJump("監査ログ", "field_staff", SIDEBAR_GROUPS);
    expect(r.some((x) => x.href.startsWith("/admin/"))).toBe(false);
    expect(searchQuickJump("監査ログ", "admin", SIDEBAR_GROUPS).some((x) => x.href === "/admin/audit-logs")).toBe(true);
    for (const role of ["field_staff", "office_staff"]) {
      for (const h of HOWTO_ENTRIES.filter((e) => ROLE_LEVEL[e.minRole] > ROLE_LEVEL[role as "field_staff"])) {
        expect(searchQuickJump(h.title, role, SIDEBAR_GROUPS).some((x) => x.key === `howto:${h.id}`)).toBe(false);
      }
    }
  });
  it("やりたいことの文でも答えが出る", () => {
    const keys = searchQuickJump("鍵の本数を入力したい", "admin", SIDEBAR_GROUPS);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys[0].kind).toBe("howto");
    const tax = searchQuickJump("固定資産税評価額はどの書類に載ってるの？", "admin", SIDEBAR_GROUPS);
    expect(tax.length).toBeGreaterThan(0);
    expect(tax[0].kind).toBe("howto");
    expect(tax[0].detail).toContain("評価額");
  });
  it("件数の上限を守る", () => {
    expect(searchQuickJump("物件", "admin", SIDEBAR_GROUPS).length).toBeLessThanOrEqual(8);
  });
});

describe("登録の中身の守り", () => {
  const menuHrefs = new Map(SIDEBAR_GROUPS.flatMap((g) => g.items).map((i) => [i.href, i.minRole]));
  for (const p of EXTRA_PAGES) menuHrefs.set(p.href, p.minRole);

  it("やりたいことの id は重ならない・中身が空でない", () => {
    const ids = HOWTO_ENTRIES.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const h of HOWTO_ENTRIES) {
      expect(h.title.trim()).not.toBe("");
      expect(h.answer.trim()).not.toBe("");
      expect(h.keywords.length).toBeGreaterThan(0);
    }
  });
  it("飛び先は知っている画面だけ・そこを開ける役割以上にだけ出す", () => {
    for (const h of HOWTO_ENTRIES) {
      const pageRole = menuHrefs.get(h.href);
      expect(pageRole, `${h.id} の飛び先 ${h.href}`).toBeDefined();
      expect(ROLE_LEVEL[h.minRole], h.id).toBeGreaterThanOrEqual(ROLE_LEVEL[pageRole!]);
    }
  });
  it("別名の道はどれも知っている画面", () => {
    for (const href of Object.keys(PAGE_ALIASES)) expect(menuHrefs.has(href), href).toBe(true);
  });
});
