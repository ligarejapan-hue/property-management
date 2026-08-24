/**
 * メニュー再編(発注者決定 2026-08-24・案B)。
 *
 * 決めごと:
 *  - 仕事の流れ順に並べ、名前だけでは中身が分からないグループにだけ一言説明を付ける
 *    (「物件」「現地調査」は不要=発注者指示)。
 *  - **URL を直打ちしないと行けなかった3画面**をメニューに載せる
 *    (所有者CSV取込=アプリ内リンクゼロ / 登記DM取込 / 物件データエラー確認)。
 *  - 「DM」グループを新設し、入口ページ「DMメニュー」を置く。
 *  - 「謄本取得の資格情報」は画面ごと廃止(共通アカウント運用のため)。
 *  - 画面の中身・権限・スマホ現場メニューは変えない。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SIDEBAR_GROUPS,
  visibleSidebar,
  isNavItemActive,
} from "@/components/layout/sidebar-model";

const allItems = SIDEBAR_GROUPS.flatMap((g) => g.items);
const byHref = (href: string) => allItems.find((i) => i.href === href);
const group = (key: string) => SIDEBAR_GROUPS.find((g) => g.key === key);

describe("確定した並び(仕事の流れ順)", () => {
  it("グループの順序と数", () => {
    expect(SIDEBAR_GROUPS.map((g) => g.key)).toEqual([
      "home",
      "prop",
      "field",
      "imp",
      "dm",
      "sheet",
      "dq",
      "admin",
      "doc",
    ]);
  });
});

describe("確定した名前", () => {
  it("グループ名(R1・R2・R3)", () => {
    expect(group("imp")?.label).toBe("物件データ取り込み");
    expect(group("dq")?.label).toBe("物件データ編集");
    // R3 = そのまま(発注者指示)。
    expect(group("admin")?.label).toBe("システム管理");
    expect(group("dm")?.label).toBe("DM");
  });

  it("項目名(R4・R5・2画面の呼び名)", () => {
    // ⚠この画面が効くのは**販売図面だけ**(@codex #411 R3 P2・実測)。
    //   DM の差出人は売却DM設定で変わる。「DMの差出人」と名乗ると、
    //   直しに来た人が変わらない設定をいじって古い差出人のまま郵送してしまう。
    expect(byHref("/admin/company-settings")?.label).toBe(
      "会社情報（販売図面の差出人）",
    );
    expect(byHref("/admin/company-settings")?.label).not.toContain("DM");
    expect(byHref("/admin/orphan-dm-logs")?.label).toBe("送付記録の訂正");
    expect(byHref("/properties/quality-check")?.label).toBe("物件データエラー確認");
    expect(byHref("/admin/attachments")?.label).toBe("添付ファイル検索");
    expect(byHref("/dm")?.label).toBe("DMメニュー");
  });

  it("旧い名前が残っていない", () => {
    const labels = [
      ...SIDEBAR_GROUPS.map((g) => g.label),
      ...allItems.map((i) => i.label),
    ];
    for (const gone of [
      "取込・登記",
      "データ品質",
      "売却DM",
      "孤児DM記録の訂正",
      "添付検索",
      "品質チェック",
      "会社情報",
    ]) {
      expect(labels, gone).not.toContain(gone);
    }
  });
});

describe("グループの一言説明", () => {
  it("名前だけでは中身が分からないグループにだけ付ける", () => {
    // 発注者指示: 「物件」「現地調査」は不要。
    expect(group("prop")?.description).toBeUndefined();
    expect(group("field")?.description).toBeUndefined();
    expect(group("home")?.description).toBeUndefined();
    expect(group("doc")?.description).toBeUndefined();
    // 残りは付ける(とくに「システム管理」は名前が分かりにくいという指摘の当事者)。
    for (const key of ["imp", "dm", "sheet", "dq", "admin"]) {
      expect(group(key)?.description, key).toBeTruthy();
    }
  });
});

describe("説明文が実際に画面へ出る(定義しただけで終わらせない)", () => {
  const SIDEBAR = readFileSync(
    join(process.cwd(), "src/components/layout/sidebar.tsx"),
    "utf8",
  ).replace(new RegExp("\\r\\n", "g"), "\n");

  it("折りたたみ・通常の両方のグループで描画される", () => {
    const hits = SIDEBAR.match(/\{g\.description && \(/g) ?? [];
    expect(hits.length).toBe(2);
  });

  it("開閉ボタンの中には入れない(押す的を小さくしない)", () => {
    // ボタンの内側に説明を入れると、読み上げでボタン名が長くなり、
    // タップ領域の意味も変わる。ボタンを閉じた**後**に置く。
    const btnEnd = SIDEBAR.indexOf("</button>");
    const firstDesc = SIDEBAR.indexOf("{g.description && (");
    expect(btnEnd).toBeGreaterThan(-1);
    expect(firstDesc).toBeGreaterThan(btnEnd);
  });
});

describe("⚠URL 直打ちでしか行けなかった画面を載せる", () => {
  it("所有者CSV取込・登記DM取込・物件データエラー確認", () => {
    // 所有者CSV取込はアプリ内のリンクがゼロだった(実測 2026-08-16 / 08-24)。
    expect(byHref("/import#owner-match")).toBeTruthy();
    expect(byHref("/import/registry-dm")).toBeTruthy();
    expect(byHref("/properties/quality-check")).toBeTruthy();
  });

  it("⚠所有者CSV取込は、その作業がある場所まで送る(@codex #411 R1 P2)", () => {
    // ⚠素の /import へ送ると**画面の上から**入ってしまい、所有者の作業が
    //   どこにあるか分からない(受付帳CSV取込と着地点が同じになる)。
    //   所有者の作業は同じページの下の「② 受付帳 × 所有者 2ファイル突合」。
    expect(byHref("/import#owner-match")).toBeTruthy();
    expect(byHref("/import/owners")).toBeUndefined();
    // 着地点の id が実在すること(リンク切れの見張り)。
    const IMPORT_PAGE = readFileSync(
      join(process.cwd(), "src/app/(dashboard)/import/page.tsx"),
      "utf8",
    );
    expect(IMPORT_PAGE).toContain('id="owner-match"');
    // 固定ヘッダに隠れないよう余白を取る。
    expect(IMPORT_PAGE).toContain("scroll-mt-4");
    // 旧 URL(配布済み・ブックマーク)も同じ場所へ送る=切らない。
    const OWNERS_PAGE = readFileSync(
      join(process.cwd(), "src/app/(dashboard)/import/owners/page.tsx"),
      "utf8",
    );
    expect(OWNERS_PAGE).toContain('redirect("/import#owner-match")');
  });

  it("⚠押した項目が光る(いま見ている位置まで見る・@codex #411 R2 P2)", () => {
    // 押した項目とは**別の項目**が光ると、どこに居るのか分からなくなる。
    // 位置(#)まで一致したときだけ点灯し、そのとき全体を指す項目は消す
    // =2つ同時に光らせない。
    expect(isNavItemActive("/import#owner-match", "/import", "#owner-match")).toBe(true);
    expect(isNavItemActive("/import", "/import", "#owner-match")).toBe(false);
    // 位置を指定していないときは、これまでどおり全体の項目が光る。
    expect(isNavItemActive("/import", "/import", "")).toBe(true);
    expect(isNavItemActive("/import#owner-match", "/import", "")).toBe(false);
    // 別の場所の位置指定に巻き込まれない(無関係なページを消さない)。
    expect(isNavItemActive("/properties", "/properties", "#somewhere")).toBe(true);
    // 位置が違えば点かない。
    expect(isNavItemActive("/import#owner-match", "/import", "#other")).toBe(false);
    // 別ページでは点かない。
    expect(isNavItemActive("/import#owner-match", "/properties", "#owner-match")).toBe(false);
    // 第3引数を省いた既存の呼び出しは従来どおり動く(後方互換)。
    expect(isNavItemActive("/import", "/import")).toBe(true);
  });

  it("取り込み系は「物件データ取り込み」に、エラー確認は「物件」に置く", () => {
    const imp = group("imp")?.items.map((i) => i.href) ?? [];
    expect(imp).toContain("/import");
    expect(imp).toContain("/import/registry-pdf");
    expect(imp).toContain("/import/registry-dm");
    expect(imp).toContain("/import#owner-match");
    const prop = group("prop")?.items.map((i) => i.href) ?? [];
    expect(prop).toContain("/properties/quality-check");
  });
});

describe("DM グループ(新設)", () => {
  it("入口ページを先頭に、送る流れの順で並ぶ", () => {
    expect(group("dm")?.items.map((i) => i.href)).toEqual([
      "/dm",
      "/admin/sale-dm-settings",
      "/admin/orphan-dm-logs",
    ]);
  });
});

describe("押した位置の追随(@codex #411 R4 P2)", () => {
  const SIDEBAR = readFileSync(
    join(process.cwd(), "src/components/layout/sidebar.tsx"),
    "utf8",
  );

  it("⚠押した項目そのものから位置を取る(hashchange だけに頼らない)", () => {
    // アプリ内のリンクは history.pushState で遷移するため、同じページ内で
    // 位置だけ変えても hashchange は飛ばない=それだけでは追随できない。
    expect(SIDEBAR).toContain("const handleNavClick = (href: string) => {");
    expect(SIDEBAR).toContain('onClick={() => handleNavClick(item.href)}');
    const fn = SIDEBAR.slice(SIDEBAR.indexOf("const handleNavClick"), SIDEBAR.indexOf("const handleNavClick") + 400);
    expect(fn).toContain('href.indexOf("#")');
    expect(fn).toContain('setHash(at === -1 ? "" : href.slice(at))');
    // 直接 URL を開く/戻る・進む の受け口も残す。
    expect(SIDEBAR).toContain('window.addEventListener("hashchange", sync)');
  });
});

describe("撤去した画面の案内が残っていない(@codex #411 R4 P2)", () => {
  it("設定例・手順書が消えた画面へ誘導しない", () => {
    // 手順どおりに進むと 404 に当たる、を防ぐ。
    for (const f of [
      ".env.example",
      "deploy/env/app.env.example",
      "docs/registry-location-search-calibration-runbook.md",
    ]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      const lines = src.split("\n").filter((l) => l.includes("/admin/registry-settings"));
      // 触れる場合は「廃止した」と書いてある行だけ許す(案内として残さない)。
      for (const l of lines) {
        expect(l, `${f}: ${l}`).toMatch(/廃止|撤去/);
      }
    }
  });
});

describe("DMメニューの手順(@codex #411 R3 P2)", () => {
  const DM_PAGE = readFileSync(
    join(process.cwd(), "src/app/(dashboard)/dm/page.tsx"),
    "utf8",
  );

  it("⚠設定を作成より前に案内する(はじめて使う人が行き止まりにならない)", () => {
    // 差出人・案内先が未設定だと物件一覧に「売却DMを作成」が出ない
    // (saleDmPrintReady)。作成を先に案内すると STEP で詰む。
    const setup = DM_PAGE.indexOf("差出人や案内先を設定する");
    const create = DM_PAGE.indexOf("宛名やお手紙を作る");
    expect(setup).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(-1);
    expect(setup).toBeLessThan(create);
  });

  it("⚠開けない道具は押せるように見せない(@codex #411 R5 P2)", () => {
    // /dm は事務担当にも見せる。STEP2(売却DM設定)と STEP4(送付記録の訂正)は
    // 管理者専用なので、足りない人にはリンクではなく案内を出す。
    expect(DM_PAGE).toContain("minRole: AppRole;");
    expect(DM_PAGE).toContain("const usable = canSee(userRole, s.minRole);");
    expect(DM_PAGE).toContain('data-testid="dm-menu-step-unavailable"');
    expect(DM_PAGE).toContain("管理者にご依頼ください");
    // 管理者専用の2つに minRole: "admin" が付いている。
    const admins = DM_PAGE.match(/minRole: "admin"/g) ?? [];
    expect(admins.length).toBe(2);
    // 事務担当でも使える2つはそのまま。
    const office = DM_PAGE.match(/minRole: "office_staff"/g) ?? [];
    expect(office.length).toBe(2);
  });

  it("設定が要らない作業(宛名CSV)との違いを書いてある", () => {
    expect(DM_PAGE).toContain("宛名CSVの出力だけなら設定は不要");
    expect(DM_PAGE).toContain("「売却DMを作成」のボタンが出ません");
  });
});

describe("添付ファイル検索の移動", () => {
  it("「物件」グループへ移り、システム管理からは消える", () => {
    expect(group("prop")?.items.map((i) => i.href)).toContain("/admin/attachments");
    expect(group("admin")?.items.map((i) => i.href)).not.toContain(
      "/admin/attachments",
    );
  });

  it("⚠権限は変えない(移動後も管理者だけ)", () => {
    expect(byHref("/admin/attachments")?.minRole).toBe("admin");
  });
});

describe("謄本取得の資格情報は廃止", () => {
  it("メニューから消える", () => {
    expect(byHref("/admin/registry-settings")).toBeUndefined();
  });
});

describe("⚠変えないもの", () => {
  it("スマホの現場スタッフに出るメニューは従来どおり", () => {
    // 現地調査3項目 + 資料3項目 + ホーム。増やさない/減らさない。
    const staff = visibleSidebar("field_staff");
    expect(staff.map((g) => g.key)).toEqual(["home", "field", "doc"]);
    expect(staff.flatMap((g) => g.items).map((i) => i.href)).toEqual([
      "/home",
      "/field-survey/map",
      "/field-survey/sessions",
      "/field-survey/candidates",
      "/docs/guide.html",
      "/docs/manual.html",
      "/help",
    ]);
  });

  it("項目ごとの権限は据え置き(取り込み系は事務担当・管理系は管理者)", () => {
    expect(byHref("/import")?.minRole).toBe("office_staff");
    expect(byHref("/import/registry-pdf")?.minRole).toBe("office_staff");
    expect(byHref("/import/registry-dm")?.minRole).toBe("office_staff");
    expect(byHref("/import#owner-match")?.minRole).toBe("office_staff");
    expect(byHref("/properties/quality-check")?.minRole).toBe("office_staff");
    expect(byHref("/dm")?.minRole).toBe("office_staff");
    expect(byHref("/admin/sale-dm-settings")?.minRole).toBe("admin");
    expect(byHref("/admin/orphan-dm-logs")?.minRole).toBe("admin");
  });

  it("リンク先(href)は1つも変えていない=画面はそのまま", () => {
    // 名前と置き場所だけを変える提案。新設は /dm のみ。
    const hrefs = new Set(allItems.map((i) => i.href));
    for (const kept of [
      "/properties",
      "/buildings",
      "/field-survey/map",
      "/field-survey/sessions",
      "/field-survey/candidates",
      "/import",
      "/import/registry-pdf",
      "/sales-sheets/new",
      "/admin/company-settings",
      "/admin/sale-dm-settings",
      "/admin/owners/correction",
      "/admin/display-name-audit",
      "/admin/postal-code-audit",
      "/admin/owners/text-hygiene",
      "/admin/owners/quality-audit",
      "/admin/orphan-dm-logs",
      "/admin/users",
      "/admin/templates",
      "/admin/change-password",
      "/admin/permission-logs",
      "/admin/audit-logs",
      "/admin/attachments",
      "/help",
    ]) {
      expect(hrefs, kept).toContain(kept);
    }
  });

  it("重複した項目が無い(同じ画面を2か所に置かない)", () => {
    const hrefs = allItems.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
