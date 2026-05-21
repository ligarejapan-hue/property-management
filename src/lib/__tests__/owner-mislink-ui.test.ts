/**
 * OwnerMislinkModal / property 詳細 OwnerCard 統合の source assertion。
 *
 * 要件:
 *   - OwnerCard に「誤紐づき修正」ボタンが配置
 *   - モーダルに remove/relink ラジオ
 *   - relink 時に /api/owners/search を fetch
 *   - preview → execute の 2 段階確認
 *   - 「元に戻せません」文言
 *   - eligible=true のみ実行ボタン表示
 *   - onExecuted callback で property refresh
 *   - 通信エラー表示
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const modalSrc = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/components/owners/OwnerMislinkModal.tsx",
  ),
  "utf8",
);

const pageSrc = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/(dashboard)/properties/[id]/page.tsx",
  ),
  "utf8",
);

describe("OwnerMislinkModal: 操作・検索・preview/execute UI", () => {
  it("remove / relink のラジオを持つ", () => {
    expect(modalSrc).toMatch(/value="remove"/);
    expect(modalSrc).toMatch(/value="relink"/);
  });

  it("relink 時に /api/owners/search を fetch する", () => {
    expect(modalSrc).toMatch(/\/api\/owners\/search\?q=/);
  });

  it("preview endpoint を POST する", () => {
    expect(modalSrc).toMatch(
      /\/api\/admin\/owners\/correction\/mislink-preview/,
    );
  });

  it("execute endpoint を POST する (dryRun: false)", () => {
    expect(modalSrc).toMatch(/\/api\/admin\/owners\/correction\/mislink/);
    expect(modalSrc).toMatch(/dryRun:\s*false/);
  });

  it("eligible=true のみ実行ボタンを表示する条件式", () => {
    expect(modalSrc).toMatch(/previewResult[\s\S]*?\.eligible/);
    expect(modalSrc).toMatch(/previewResult\.eligible/);
  });

  it("2 段階確認 (confirm1 / confirm2) state を持つ", () => {
    expect(modalSrc).toMatch(/executeState\s*===\s*["']confirm1["']/);
    expect(modalSrc).toMatch(/executeState\s*===\s*["']confirm2["']/);
  });

  it("「元に戻せません」文言を表示", () => {
    expect(modalSrc).toContain("元に戻せません");
  });

  it("ownerMemoCountOnThisProperty 警告を表示", () => {
    expect(modalSrc).toMatch(/ownerMemoCountOnThisProperty/);
    expect(modalSrc).toContain("メモは元の所有者に残ります");
  });

  it("通信エラー banner（result=null + errorMsg）を持つ", () => {
    // previewState === "preview_error" バナー、または catch 経路で
    // setPreviewState("preview_error") + errorMsg をセット
    expect(modalSrc).toMatch(/preview_error/);
    expect(modalSrc).toMatch(/setPreviewErrorMsg/);
  });

  it("成功時に onExecuted callback を呼ぶ", () => {
    expect(modalSrc).toMatch(/onExecuted\?\.\(\)/);
  });

  it("operation / target 変更時に preview / execute state を reset する useEffect", () => {
    expect(modalSrc).toMatch(/useEffect/);
    // [operation, selectedTarget?.id] 依存
    expect(modalSrc).toMatch(/\[operation,\s*selectedTarget\?\.id\]/);
  });

  it("target archived 救済: api/owners/search の archived フィルタは API 側で済みだが UI は currentOwner を結果から除外", () => {
    expect(modalSrc).toMatch(/filter\(\(h\)\s*=>\s*h\.id\s*!==\s*currentOwnerId\)/);
  });
});

describe("property 詳細 page: OwnerCard に誤紐づき修正ボタンを追加", () => {
  it("OwnerMislinkModal を import している", () => {
    expect(pageSrc).toMatch(
      /import\s*\{\s*OwnerMislinkModal\s*\}\s*from\s*["']@\/components\/owners\/OwnerMislinkModal["']/,
    );
  });

  it("OwnerCard に「誤紐づき修正」ボタンが配置されている", () => {
    expect(pageSrc).toContain("誤紐づき修正");
  });

  it("成功時に onRefresh を呼ぶ", () => {
    // OwnerMislinkModal の onExecuted prop に refresh callback を渡す
    expect(pageSrc).toMatch(
      /<OwnerMislinkModal[\s\S]*?onExecuted=\{[\s\S]*?onRefresh\(\)/,
    );
  });

  it("modal を閉じる onClose も配線されている", () => {
    expect(pageSrc).toMatch(
      /<OwnerMislinkModal[\s\S]*?onClose=\{\(\)\s*=>\s*setMislinkOpen\(false\)\}/,
    );
  });
});
