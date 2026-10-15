import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  listOwnCampaigns,
  recipientScopeWhere,
  parseCampaignCursor,
  formatCampaignCursor,
  CAMPAIGN_LIST_LIMIT,
  type CampaignListDb,
} from "../campaign-list";

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
  it("自分が作った発送だけを新しい順に、1件多めに読む(続きがあるかを知るため)", async () => {
    const { db, findMany } = fakeDb([], []);
    await listOwnCampaigns(db, { id: "u1", role: "office_staff" });
    expect(findMany).toHaveBeenCalledWith({
      where: { createdBy: "u1" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: CAMPAIGN_LIST_LIMIT + 1,
      select: { id: true, name: true, status: true, createdAt: true },
    });
  });

  it("発送が無ければ件数を数えに行かない", async () => {
    const { db, groupBy } = fakeDb([], []);
    expect(await listOwnCampaigns(db, { id: "u1", role: "admin" })).toEqual({ campaigns: [], nextBefore: null });
    expect(groupBy).not.toHaveBeenCalled();
  });

  it("100件を超えたら100件だけ返し、最後の行の位置を続きとして返す(@codex #517)", async () => {
    const base = Date.parse("2026-10-01T00:00:00Z");
    const rows = Array.from({ length: CAMPAIGN_LIST_LIMIT + 1 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(1000 - i).padStart(12, "0")}`,
      name: `c${i}`,
      status: "draft" as const,
      createdAt: new Date(base - i * 1000),
    }));
    const { db, groupBy } = fakeDb(rows, []);
    const out = await listOwnCampaigns(db, { id: "u1", role: "office_staff" });
    expect(out.campaigns).toHaveLength(CAMPAIGN_LIST_LIMIT);
    const last = rows[CAMPAIGN_LIST_LIMIT - 1];
    expect(out.nextBefore).toBe(`${last.createdAt.toISOString()}_${last.id}`);
    // 件数は返す100件の分だけ数える
    expect((groupBy.mock.calls[0] as unknown as [{ where: { campaignId: { in: string[] } } }])[0].where.campaignId.in).toHaveLength(CAMPAIGN_LIST_LIMIT);
    // ちょうど100件なら続きは無い
    const exact = fakeDb(rows.slice(0, CAMPAIGN_LIST_LIMIT), []);
    expect((await listOwnCampaigns(exact.db, { id: "u1", role: "office_staff" })).nextBefore).toBeNull();
  });

  it("続きは(作成日時, id)より古い行から・作成者本人の線は続きでも外さない", async () => {
    const { db, findMany } = fakeDb([], []);
    const before = parseCampaignCursor("2026-10-01T00:00:00.000Z_ABCDEF00-0000-4000-8000-00000000000A")!;
    expect(before).toEqual({ createdAt: new Date("2026-10-01T00:00:00.000Z"), id: "abcdef00-0000-4000-8000-00000000000a" });
    await listOwnCampaigns(db, { id: "u1", role: "office_staff" }, before);
    expect((findMany.mock.calls[0] as unknown as [{ where: unknown }])[0].where).toEqual({
      createdBy: "u1",
      OR: [
        { createdAt: { lt: before.createdAt } },
        { createdAt: before.createdAt, id: { lt: before.id } },
      ],
    });
  });

  it("続きの位置が壊れていたら先頭から(無視する)", () => {
    for (const bad of [null, "", "x", "2026-10-01_abc", "not-a-dateZ_00000000-0000-4000-8000-000000000000"]) {
      expect(parseCampaignCursor(bad)).toBeNull();
    }
    expect(formatCampaignCursor({ createdAt: "2026-10-01T00:00:00.000Z", id: "a" })).toBe("2026-10-01T00:00:00.000Z_a");
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
    expect(out).toEqual({
      campaigns: [
        { id: "c1", name: "10月 相続", status: "ready", createdAt: at.toISOString(), recipients: 5, sent: 2 },
        { id: "c2", name: "空き家", status: "draft", createdAt: at.toISOString(), recipients: 0, sent: 0 },
      ],
      nextBefore: null,
    });
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
    const get = src.slice(src.indexOf("export async function GET("), src.indexOf("export async function POST("));
    expect(get).toContain("await requireSaleDmAccess()");
    expect(get).toContain("listOwnCampaigns(");
    expect(get).toContain('parseCampaignCursor(request.nextUrl.searchParams.get("before"))');
    expect(get).toContain('"Cache-Control": "no-store"');
  });
});
