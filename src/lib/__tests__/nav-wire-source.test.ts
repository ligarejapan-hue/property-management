/**
 * nav 一括配線（新ページの発見性整備）のソース静的検証。
 *
 * vitest は node 環境ゆえコンポーネントの実 render はせず、新ページへの nav エントリ /
 * 導線がソース上に存在することを文字列レベルで固定する
 * （field-survey-map-ui-source.test.ts と同方針）。route 新設はせず既存ページへの導線のみ。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const SIDEBAR_SRC = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/layout/sidebar-model.tsx"),
  "utf8",
);
const PROPERTY_DETAIL_SRC = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/(dashboard)/properties/[id]/page.tsx"),
  "utf8",
);

describe("sidebar.tsx — admin nav エントリ追加（既存 text-hygiene 様式）", () => {
  it("氏名・連絡先チェック(旧: 品質監査) → /admin/owners/quality-audit の nav item がある", () => {
    // 2026-07-14 ユーザー要望で「品質監査」から改名(URL不変)。
    expect(SIDEBAR_SRC).toMatch(/href:\s*"\/admin\/owners\/quality-audit"/);
    expect(SIDEBAR_SRC).toMatch(/氏名・連絡先チェック/);
  });

  it("添付検索 → /admin/attachments の nav item がある", () => {
    expect(SIDEBAR_SRC).toMatch(/href:\s*"\/admin\/attachments"/);
    expect(SIDEBAR_SRC).toMatch(/添付検索/);
  });

  it("既配線の text-hygiene を重複追加しない（/admin/owners/text-hygiene は 1 回のみ）", () => {
    const matches = SIDEBAR_SRC.match(/\/admin\/owners\/text-hygiene/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe("properties/[id]/page.tsx — dm-logs 導線（既存ページへのリンク・route 新設なし）", () => {
  it("DM送付履歴ページ(/dm-logs)への導線がある", () => {
    expect(PROPERTY_DETAIL_SRC).toMatch(/\/dm-logs/);
    expect(PROPERTY_DETAIL_SRC).toMatch(/DM送付履歴/);
  });

  it("動的 href `/properties/${...}/dm-logs` への Link である（新設 route ではない）", () => {
    expect(PROPERTY_DETAIL_SRC).toMatch(/\/properties\/\$\{[^}]*\}\/dm-logs/);
  });
});

describe("sidebar.tsx — 販売図面を作成 nav エントリ（メニュー化）", () => {
  it("販売図面を作成 → /sales-sheets/new の nav item がある", () => {
    expect(SIDEBAR_SRC).toMatch(/href:\s*"\/sales-sheets\/new"/);
    expect(SIDEBAR_SRC).toMatch(/販売図面を作成/);
  });

  it("重複追加しない（/sales-sheets/new は 1 回のみ）", () => {
    const matches = SIDEBAR_SRC.match(/\/sales-sheets\/new/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
