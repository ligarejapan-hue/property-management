# 役割別ホーム画面＋役割で出し分けるサイドバー Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ログイン後に役割別ホーム(ランチャー)へ着地し、サイドバーを役割(field_staff/office_staff/admin)で出し分ける。

**Architecture:** 役割の可視ロジックを純モジュール `roles.ts` に集約。ナビ定義(サイドバーのグループ・ホームのカード)を `nav-model.tsx` に一元化し、各項目の `minRole` で `visibleSidebar`/`visibleHomeCards` が絞る。`sidebar.tsx` と新 `home/page.tsx` は同じモデルを読む。root/ログインの着地を `/home` に変更。

**Tech Stack:** TypeScript / React (Next.js App Router・(dashboard) は client レイアウト+useSession) / lucide-react / Vitest(env=node)。

## Global Constraints

- **新規依存・migration・schema・権限(permission)変更は禁止**(このプランでは行わない)。ナビの表示可否のみ=アクセス制御ではない。
- ホームのカードは**既存ページへの Link のみ**(新しい機能画面・新ルートは作らない。`/home` を除く)。
- 役割判定は `roles.ts` に集約。未知・未設定(旧 VIEWER 等)は **field_staff 相当(最も制限的)** にフォールバック。
- UI テストは env=node(jsdom 無)。**純関数(visible*)のユニットテストを主**とし、描画は自明変更+レビュー+必要ならソース文字列 assert で担保(既存 `*-nav-source.test` 準拠)。
- 「緑」宣言前に フル `npx vitest run`・`tsc --noEmit`・eslint(変更分)・`npm run build`。

## ファイル構成

- **Create** `src/lib/nav/roles.ts` — `AppRole`/`ROLE_LEVEL`/`roleLevel`/`canSee`(純・React非依存)。
- **Create** `src/components/layout/nav-model.tsx` — `SIDEBAR_GROUPS`/`HOME_CARDS`(minRole 付きデータ+lucideアイコン)、`visibleSidebar(userRole)`/`visibleHomeCards(userRole)`(純フィルタ)。
- **Modify** `src/components/layout/sidebar.tsx` — インライン配列を廃し `visibleSidebar(userRole)` から描画。先頭に「ホーム」。
- **Create** `src/components/home/HomeContent.tsx` — 提示コンポーネント(userRole を受け `visibleHomeCards` をカード描画)。
- **Create** `src/app/(dashboard)/home/page.tsx` — client。`useSession` で role を取り `<HomeContent>`。
- **Modify** `src/app/page.tsx` — `redirect("/home")`。
- **Modify** `src/app/(auth)/login/page.tsx` — `safeInternalDest` の fallback を `/home`。
- **Test** `src/lib/nav/__tests__/roles.test.ts`、`src/components/layout/__tests__/nav-model.test.tsx`、`src/app/__tests__/landing-source.test.ts`。

---

### Task 1: 役割の可視ロジック `roles.ts`

**Files:**
- Create: `src/lib/nav/roles.ts`
- Test: `src/lib/nav/__tests__/roles.test.ts`

**Interfaces:**
- Produces: `type AppRole = "field_staff"|"office_staff"|"admin"`、`ROLE_LEVEL: Record<AppRole, number>`、`roleLevel(role?: string|null): number`、`canSee(userRole: string|null|undefined, minRole: AppRole): boolean`。

- [ ] **Step 1: 失敗するテストを書く**

Create `src/lib/nav/__tests__/roles.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { roleLevel, canSee } from "../roles";

describe("roleLevel", () => {
  it("3ロールを 1/2/3 に写像する", () => {
    expect(roleLevel("field_staff")).toBe(1);
    expect(roleLevel("office_staff")).toBe(2);
    expect(roleLevel("admin")).toBe(3);
  });
  it("大文字も許容する(ADMIN)", () => {
    expect(roleLevel("ADMIN")).toBe(3);
  });
  it("未知・未設定は現場相当(1)にフォールバック", () => {
    expect(roleLevel("VIEWER")).toBe(1);
    expect(roleLevel(undefined)).toBe(1);
    expect(roleLevel(null)).toBe(1);
    expect(roleLevel("")).toBe(1);
  });
});

describe("canSee", () => {
  it("admin は全ての minRole を満たす", () => {
    expect(canSee("admin", "field_staff")).toBe(true);
    expect(canSee("admin", "office_staff")).toBe(true);
    expect(canSee("admin", "admin")).toBe(true);
  });
  it("field_staff は office/admin 限定を見られない", () => {
    expect(canSee("field_staff", "field_staff")).toBe(true);
    expect(canSee("field_staff", "office_staff")).toBe(false);
    expect(canSee("field_staff", "admin")).toBe(false);
  });
  it("office_staff は admin 限定を見られない", () => {
    expect(canSee("office_staff", "office_staff")).toBe(true);
    expect(canSee("office_staff", "admin")).toBe(false);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/lib/nav/__tests__/roles.test.ts`
Expected: FAIL(`../roles` が無い)。

- [ ] **Step 3: 実装**

Create `src/lib/nav/roles.ts`:

```ts
/** アプリの役割(prisma Role enum と対応)。 */
export type AppRole = "field_staff" | "office_staff" | "admin";

/** 役割の可視レベル。数が大きいほど広く見える。 */
export const ROLE_LEVEL: Record<AppRole, number> = {
  field_staff: 1,
  office_staff: 2,
  admin: 3,
};

/**
 * セッションの role 文字列 → 可視レベル。大文字小文字は無視する。
 * 未知・未設定(旧 VIEWER 等、正規の role が無い)は最も制限的な field_staff 相当(1)に
 * フォールバック=余計なものを出さない安全側。
 */
export function roleLevel(role?: string | null): number {
  const key = (role ?? "").toLowerCase();
  if (Object.prototype.hasOwnProperty.call(ROLE_LEVEL, key)) {
    return ROLE_LEVEL[key as AppRole];
  }
  return ROLE_LEVEL.field_staff;
}

/** userRole が minRole 以上か(その項目を見せてよいか)。 */
export function canSee(userRole: string | null | undefined, minRole: AppRole): boolean {
  return roleLevel(userRole) >= ROLE_LEVEL[minRole];
}
```

- [ ] **Step 4: 通過を確認**

Run: `npx vitest run src/lib/nav/__tests__/roles.test.ts`
Expected: PASS。

- [ ] **Step 5: コミット**

```bash
git add src/lib/nav/roles.ts src/lib/nav/__tests__/roles.test.ts
git commit -m "feat(nav): 役割の可視ロジック roles.ts(roleLevel/canSee)"
```

---

### Task 2: ナビ定義 `nav-model.tsx`(グループ+ホームカード+絞り込み)

**Files:**
- Create: `src/components/layout/nav-model.tsx`
- Test: `src/components/layout/__tests__/nav-model.test.tsx`

**Interfaces:**
- Consumes: `AppRole`/`canSee`(Task 1)。
- Produces:
  - `interface NavLeaf { label: string; href: string; icon: React.ReactNode; minRole: AppRole; external?: boolean }`
  - `interface NavGroup { key: string; label: string | null; collapsible?: boolean; items: NavLeaf[] }`
  - `interface HomeCard { label: string; href: string; icon: React.ReactNode; desc: string; minRole: AppRole; big?: boolean }`
  - `SIDEBAR_GROUPS: NavGroup[]`、`HOME_CARDS: HomeCard[]`
  - `visibleSidebar(userRole: string): NavGroup[]` — canSee で items を絞り、空グループを除く。
  - `visibleHomeCards(userRole: string): HomeCard[]` — canSee で絞る。

- [ ] **Step 1: 失敗するテストを書く**

Create `src/components/layout/__tests__/nav-model.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { visibleSidebar, visibleHomeCards } from "../nav-model";

function sidebarLabels(role: string): string[] {
  return visibleSidebar(role).flatMap((g) => g.items.map((i) => i.label));
}
function groupLabels(role: string): (string | null)[] {
  return visibleSidebar(role).map((g) => g.label);
}
function homeLabels(role: string): string[] {
  return visibleHomeCards(role).map((c) => c.label);
}

describe("visibleSidebar", () => {
  it("現場: 現地調査＋資料＋ホームだけ。物件/取込/販売図面/管理は出ない", () => {
    const labels = sidebarLabels("field_staff");
    expect(labels).toContain("ホーム");
    expect(labels).toContain("現地調査マップ");
    expect(labels).toContain("使い方ガイド");
    expect(labels).not.toContain("物件一覧");
    expect(labels).not.toContain("受付帳CSV取込");
    expect(labels).not.toContain("販売図面を作成");
    expect(labels).not.toContain("ユーザー管理");
    // 空グループ(物件/取込/販売図面/売却DM/データ品質/システム管理)は見出しごと出ない
    expect(groupLabels("field_staff")).not.toContain("物件");
    expect(groupLabels("field_staff")).not.toContain("システム管理");
  });

  it("事務: 物件〜販売図面(作成)＋資料。管理者専用は出ない", () => {
    const labels = sidebarLabels("office_staff");
    expect(labels).toContain("物件一覧");
    expect(labels).toContain("受付帳CSV取込");
    expect(labels).toContain("販売図面を作成");
    expect(labels).not.toContain("会社情報");
    expect(labels).not.toContain("売却DM設定");
    expect(labels).not.toContain("ユーザー管理");
    expect(labels).not.toContain("所有者補正候補");
  });

  it("管理者: 全部見える(設定・データ品質・システム管理)", () => {
    const labels = sidebarLabels("admin");
    expect(labels).toContain("会社情報");
    expect(labels).toContain("売却DM設定");
    expect(labels).toContain("所有者補正候補");
    expect(labels).toContain("ユーザー管理");
    expect(labels).toContain("謄本取得の資格情報");
  });
});

describe("visibleHomeCards", () => {
  it("現場: 現地調査マップ(大)が先頭、物件/販売図面カードは無い", () => {
    const cards = visibleHomeCards("field_staff");
    expect(cards[0].label).toBe("現地調査マップ");
    expect(cards[0].big).toBe(true);
    expect(homeLabels("field_staff")).not.toContain("物件");
    expect(homeLabels("field_staff")).not.toContain("販売図面");
  });
  it("事務: 物件/現地調査/取込・登記/販売図面/資料。売却DM等は無い", () => {
    const labels = homeLabels("office_staff");
    expect(labels).toContain("物件");
    expect(labels).toContain("販売図面");
    expect(labels).not.toContain("売却DM");
    expect(labels).not.toContain("システム管理");
  });
  it("管理者: 売却DM・データ品質・システム管理カードもある", () => {
    const labels = homeLabels("admin");
    expect(labels).toContain("売却DM");
    expect(labels).toContain("データ品質");
    expect(labels).toContain("システム管理");
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/components/layout/__tests__/nav-model.test.tsx`
Expected: FAIL(`../nav-model` が無い)。

- [ ] **Step 3: 実装**

Create `src/components/layout/nav-model.tsx`:

```tsx
import {
  Home,
  Link2,
  Building2,
  Building,
  Users,
  Shield,
  FileText,
  HelpCircle,
  ClipboardList,
  History,
  Upload,
  KeyRound,
  UserCog,
  MapPinned,
  Map as MapIcon,
  ScanSearch,
  ScanText,
  ClipboardCheck,
  FileSearch,
  BookOpen,
  Newspaper,
  Mail,
} from "lucide-react";
import { canSee, type AppRole } from "@/lib/nav/roles";

export interface NavLeaf {
  label: string;
  href: string;
  icon: React.ReactNode;
  minRole: AppRole;
  /** true のとき Link ではなく別タブの <a>(静的HTML資料)。 */
  external?: boolean;
}
export interface NavGroup {
  key: string;
  /** null のときは見出しを描かない(先頭のホーム等)。 */
  label: string | null;
  collapsible?: boolean;
  items: NavLeaf[];
}
export interface HomeCard {
  label: string;
  href: string;
  icon: React.ReactNode;
  desc: string;
  minRole: AppRole;
  big?: boolean;
}

const ic = (C: React.ComponentType<{ className?: string }>) => <C className="h-5 w-5" />;

/** サイドバーの全定義(役割で絞る前)。順序はそのまま表示順。 */
export const SIDEBAR_GROUPS: NavGroup[] = [
  {
    key: "home",
    label: null,
    items: [{ label: "ホーム", href: "/home", icon: ic(Home), minRole: "field_staff" }],
  },
  {
    key: "prop",
    label: "物件",
    items: [
      { label: "物件一覧", href: "/properties", icon: ic(Building2), minRole: "office_staff" },
      { label: "マンション棟", href: "/buildings", icon: ic(Building), minRole: "office_staff" },
    ],
  },
  {
    key: "field",
    label: "現地調査",
    items: [
      { label: "現地調査マップ", href: "/field-survey/map", icon: ic(MapIcon), minRole: "field_staff" },
      { label: "巡回履歴", href: "/field-survey/sessions", icon: ic(History), minRole: "field_staff" },
      { label: "物件化の完成待ち", href: "/field-survey/candidates", icon: ic(ClipboardCheck), minRole: "field_staff" },
    ],
  },
  {
    key: "imp",
    label: "取込・登記",
    items: [
      { label: "受付帳CSV取込", href: "/import", icon: ic(Upload), minRole: "office_staff" },
      { label: "謄本PDF取込", href: "/import/registry-pdf", icon: ic(FileText), minRole: "office_staff" },
      { label: "謄本取得の資格情報", href: "/admin/registry-settings", icon: ic(FileText), minRole: "admin" },
    ],
  },
  {
    key: "sheet",
    label: "販売図面",
    items: [
      { label: "販売図面を作成", href: "/sales-sheets/new", icon: ic(Newspaper), minRole: "office_staff" },
      { label: "会社情報", href: "/admin/company-settings", icon: ic(Building2), minRole: "admin" },
    ],
  },
  {
    key: "dm",
    label: "売却DM",
    items: [{ label: "売却DM設定", href: "/admin/sale-dm-settings", icon: ic(Mail), minRole: "admin" }],
  },
  {
    key: "dq",
    label: "データ品質",
    collapsible: true,
    items: [
      { label: "所有者補正候補", href: "/admin/owners/correction", icon: ic(UserCog), minRole: "admin" },
      { label: "法人番号紐づけ", href: "/admin/owners/correction?tab=corporate_restore", icon: ic(Link2), minRole: "admin" },
      { label: "表示名監査", href: "/admin/display-name-audit", icon: ic(ScanSearch), minRole: "admin" },
      { label: "郵便番号×住所チェック", href: "/admin/postal-code-audit", icon: ic(MapPinned), minRole: "admin" },
      { label: "テキスト衛生監査", href: "/admin/owners/text-hygiene", icon: ic(ScanText), minRole: "admin" },
      { label: "氏名・連絡先チェック", href: "/admin/owners/quality-audit", icon: ic(ClipboardCheck), minRole: "admin" },
    ],
  },
  {
    key: "admin",
    label: "システム管理",
    collapsible: true,
    items: [
      { label: "ユーザー管理", href: "/admin/users", icon: ic(Users), minRole: "admin" },
      { label: "権限テンプレート", href: "/admin/templates", icon: ic(Shield), minRole: "admin" },
      { label: "パスワード変更", href: "/admin/change-password", icon: ic(KeyRound), minRole: "admin" },
      { label: "権限変更履歴", href: "/admin/permission-logs", icon: ic(History), minRole: "admin" },
      { label: "監査ログ", href: "/admin/audit-logs", icon: ic(ClipboardList), minRole: "admin" },
      { label: "添付検索", href: "/admin/attachments", icon: ic(FileSearch), minRole: "admin" },
    ],
  },
  {
    key: "doc",
    label: "資料",
    items: [
      { label: "使い方ガイド", href: "/docs/guide.html", icon: ic(BookOpen), minRole: "field_staff", external: true },
      { label: "取り扱いマニュアル", href: "/docs/manual.html", icon: ic(FileText), minRole: "field_staff", external: true },
      { label: "ヘルプ", href: "/help", icon: ic(HelpCircle), minRole: "field_staff" },
    ],
  },
];

/** ホームのカード定義(役割で絞る前)。現場は現地調査マップを大カードで先頭に。 */
export const HOME_CARDS: HomeCard[] = [
  { label: "現地調査マップ", href: "/field-survey/map", icon: ic(MapIcon), desc: "今日の巡回はここから", minRole: "field_staff", big: true },
  { label: "巡回履歴", href: "/field-survey/sessions", icon: ic(History), desc: "過去の記録", minRole: "field_staff" },
  { label: "物件化の完成待ち", href: "/field-survey/candidates", icon: ic(ClipboardCheck), desc: "あと少しの物件", minRole: "field_staff" },
  { label: "物件", href: "/properties", icon: ic(Building2), desc: "物件一覧・マンション棟", minRole: "office_staff" },
  { label: "取込・登記", href: "/import", icon: ic(Upload), desc: "受付帳・謄本の取込", minRole: "office_staff" },
  { label: "販売図面", href: "/sales-sheets/new", icon: ic(Newspaper), desc: "マイソクを作る", minRole: "office_staff" },
  { label: "売却DM", href: "/admin/sale-dm-settings", icon: ic(Mail), desc: "売却DMの設定", minRole: "admin" },
  { label: "データ品質", href: "/admin/owners/correction", icon: ic(UserCog), desc: "所有者データ点検", minRole: "admin" },
  { label: "システム管理", href: "/admin/users", icon: ic(Users), desc: "権限・ログ・添付", minRole: "admin" },
  { label: "資料", href: "/help", icon: ic(BookOpen), desc: "使い方・マニュアル", minRole: "field_staff" },
];

/** userRole で見えるサイドバーグループ(空グループは除く)。 */
export function visibleSidebar(userRole: string): NavGroup[] {
  return SIDEBAR_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((i) => canSee(userRole, i.minRole)) }))
    .filter((g) => g.items.length > 0);
}

/** userRole で見えるホームカード。 */
export function visibleHomeCards(userRole: string): HomeCard[] {
  return HOME_CARDS.filter((c) => canSee(userRole, c.minRole));
}
```

Note: `ic(MapIcon)` の `MapIcon` は `Map as MapIcon`(グローバル `Map` 回避の別名)。`ic` の引数型 `React.ComponentType<{ className?: string }>` は全 lucide アイコンを受ける。

- [ ] **Step 4: 通過を確認**

Run: `npx vitest run src/components/layout/__tests__/nav-model.test.tsx`
Expected: PASS(全 describe)。

- [ ] **Step 5: コミット**

```bash
git add src/components/layout/nav-model.tsx src/components/layout/__tests__/nav-model.test.tsx
git commit -m "feat(nav): サイドバー/ホームのナビ定義 nav-model(minRole+visible*)"
```

---

### Task 3: サイドバーを nav-model 駆動＋役割出し分けに

**Files:**
- Modify: `src/components/layout/sidebar.tsx`
- Test: 既存 nav-source 系が通ること + Task 2 の nav-model.test が振る舞いを担保。

**Interfaces:**
- Consumes: `visibleSidebar`/`NavGroup`/`NavLeaf`(Task 2)。既存 `SidebarProps { userRole, currentPath }`。

- [ ] **Step 1: インライン nav 配列と import を差し替え**

`sidebar.tsx` 冒頭の lucide 大量 import と `mainNavItems`/`adminNavItems`/`dataQualityNavItems` の3配列(現状 45-176 行相当)を削除し、次に置き換える(残す import は `Link`/`useState`/`ChevronDown`/`ChevronRight`/`Menu`/`X`/`FileText`/`ThemeToggle`):

```tsx
"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronDown, ChevronRight, Menu, X, FileText } from "lucide-react";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { visibleSidebar, type NavGroup, type NavLeaf } from "./nav-model";

interface SidebarProps {
  userRole: string;
  currentPath: string;
}
```

- [ ] **Step 2: `isActive` は現状維持、描画を nav-model 駆動へ**

`Sidebar` 本体を次の構成に置き換える(既存の isActive 特例・折りたたみ導出・mobile 挙動は保持し、描画元だけ `visibleSidebar(userRole)` に変える):

```tsx
export default function Sidebar({ userRole, currentPath }: SidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const groups = visibleSidebar(userRole);

  const isActive = (href: string) => {
    if (href === "/properties") return currentPath === href || currentPath.startsWith("/properties/");
    if (href === "/import") return currentPath === "/import";
    return currentPath === href || currentPath.startsWith(href + "/");
  };

  // 折りたたみグループの開閉: 手動トグル(未操作=null)が無ければ現在地がグループ内なら自動で開く。
  // 遷移のたび導出するため effect 不要(react-hooks/set-state-in-effect も踏まない)。
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const isOpen = (g: NavGroup) =>
    openMap[g.key] ?? g.items.some((i) => isActive(i.href));

  const linkClasses = (href: string) =>
    `flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
      isActive(href)
        ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300"
        : "text-gray-700 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
    }`;

  const renderLeaf = (item: NavLeaf) =>
    item.external ? (
      <a
        key={item.href}
        href={item.href}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClasses(item.href)}
        onClick={() => setMobileOpen(false)}
      >
        {item.icon}
        {item.label}
      </a>
    ) : (
      <Link key={item.href} href={item.href} className={linkClasses(item.href)} onClick={() => setMobileOpen(false)}>
        {item.icon}
        {item.label}
      </Link>
    );

  const renderGroup = (g: NavGroup) => {
    if (!g.label) return <div key={g.key}>{g.items.map(renderLeaf)}</div>;
    if (g.collapsible) {
      const open = isOpen(g);
      return (
        <div key={g.key}>
          <div className="mt-4 mb-1">
            <button
              onClick={() => setOpenMap((m) => ({ ...m, [g.key]: !open }))}
              aria-expanded={open}
              className="flex w-full items-center gap-2 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            >
              {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {g.label}
            </button>
          </div>
          {open && g.items.map(renderLeaf)}
        </div>
      );
    }
    return (
      <div key={g.key}>
        <div className="mt-4 mb-1">
          <p className="px-3 py-1 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {g.label}
          </p>
        </div>
        {g.items.map(renderLeaf)}
      </div>
    );
  };

  const navContent = <nav className="flex flex-col gap-1 p-4">{groups.map(renderGroup)}</nav>;

  return (
    <>
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        className="fixed top-3 left-3 z-50 rounded-md bg-white dark:bg-gray-900 p-2 shadow-md lg:hidden"
        aria-label="メニューを開く"
      >
        {mobileOpen ? <X className="h-5 w-5 text-gray-700 dark:text-gray-300" /> : <Menu className="h-5 w-5 text-gray-700 dark:text-gray-300" />}
      </button>
      {mobileOpen && <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setMobileOpen(false)} />}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-60 transform flex-col border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 transition-transform duration-200 lg:static lg:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-14 shrink-0 items-center border-b border-gray-200 dark:border-gray-700 pl-14 pr-4 lg:pl-4">
          <FileText className="mr-2 h-5 w-5 text-indigo-600 dark:text-indigo-400" />
          <span className="text-sm font-bold text-gray-800 dark:text-gray-100">物件管理</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{navContent}</div>
        <div className="shrink-0 border-t border-gray-200 dark:border-gray-700 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] lg:hidden">
          <div className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">表示テーマ</div>
          <ThemeToggle />
        </div>
      </aside>
    </>
  );
}
```

- [ ] **Step 3: 既存 nav-source テストの読み込み先を nav-model.tsx へ更新(必須)**

3つの source テストは `sidebar.tsx` を readFileSync して nav 文字列(label/href/出現回数)を検証している。nav データは nav-model.tsx へ移ったので **読み込み先を nav-model.tsx へ変更**する(アサーション本文はそのままで通る＝同じ label/href が nav-model に1回ずつ存在する)。

1. `src/components/layout/__tests__/company-settings-nav-source.test.ts`:
   `path.resolve(process.cwd(), "src/components/layout/sidebar.tsx")` → `"src/components/layout/nav-model.tsx"`
2. `src/lib/__tests__/nav-wire-source.test.ts`:
   `SIDEBAR_SRC` の `path.resolve(process.cwd(), "src/components/layout/sidebar.tsx")` → `"src/components/layout/nav-model.tsx"`(`PROPERTY_DETAIL_SRC` はそのまま)
3. `src/components/layout/__tests__/corporate-link-nav-source.test.ts`:
   `sidebarSrc` の `resolve(__dirname, "../sidebar.tsx")` → `resolve(__dirname, "../nav-model.tsx")`

Run: `npx vitest run src/components/layout src/lib/__tests__/nav-wire-source.test.ts`
Expected: PASS(3テストとも読み込み先の変更だけで緑)。落ちたら nav-model の該当 label/href の綴り・出現回数を確認。

- [ ] **Step 4: tsc**

Run: `npx tsc --noEmit`
Expected: 0(未使用 import が無いこと)。

- [ ] **Step 5: コミット**

```bash
git add src/components/layout/sidebar.tsx
git commit -m "feat(nav): サイドバーを nav-model 駆動＋役割で出し分け(ホーム追加)"
```

---

### Task 4: 役割別ホーム画面 `/home`

**Files:**
- Create: `src/components/home/HomeContent.tsx`
- Create: `src/app/(dashboard)/home/page.tsx`
- Test: `src/components/home/__tests__/home-content.test.tsx`

**Interfaces:**
- Consumes: `visibleHomeCards`(Task 2)。
- Produces: `HomeContent({ userRole }: { userRole: string })`(提示コンポーネント)。

- [ ] **Step 1: 失敗するテストを書く**

Create `src/components/home/__tests__/home-content.test.tsx`:

```tsx
import { vi, describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

// next/link → plain <a>(node 環境で renderToStaticMarkup が動くように・router 無し。
// 既存 sales-sheet-list.test.tsx と同方針)。
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) =>
    createElement("a", { href }, children as never),
}));

import { HomeContent } from "../HomeContent";

describe("HomeContent", () => {
  it("現場: 現地調査マップの大カードが出て、物件/販売図面カードは出ない", () => {
    const html = renderToStaticMarkup(<HomeContent userRole="field_staff" />);
    expect(html).toContain("現地調査マップ");
    expect(html).toContain("今日の巡回はここから");
    // 「物件化の完成待ち」と部分一致しないよう、office+ カードは説明文で判定する。
    expect(html).not.toContain("物件一覧・マンション棟"); // 物件カード(office+)の説明
    expect(html).not.toContain("マイソクを作る"); // 販売図面カード(office+)の説明
  });
  it("管理者: システム管理・売却DMカードが出る", () => {
    const html = renderToStaticMarkup(<HomeContent userRole="admin" />);
    expect(html).toContain("システム管理");
    expect(html).toContain("売却DMの設定"); // 売却DMカードの説明
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/components/home/__tests__/home-content.test.tsx`
Expected: FAIL(`../HomeContent` が無い)。

- [ ] **Step 3: HomeContent を実装**

Create `src/components/home/HomeContent.tsx`:

```tsx
import Link from "next/link";
import { visibleHomeCards } from "@/components/layout/nav-model";

/** 役割別ホーム(ランチャー)。カードは既存ページへの Link。userRole は親(page)がセッションから渡す。 */
export function HomeContent({ userRole }: { userRole: string }) {
  const cards = visibleHomeCards(userRole);
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-lg font-bold text-gray-900 dark:text-gray-100">ホーム</h1>
      <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">やりたいことを選んでください。</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {cards.map((c) => (
          <Link
            key={c.href + c.label}
            href={c.href}
            className={`flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm transition-colors hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-gray-700 dark:bg-gray-900 dark:hover:border-indigo-700 dark:hover:bg-indigo-900/20 ${
              c.big ? "sm:col-span-2" : ""
            }`}
          >
            <span className="mt-0.5 text-indigo-600 dark:text-indigo-400">{c.icon}</span>
            <span className="flex flex-col">
              <span className={`font-semibold text-gray-900 dark:text-gray-100 ${c.big ? "text-lg" : "text-sm"}`}>{c.label}</span>
              <span className="text-xs text-gray-500 dark:text-gray-400">{c.desc}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 通過を確認**

Run: `npx vitest run src/components/home/__tests__/home-content.test.tsx`
Expected: PASS。次に page を作る。

- [ ] **Step 5: home/page.tsx を実装**

Create `src/app/(dashboard)/home/page.tsx`:

```tsx
"use client";

import { useSession } from "next-auth/react";
import { HomeContent } from "@/components/home/HomeContent";
import { USE_MOCK } from "@/lib/api-client";

export default function HomePage() {
  const { data: session } = useSession();
  const userRole = USE_MOCK ? "admin" : ((session?.user as { role?: string } | undefined)?.role ?? "field_staff");
  return <HomeContent userRole={userRole} />;
}
```

（`(dashboard)` レイアウトが SessionProvider＋読み込み/未認証ガードを既に持つため、ここは認証済み前提で描画してよい。未取得時の role は最も安全な field_staff にフォールバック。）

- [ ] **Step 6: tsc + テスト**

Run: `npx tsc --noEmit`
Expected: 0。
Run: `npx vitest run src/components/home`
Expected: PASS。

- [ ] **Step 7: コミット**

```bash
git add src/components/home/HomeContent.tsx "src/app/(dashboard)/home/page.tsx" src/components/home/__tests__/home-content.test.tsx
git commit -m "feat(nav): 役割別ホーム画面 /home(HomeContent+page)"
```

---

### Task 5: 着地を `/home` へ(root リダイレクト＋ログイン fallback)

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/app/(auth)/login/page.tsx`(`safeInternalDest` の fallback)
- Test: `src/app/__tests__/landing-source.test.ts`

**Interfaces:**
- Consumes: なし(文字列の変更)。

- [ ] **Step 1: 失敗するテストを書く**

Create `src/app/__tests__/landing-source.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

describe("ログイン後の着地は /home", () => {
  it("root page は /home へ redirect する", () => {
    const src = readFileSync(join(root, "src/app/page.tsx"), "utf8");
    expect(src).toContain('redirect("/home")');
    expect(src).not.toContain('redirect("/properties")');
  });
  it("ログインの既定 fallback は /home", () => {
    const src = readFileSync(join(root, "src/app/(auth)/login/page.tsx"), "utf8");
    expect(src).toContain('const fallback = "/home"');
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run src/app/__tests__/landing-source.test.ts`
Expected: FAIL。

- [ ] **Step 3: root redirect を変更**

`src/app/page.tsx` の `redirect("/properties")` を次へ:

```tsx
  redirect("/home");
```

- [ ] **Step 4: ログイン fallback を変更**

`src/app/(auth)/login/page.tsx` の `safeInternalDest` 内 `const fallback = "/properties";` を次へ:

```tsx
  const fallback = "/home";
```

- [ ] **Step 5: 通過を確認**

Run: `npx vitest run src/app/__tests__/landing-source.test.ts`
Expected: PASS。

- [ ] **Step 6: コミット**

```bash
git add src/app/page.tsx "src/app/(auth)/login/page.tsx" src/app/__tests__/landing-source.test.ts
git commit -m "feat(nav): root/ログインの着地を役割別ホーム /home へ"
```

---

### Task 6: 全ゲート + 提出前レビュー

**Files:** なし(検証のみ)

- [ ] **Step 1: フルスイート**

Run: `npx vitest run`
Expected: 全 PASS。落ちるものがあれば Task 3 Step 3 の nav-source 系(旧配列名依存)を疑い、nav-model を見る形へ直す。

- [ ] **Step 2: 型・lint・build**

Run: `npx tsc --noEmit` → 0
Run: `npx eslint src/lib/nav/roles.ts src/components/layout/nav-model.tsx src/components/layout/sidebar.tsx src/components/home/HomeContent.tsx "src/app/(dashboard)/home/page.tsx" src/app/page.tsx "src/app/(auth)/login/page.tsx"` → 0 error
Run: `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run build` → 成功(標準出力の route 一覧に `/home` が載る)

- [ ] **Step 3: 提出前レビュー**

`feature-dev:code-reviewer` に staged diff をレビュー。ホットスポット指定: (1) 役割フォールバックの安全性(未知/未設定=最も制限的か・admin だけに見せる項目が field/office に漏れないか)、(2) 認可はナビ表示のみでアクセス制御ではない点=各ページ側の権限検証を弱めていないか、(3) 既存 nav-source テストとの整合、(4) ホームのカード href が既存ルートを正しく指すか。

## Self-Review(記入済み)

**Spec coverage:**
- 役割レベル集約 = Task 1(roles.ts)。✓
- サイドバー役割出し分け＋ホーム導線 = Task 2/3(nav-model+sidebar・ホーム項目)。✓
- ホーム画面(役割別カード) = Task 4。✓
- 着地を /home(root+login) = Task 5。✓
- 未知役割は field 相当 = Task 1(roleLevel フォールバック)+ Task 4(page の ?? "field_staff")。✓
- 依存/migration/schema/権限 変更なし = 全タスクが並べ替え/出し分け/新ページのみ。✓
- テスト方針(純関数主) = Task 1/2 のユニット + Task 4 の SSR + Task 5 の source。✓

**Placeholder scan:** なし(全 step に実コード/実コマンド)。

**Type consistency:** `roleLevel`/`canSee`/`AppRole`(roles.ts)、`NavGroup`/`NavLeaf`/`HomeCard`/`visibleSidebar`/`visibleHomeCards`(nav-model)、`HomeContent({userRole})` は全タスクで一致。sidebar は `visibleSidebar`/`NavGroup`/`NavLeaf` を consume。home page は `HomeContent` を consume。
