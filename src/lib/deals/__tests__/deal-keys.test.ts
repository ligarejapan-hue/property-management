import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dealKeysSchema, readDealKeys, withDealKeys, DEAL_KEYS_MAX } from "../deal-keys";
import { withMailbox, DEFAULT_MAILBOX } from "../mailbox";
import { dealUpdateSchema } from "../schemas";
import { DEAL_TRACKED_FIELDS, toDealUpdateData } from "../change-values";
import { keyReceiptOptionsSchema } from "../documents/business/key-receipt";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DealKeysPanel from "@/components/deals/deal-keys-panel";
import { keyFormRowsOf } from "@/components/deals/business-docs-section";

const rows = [{ label: " 玄関 No.123 ", count: 2 }, { label: "", count: 1 }];

describe("取引の鍵の記録(2026-11-26 発注者: 番号・種類と本数)", () => {
  it("読み取り: 無い・壊れている → 空", () => {
    expect(readDealKeys({})).toEqual([]);
    expect(readDealKeys(null)).toEqual([]);
    expect(readDealKeys({ keys: [{ label: "x", count: 0 }] })).toEqual([]);
    expect(readDealKeys({ keys: "x" })).toEqual([]);
    expect(readDealKeys({ keys: [{ label: "玄関", count: 2 }] })).toEqual([{ label: "玄関", count: 2 }]);
  });
  it("保存: 番号・種類は前後の空白を落とし、空でもよい。本数は 1〜99。行は上限まで", () => {
    expect(dealKeysSchema.parse(rows)).toEqual([{ label: "玄関 No.123", count: 2 }, { label: "", count: 1 }]);
    expect(dealKeysSchema.safeParse([{ label: "a", count: 0 }]).success).toBe(false);
    expect(dealKeysSchema.safeParse([{ label: "a", count: 100 }]).success).toBe(false);
    expect(dealKeysSchema.safeParse([{ label: "a".repeat(51), count: 1 }]).success).toBe(false);
    expect(dealKeysSchema.safeParse(Array.from({ length: DEAL_KEYS_MAX + 1 }, () => ({ label: "", count: 1 }))).success).toBe(false);
    expect(dealUpdateSchema.parse({ version: 1, keys: rows }).keys?.[0].label).toBe("玄関 No.123");
  });
  it("鍵受領書の行と同じ形(そのまま初めの値に使える)", () => {
    const keys = dealKeysSchema.parse(rows);
    expect(keyReceiptOptionsSchema.safeParse({ receiver: "self", keys, receivedOn: null }).success).toBe(true);
  });
  it("checklist_state のほかの鍵(集合ポスト)は残して keys だけ差し替える", () => {
    const keys = dealKeysSchema.parse(rows);
    const withBox = withMailbox({ other: 1 }, DEFAULT_MAILBOX);
    expect(withDealKeys(withBox, keys)).toEqual({ other: 1, mailbox: DEFAULT_MAILBOX, keys });
    expect(withDealKeys([1], keys)).toEqual({ keys });
  });
  it("鍵の番号は変更履歴に値を残さない(追う項目に入れない・PATCH の素通しにも入れない)", () => {
    expect(DEAL_TRACKED_FIELDS).not.toContain("keys");
    expect(toDealUpdateData({ keys: dealKeysSchema.parse(rows) }, "brokerage")).toEqual({});
  });
  it("PATCH は集合ポストと鍵を同じ保存で送っても両方残す(差し替えをつなぐ)", () => {
    const src = readFileSync("src/app/api/deals/[id]/route.ts", "utf8");
    expect(src).toContain("withDealKeys(");
    expect(src).not.toContain("data.checklistState = withMailbox(cur.checklistState, patch.mailbox)");
  });
  it("小窓の鍵の行: 記録があればその行(本数は文字)、無ければ空の1行", () => {
    expect(keyFormRowsOf([{ label: "玄関", count: 2 }, { label: "", count: 1 }])).toEqual([{ label: "玄関", count: "2" }, { label: "", count: "1" }]);
    expect(keyFormRowsOf([])).toEqual([{ label: "", count: "" }]);
    expect(keyFormRowsOf(undefined)).toEqual([{ label: "", count: "" }]);
  });
  it("取引の物件タブに「鍵」の欄(集合ポストの下)・記録した行と合計を出す", () => {
    const html = renderToStaticMarkup(createElement(DealKeysPanel, {
      deal: { id: "d1", version: 3, keys: [{ label: "玄関 No.12", count: 2 }, { label: "", count: 1 }] } as never, onSaved: async () => {},
    }));
    expect(html).toContain("鍵の番号・種類と本数");
    expect(html).toContain('value="玄関 No.12"');
    expect(html).toContain("合計 3本");
    const page = readFileSync("src/app/(dashboard)/deals/[id]/page.tsx", "utf8");
    expect(page.indexOf("<DealKeysPanel")).toBeGreaterThan(page.indexOf("<DealMailboxPanel"));
  });
  it("鍵受領書の初めの値は、記録した鍵(registry の defaults)", () => {
    const src = readFileSync("src/lib/deals/documents/registry.ts", "utf8");
    expect(src).toContain("keys: c.deal.keys ?? []");
  });
});
