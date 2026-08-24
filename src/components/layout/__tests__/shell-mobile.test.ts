/**
 * スマホUI修正の回帰テスト（2026-07 モバイル調整）。
 * 実機スクリーンショットで確認した崩れ(タイトル縦折れ/ボタン文字折れ/
 * ×ボタン被り/下部バー被り/マップパネル被り)の修正クラスが残っていることを
 * ソース文字列で固定する（shell-dark.test.ts と同方式）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(join(dir, ...p), "utf8");

const header = read("..", "header.tsx");
const sidebar = read("..", "sidebar.tsx");
const sidebarModel = read("..", "sidebar-model.tsx");
const dashboardLayout = read("..", "dashboard-layout.tsx");
const fieldSurveyMap = read("..", "..", "field-survey", "field-survey-map.tsx");
const propertyDetail = read(
  "..", "..", "..", "app", "(dashboard)", "properties", "[id]", "page.tsx",
);
const propertiesList = read(
  "..", "..", "..", "app", "(dashboard)", "properties", "page.tsx",
);
const adminUsers = read(
  "..", "..", "..", "app", "(dashboard)", "admin", "users", "page.tsx",
);
const auditLogs = read(
  "..", "..", "..", "app", "(dashboard)", "admin", "audit-logs", "page.tsx",
);

describe("header — モバイルで1行に収まる", () => {
  it("タイトルは truncate + min-w-0（縦折れしない）", () => {
    expect(header).toMatch(/h1 className="[^"]*min-w-0[^"]*truncate/);
  });
  it("タイトルの左余白はハンバーガー幅を確実に避ける pl-12", () => {
    expect(header).toContain("pl-12 lg:pl-0");
  });
  it("テーマ切替はモバイル非表示（メニューへ移動）", () => {
    expect(header).toMatch(/hidden sm:block[^>]*>\s*<ThemeToggle/);
  });
  it("ユーザー名はモバイル非表示（バッジのみ）", () => {
    expect(header).toMatch(/hidden md:inline/);
  });
});

describe("sidebar(ドロワー) — ×ボタン被り解消 + モバイル用テーマ切替", () => {
  it("ドロワーヘッダーは固定×ボタンを避ける pl-14", () => {
    expect(sidebar).toContain("pl-14 pr-4 lg:pl-4");
  });
  it("ドロワー下部にモバイル用テーマ切替（lg では非表示）", () => {
    expect(sidebar).toContain("表示テーマ");
    expect(sidebar).toMatch(/lg:hidden[\s\S]{0,200}<ThemeToggle/);
  });
  it("ナビ領域は flex-1 + overflow-y-auto（長いメニューがスクロール可能）", () => {
    expect(sidebar).toMatch(/min-h-0 flex-1 overflow-y-auto/);
  });
});

describe("sidebar — 管理系は折りたたみグループ(既定閉)", () => {
  it("物件データ編集・システム管理は collapsible グループ(nav-model)", () => {
    // メニュー再編(2026-08-24): 「データ品質」→「物件データ編集」に改名。
    // 「システム管理」は名前そのまま(発注者決定)。折りたたみの扱いは不変。
    expect(sidebarModel).toContain('label: "物件データ編集"');
    expect(sidebarModel).toContain('label: "システム管理"');
    expect(sidebarModel).toContain("collapsible: true");
  });
  it("開閉は現在地＋手動トグルから毎レンダー導出(client-side遷移に追従)", () => {
    // useState初期化のみだと永続layoutで再マウントされず遷移に追従しない(@codex P3)。
    // 手動トグル(openMap)が無ければ現在地(isActive)から開くよう導出する。
    expect(sidebar).toMatch(/openMap\[g\.key\] \?\? g\.items\.some/);
  });
  it("グループ見出しは aria-expanded を持つ", () => {
    expect(sidebar).toMatch(/aria-expanded=\{open\}/);
  });
  it("ドロワー最下部はホームインジケータを避ける safe-area 余白", () => {
    expect(sidebar).toContain("env(safe-area-inset-bottom)");
  });
});

describe("sidebar — 最下部の資料リンク(ガイド/マニュアル)", () => {
  it("使い方ガイドと取り扱いマニュアルへのリンクがある(nav-model)", () => {
    expect(sidebarModel).toContain('href: "/docs/guide.html"');
    expect(sidebarModel).toContain('href: "/docs/manual.html"');
    expect(sidebarModel).toContain("使い方ガイド");
    expect(sidebarModel).toContain("取り扱いマニュアル");
  });
  it("外部資料(external)は別タブで開く(target=_blank + rel=noopener)", () => {
    // nav-model 側で external: true、描画側(sidebar renderLeaf)が target=_blank + rel=noopener。
    expect(sidebarModel).toMatch(/href: "\/docs\/guide\.html"[\s\S]{0,80}external: true/);
    expect(sidebarModel).toMatch(/href: "\/docs\/manual\.html"[\s\S]{0,80}external: true/);
    expect(sidebar).toContain('target="_blank"');
    expect(sidebar).toContain('rel="noopener noreferrer"');
  });
  it("資料グループは管理系グループより後(最下部)に置かれる", () => {
    const admin = sidebarModel.indexOf('key: "admin"');
    const docs = sidebarModel.indexOf('key: "doc"');
    expect(admin).toBeGreaterThan(-1);
    expect(docs).toBeGreaterThan(admin);
  });
});

describe("dashboard-layout — 下部ツールバー被り解消", () => {
  it("main はモバイルで pb-24（lg では従来の pb-6）", () => {
    expect(dashboardLayout).toContain("p-4 pb-24 lg:p-6 lg:pb-6");
  });
});

describe("field-survey マップ — 表示切替パネルはモバイルで折りたたみ", () => {
  it("モバイル専用の開閉ボタンがある（md では非表示）", () => {
    // 2026-07-29:「ピン追加モード」廃止によりラベルは「巡回中」だけになった。
    // 併記で長くすると地図/航空写真ボタンへ重なりタップを奪う (既知の実機事故)。
    expect(fieldSurveyMap).toMatch(/表示切替\{hasActiveSession/);
    expect(fieldSurveyMap).toMatch(/aria-expanded=\{panelOpen\}/);
  });
  it("パネル本体は折りたたみ時 hidden・md 以上で常時表示", () => {
    expect(fieldSurveyMap).toMatch(/panelOpen \? "mt-2 block" : "hidden"/);
    expect(fieldSurveyMap).toMatch(/md:block/);
  });
});

describe("ボタン行 — ボタン内で文字が折れない", () => {
  it("物件詳細のアクション行は flex-wrap", () => {
    expect(propertyDetail).toContain('className="flex flex-wrap items-center gap-2"');
  });
  it("物件詳細の各ボタンは whitespace-nowrap", () => {
    const count = (propertyDetail.match(/whitespace-nowrap/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(4); // パンくず + DM履歴 + 編集 + 削除
  });
  it("物件一覧のアクション行は flex-wrap + 各ボタン nowrap", () => {
    expect(propertiesList).toContain('className="mb-4 flex flex-wrap justify-end gap-2"');
    const count = (propertiesList.match(/whitespace-nowrap/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(4); // CSV / DM差込 / 売却DM / 新規登録
  });
});

describe("管理者系の表 — 横スクロール枠", () => {
  it("ユーザー管理の表ラッパーは overflow-x-auto", () => {
    expect(adminUsers).toContain("overflow-x-auto rounded-lg border");
  });
  it("監査ログの表は overflow-x-auto ラッパー内", () => {
    expect(auditLogs).toContain('<div className="overflow-x-auto">');
  });
});
