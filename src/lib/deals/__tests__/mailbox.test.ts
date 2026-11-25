import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAILBOX, mailboxSchema, readMailbox, withMailbox } from "../mailbox";
import { dealUpdateSchema } from "../schemas";
import { DEAL_TRACKED_FIELDS, toDealUpdateData } from "../change-values";

const box = { status: "present", code: " 1234 ", method: "右に2回", checked: true };

describe("集合ポストの確認欄(2026-11-26 発注者)", () => {
  it("読み取り: 無い・壊れている → 未確認", () => {
    expect(readMailbox({})).toEqual(DEFAULT_MAILBOX);
    expect(readMailbox(null)).toEqual(DEFAULT_MAILBOX);
    expect(readMailbox({ mailbox: { status: "yes" } })).toEqual(DEFAULT_MAILBOX);
    expect(readMailbox({ mailbox: { ...box, code: "1234" } })).toEqual({ ...box, code: "1234" });
  });
  it("保存: 前後の空白を落とし、空は null。長すぎる番号は通さない", () => {
    expect(mailboxSchema.parse({ ...box, method: "  " })).toEqual({ status: "present", code: "1234", method: null, checked: true });
    expect(mailboxSchema.safeParse({ ...box, code: "1".repeat(31) }).success).toBe(false);
    expect(dealUpdateSchema.parse({ version: 1, mailbox: box }).mailbox?.code).toBe("1234");
  });
  it("checklist_state のほかの鍵は残して mailbox だけ差し替える", () => {
    const m = mailboxSchema.parse(box);
    expect(withMailbox({ other: 1, mailbox: DEFAULT_MAILBOX }, m)).toEqual({ other: 1, mailbox: m });
    expect(withMailbox([1], m)).toEqual({ mailbox: m });
  });
  it("解除番号は変更履歴に値を残さない(追う項目に入れない・PATCH の素通しにも入れない)", () => {
    expect(DEAL_TRACKED_FIELDS).not.toContain("mailbox");
    expect(DEAL_TRACKED_FIELDS).not.toContain("checklistState");
    expect(toDealUpdateData({ mailbox: mailboxSchema.parse(box) }, "brokerage")).toEqual({});
  });
  it("PATCH は checklist_state を mailbox の差し替えで書く(鍵の記録の差し替えとつなぐ)", () => {
    const src = readFileSync("src/app/api/deals/[id]/route.ts", "utf8");
    expect(src).toContain("if (patch.mailbox !== undefined) next = withMailbox(next, patch.mailbox)");
  });
});
