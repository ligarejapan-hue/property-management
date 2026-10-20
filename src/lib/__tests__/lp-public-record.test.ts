import { describe, it, expect, vi } from "vitest";
import { recordPublicInquiry } from "@/lib/sale-dm-letter/lp-public-record";

const INPUT = { name: "山田", phone: "090-1234-5678", email: null, contactPref: null, contactTime: null, message: "相談したい", propertyAddress: "世田谷区経堂1-2-3" };
const AD = { utmSource: "google", utmMedium: "cpc", utmCampaign: "aki", utmTerm: null, utmContent: null, gclid: "G1" };
const NOW = new Date("2026-10-20T01:00:00.000Z");

function makeClient(locked: { id: string; active: boolean; deleted_at: Date | null; public_slug: string | null } | null) {
  const calls: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async () => { calls.push("lock"); return locked ? [locked] : []; }),
    dmInquiry: { create: vi.fn(async () => { calls.push("create"); return { id: "inq1" }; }) },
  };
  const client = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  return { client, tx, calls };
}

describe("recordPublicInquiry(広告用の公開ページの申込を記録)", () => {
  it("DMの種類の行をロック→使う・削除なし・公開名が同じ、を読み直してから1行入れる(宛先なし・source=public)", async () => {
    const { client, tx, calls } = makeClient({ id: "s1", active: true, deleted_at: null, public_slug: "souzoku" });
    const r = await recordPublicInquiry(client as never, { id: "s1", slug: "souzoku" }, INPUT, AD, NOW);
    expect(r).toEqual({ kind: "recorded", inquiryId: "inq1" });
    expect(calls).toEqual(["lock", "create"]);
    expect(String((tx.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray])[0].join("?"))).toContain("FOR UPDATE");
    const { data, select } = (tx.dmInquiry.create.mock.calls[0] as unknown as [{ data: Record<string, unknown>; select: unknown }])[0];
    expect(select).toEqual({ id: true });
    expect(data).toEqual({
      source: "public", scenarioId: "s1", publicSlug: "souzoku", submittedAt: NOW,
      name: "山田", phone: "090-1234-5678", email: null, contactPref: null, contactTime: null, message: "相談したい",
      propertyAddress: "世田谷区経堂1-2-3",
      utmSource: "google", utmMedium: "cpc", utmCampaign: "aki", utmTerm: null, utmContent: null, gclid: "G1",
    });
    expect("draftId" in data).toBe(false);
  });
  it("ロック下で 削除済み/「使わない」/公開名が変わった/行が無い なら unavailable(何も入れない)=削除との競合を決着させる(@codex #535 R4)", async () => {
    for (const locked of [
      { id: "s1", active: true, deleted_at: new Date(), public_slug: "souzoku" },
      { id: "s1", active: false, deleted_at: null, public_slug: "souzoku" },
      { id: "s1", active: true, deleted_at: null, public_slug: "akiya" },
      { id: "s1", active: true, deleted_at: null, public_slug: null },
      null,
    ]) {
      const { client, tx } = makeClient(locked);
      expect(await recordPublicInquiry(client as never, { id: "s1", slug: "souzoku" }, INPUT, AD, NOW)).toEqual({ kind: "unavailable" });
      expect(tx.dmInquiry.create).not.toHaveBeenCalled();
    }
  });
});
