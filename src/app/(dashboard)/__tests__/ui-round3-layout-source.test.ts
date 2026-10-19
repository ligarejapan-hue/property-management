import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { MenuButton } from "@/components/ui/menu-button";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const DETAIL = read("src/app/(dashboard)/properties/[id]/page.tsx");
const LIST = read("src/app/(dashboard)/properties/page.tsx");
const REGISTRY = read("src/components/properties/registry-location-search-button.tsx");

/**
 * 画面すっきり化 第3回(発注者決定 2026-10-16・2問とも「おすすめ」)。
 * 機能は消さず、置き場所と見せ方だけを変える。
 *   物件の画面: 表=物件一覧・販売図面を作成・物件を編集・その他 ▾ / その他 ▾=DM送付履歴・所在で謄本を検索・
 *              登記取得済にする・物件を削除 / 「調査を確認する」は未確認の帯の中の「確認した」へ
 *   物件一覧: 「出力 ▾」=CSV出力・DM差込CSV出力・送付の確定 / DM判断・担当者は詳細条件の中 /
 *            リセットは絞り込み中だけ / 売却DMを作成・謄本を一括取得は物件を選んだときの帯へ
 */
describe("「その他 ▾」「出力 ▾」の部品", () => {
  it("項目が0件ならボタンごと出さない(空のメニューを開かせない)", () => {
    expect(renderToStaticMarkup(createElement(MenuButton, { label: "その他", items: [] }))).toBe("");
  });

  it("閉じているときはボタンだけ(メニューの中身は出さない)", () => {
    const html = renderToStaticMarkup(
      createElement(MenuButton, { label: "その他", items: [{ key: "a", label: "物件を削除", onSelect: () => {} }] }),
    );
    expect(html).toContain("その他");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain("物件を削除");
  });
});

describe("物件の画面: タブの上のボタン", () => {
  const header = DETAIL.slice(DETAIL.indexOf("{/* Header */}"), DETAIL.indexOf("{/* 見ている側の帯"));
  const items = DETAIL.slice(DETAIL.indexOf("const moreMenuItems"), DETAIL.indexOf("];", DETAIL.indexOf("const moreMenuItems")));

  it("表に並ぶのは 物件一覧・販売図面を作成・物件を編集・その他 ▾ だけ", () => {
    expect(header).toContain("物件一覧");
    expect(header).toContain("<SalesSheetCreateButton");
    expect(header).toContain("物件を編集");
    expect(header).toMatch(/<MenuButton\s+label="その他"[\s\S]*?items=\{moreMenuItems\}/);
    // 移した2つは表に残っていない
    expect(header).not.toContain("dm-logs");
    expect(header).not.toContain("onClick={handleDelete}");
  });

  it("その他 ▾ の4つは、表に置いていたときと同じ条件で出し分ける", () => {
    expect(items).toMatch(/canReadOwner\s*\?\s*\[\{ key: "dm-logs", label: "DM送付履歴"[^\]]*href: `\/properties\/\$\{property\.id\}\/dm-logs`/);
    expect(items).toMatch(/canAutoFetchRegistry\s*\?\s*\[\{ key: "registry-search", label: "所在で謄本を検索"/);
    expect(items).toMatch(/canWriteProperty && property\.registryStatus !== "obtained"\s*\?\s*\[\{\s*key: "registry-obtained",\s*label: "登記取得済にする"/);
    expect(items).toMatch(/canDeleteProperty\s*\?\s*\[\{ key: "delete", label: "物件を削除"[^\]]*danger: true[^\]]*handleDelete\(\)/);
  });

  it("「登記取得済にする」の結果は ActionBar と同じ実行口を通る(文言が ActionBar の下に出る)", () => {
    expect(DETAIL).toMatch(/const propertyAction = usePropertyAction\(id, fetchProperty\);/);
    expect(items).toContain('propertyAction.run("mark_registry_obtained")');
    expect(DETAIL).toMatch(/<ActionBar[\s\S]*?action=\{propertyAction\}/);
  });

  it("すでに自分が担当なら「自分を担当にする」を出さない(自分が誰か分からないうちは出す)", () => {
    expect(DETAIL).toContain("assignedToMe={myUserId !== null && property.assignedTo === myUserId}");
  });

  it("調査未確認の帯はページ側に2つ目を持たない(ActionBar の帯1つだけ)", () => {
    expect(DETAIL).not.toContain("調査情報が未確認です");
    expect(read("src/components/properties/action-bar.tsx")).toContain("調査情報が未確認です");
  });

  it("所在で謄本を検索は「その他 ▾」から開いたときだけ出し、開いた直後は確認から始める", () => {
    expect(DETAIL).toMatch(/\{registrySearch !== "closed" && \(\s*<RegistryLocationSearchButton/);
    expect(DETAIL).toContain('autoStart={registrySearch === "start"}');
    expect(DETAIL).toContain("onAutoStartConsumed={consumeRegistryAutoStart}");
    expect(DETAIL).toContain('setRegistrySearch("open")');
    // 開いている最中にもう一度選んでも、進行中の流れを作り直さない
    expect(DETAIL).toContain('setRegistrySearch((s) => (s === "closed" ? "start" : s))');
  });

  it("所在検索の部品: 自動の開始は1回だけ・使えないときは確認へ進まない", () => {
    expect(REGISTRY).toMatch(/useState<State>\(\(\) =>\s*autoStart && canAutoFetch && providerConfigured \? "confirmSearch" : "idle",?\s*\)/);
    expect(REGISTRY).toMatch(/if \(autoStart\) onAutoStartConsumed\?\.\(\);/);
    // ⚠使えないときの取り込み(回収)の入口は従来どおり残す(期限のある書類のため)
    expect(REGISTRY).toContain("{showButton && providerDisabled && recoverEntryLink}");
  });
});

describe("物件一覧: いつも出ている操作", () => {
  const actionRow = LIST.slice(LIST.indexOf("{/* Action row */}"), LIST.indexOf("{showNewModal && ("));
  const bulkAt = LIST.indexOf("{selectedIds.size > 0 && (");
  const bulkBar = LIST.slice(bulkAt, LIST.indexOf("{/* Bulk delete result */}"));

  it("出力の3つは「出力 ▾」1つにまとめる", () => {
    expect(actionRow).toMatch(/<MenuButton\s+label="出力"/);
    for (const label of ["CSV出力", "DM差込CSV出力", "送付の確定"]) expect(actionRow).toContain(`label: "${label}"`);
    expect(actionRow).toContain("新規物件登録");
  });

  it("売却DMを作成・謄本を一括取得は、表から外して物件を選んだときの帯の中へ", () => {
    expect(actionRow).not.toContain("売却DMを作成");
    expect(actionRow).not.toContain("<RegistryBulkFetchButton");
    expect(bulkBar).toContain("売却DMを作成");
    expect(bulkBar).toContain("<RegistryBulkFetchButton");
    // 出す条件は従来どおり(権限+設定)
    expect(bulkBar).toContain("canCreateDm && capabilities?.saleDmPrintReady");
    expect(bulkBar).toContain("canBulkRegistry && capabilities?.registryPurchase");
  });

  it("選ぶ前は、まとめて行う操作のありかを1行で案内する", () => {
    const hint = LIST.slice(LIST.indexOf("{selectedIds.size === 0 && properties.length > 0 && ("), LIST.indexOf("ができます") + 10);
    expect(hint).toContain("物件を選ぶと、");
    // 使えない操作の名前は出さない(帯の中のボタンと同じ条件)
    expect(hint).toContain('canCreateDm && capabilities?.saleDmPrintReady ? ["売却DMの作成"]');
    expect(hint).toContain('canBulkRegistry && capabilities?.registryPurchase ? ["謄本の一括取得"]');
    expect(hint).toContain('"まとめて変更"');
  });

  it("リセットは絞り込み中だけ出す", () => {
    // UIの統一 第3回: 共通 Button(secondary)へ置き換え済み
    expect(LIST).toMatch(/\{hasActiveFilter && \(\s*<Button\s+variant="secondary"\s+onClick=\{handleResetFilters\}/);
  });

  it("DM判断・担当者が URL で効いているときは、詳細条件を最初から開き、件数にも数える", () => {
    const init = LIST.slice(LIST.indexOf("const [advancedOpen, setAdvancedOpen]"), LIST.indexOf("const [advancedOpen, setAdvancedOpen]") + 400);
    expect(init).toContain('sp.get("dmStatus")');
    expect(init).toContain('sp.get("assignedTo")');
    const count = LIST.slice(LIST.indexOf("const advancedFilterCount"), LIST.indexOf("const advancedFilterCount") + 400);
    expect(count).toContain("dmFilter, assigneeFilter");
  });
});
