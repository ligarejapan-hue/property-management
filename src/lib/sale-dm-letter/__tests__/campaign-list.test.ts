import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listOwnCampaigns, recipientScopeWhere, CAMPAIGN_LIST_LIMIT, type CampaignListDb } from "../campaign-list";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

function fakeDb(
  campaigns: { id: string; name: string; status: "draft" | "ready" | "sent" | "closed"; createdAt: Date }[],
  counts: { campaignId: string; status: string; _count: { _all: number } }[],
) {
  const findMany = vi.fn(async () => campaigns);
  const groupBy = vi.fn(async () => counts);
  return { db: { dmCampaign: { findMany }, dmRecipientDraft: { groupBy } } as unknown as CampaignListDb, findMany, groupBy };
}

describe("売却DMの発送一覧(作った発送をあとで開き直す入口・2026-10-15)", () => {
  it("自分が作った発送だけを新しい順に、上限つきで読む", async () => {
    const { db, findMany } = fakeDb([], []);
    await listOwnCampaigns(db, { id: "u1", role: "office_staff" });
    expect(findMany).toHaveBeenCalledWith({
      where: { createdBy: "u1" },
      orderBy: { createdAt: "desc" },
      take: CAMPAIGN_LIST_LIMIT,
      select: { id: true, name: true, status: true, createdAt: true },
    });
  });

  it("発送が無ければ件数を数えに行かない", async () => {
    const { db, groupBy } = fakeDb([], []);
    expect(await listOwnCampaigns(db, { id: "u1", role: "admin" })).toEqual([]);
    expect(groupBy).not.toHaveBeenCalled();
  });

  it("宛先の数と送付済みの数を発送ごとに返す(宛先の中身は返さない)", async () => {
    const at = new Date("2026-10-01T00:00:00Z");
    const { db } = fakeDb(
      [
        { id: "c1", name: "10月 相続", status: "ready", createdAt: at },
        { id: "c2", name: "空き家", status: "draft", createdAt: at },
      ],
      [
        { campaignId: "c1", status: "draft", _count: { _all: 3 } },
        { campaignId: "c1", status: "sent", _count: { _all: 2 } },
      ],
    );
    const out = await listOwnCampaigns(db, { id: "u1", role: "office_staff" });
    expect(out).toEqual([
      { id: "c1", name: "10月 相続", status: "ready", createdAt: at.toISOString(), recipients: 5, sent: 2 },
      { id: "c2", name: "空き家", status: "draft", createdAt: at.toISOString(), recipients: 0, sent: 0 },
    ]);
  });

  it("⚠現地担当は今の担当範囲(作成 or 担当)の宛先だけを数える=個別の画面と同じ線", async () => {
    const { db, groupBy } = fakeDb([{ id: "c1", name: "x", status: "draft", createdAt: new Date() }], []);
    await listOwnCampaigns(db, { id: "f1", role: "field_staff" });
    expect(groupBy).toHaveBeenCalledWith({
      by: ["campaignId", "status"],
      where: { campaignId: { in: ["c1"] }, property: { OR: [{ createdBy: "f1" }, { assignedTo: "f1" }] } },
      _count: { _all: true },
    });
    expect(recipientScopeWhere({ id: "a", role: "admin" })).toBeNull();
    expect(recipientScopeWhere({ id: "o", role: "office_staff" })).toBeNull();
  });

  it("API の門は個別の画面と同じ(requireSaleDmAccess)・保存させない(no-store)", () => {
    const src = read("src/app/api/properties/sale-dm/campaigns/route.ts");
    const get = src.slice(src.indexOf("export async function GET()"), src.indexOf("export async function POST("));
    expect(get).toContain("await requireSaleDmAccess()");
    expect(get).toContain("listOwnCampaigns(");
    expect(get).toContain('"Cache-Control": "no-store"');
  });
});
