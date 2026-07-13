import { describe, it, expect } from "vitest";
import { capRecipientsByProperty, type RecipientMeta } from "../recipients";
import type { LetterRecipient } from "../types";

// propertyId ごとに count 件の (recipient, meta) を連続して作る最小フィクスチャ
// (buildRecipientsFromProperties が物件ごとに連続して積む形を再現)。
function block(pid: string, count: number): { recipients: LetterRecipient[]; meta: RecipientMeta[] } {
  const recipients: LetterRecipient[] = [];
  const meta: RecipientMeta[] = [];
  for (let i = 0; i < count; i++) {
    recipients.push({ representativeName: `${pid}-${i}`, honorific: "様", coOwnerCount: 1, propertyAddress: "x", propertyTypeLabel: "土地", roomNo: null });
    meta.push({ propertyId: pid, representativeOwnerId: null, recipientName: `${pid}-${i}`, recipientZip: null, recipientAddress: "x", honorific: "様", coOwnerCount: 1 });
  }
  return { recipients, meta };
}
function concat(...blocks: { recipients: LetterRecipient[]; meta: RecipientMeta[] }[]) {
  return { recipients: blocks.flatMap((b) => b.recipients), meta: blocks.flatMap((b) => b.meta) };
}
const pids = (r: { meta: RecipientMeta[] }) => new Set(r.meta.map((m) => m.propertyId));

describe("capRecipientsByProperty", () => {
  it("max 以内はそのまま返す(truncated=false)", () => {
    const { recipients, meta } = concat(block("p1", 2), block("p2", 3));
    const r = capRecipientsByProperty(recipients, meta, 50);
    expect(r.truncated).toBe(false);
    expect(r.recipients).toHaveLength(5);
    expect(r.meta).toHaveLength(5);
  });

  it("上限を超える物件は1通も含めず、手前の物件境界で打ち切る(物件を分断しない)", () => {
    // p1=30, p2=30, max=50 → p1のみ(30通)。p2 を足すと 60>50 になるため p2 は丸ごと落とす。
    const { recipients, meta } = concat(block("p1", 30), block("p2", 30));
    const r = capRecipientsByProperty(recipients, meta, 50);
    expect(r.recipients).toHaveLength(30);
    expect(pids(r)).toEqual(new Set(["p1"]));
    expect(r.truncated).toBe(true);
  });

  it("入る物件は境界まで詰める", () => {
    // p1=20,p2=20,p3=20 max=50 → p1+p2(40)。p3 は 60>50 で落とす。
    const { recipients, meta } = concat(block("p1", 20), block("p2", 20), block("p3", 20));
    const r = capRecipientsByProperty(recipients, meta, 50);
    expect(r.recipients).toHaveLength(40);
    expect(pids(r)).toEqual(new Set(["p1", "p2"]));
    expect(r.truncated).toBe(true);
  });

  it("先頭の1物件だけで上限超なら、その物件は分断せず丸ごと出す(共有者数で有界)", () => {
    // p1=60 (>50) → p1 を丸ごと(60通)。単一物件は途中で切らない。後続 p2 は落とす。
    const { recipients, meta } = concat(block("p1", 60), block("p2", 5));
    const r = capRecipientsByProperty(recipients, meta, 50);
    expect(pids(r)).toEqual(new Set(["p1"]));
    expect(r.recipients).toHaveLength(60);
    expect(r.truncated).toBe(true);
  });

  it("単一物件が上限ちょうどなら全て出す(truncated=false)", () => {
    const { recipients, meta } = block("p1", 50);
    const r = capRecipientsByProperty(recipients, meta, 50);
    expect(r.recipients).toHaveLength(50);
    expect(r.truncated).toBe(false);
  });
});
