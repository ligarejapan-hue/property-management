import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { caseDatesOfDeal, syncCaseDatesFromDeals } from "../case-dates-sync";
import { updatePropertySchema } from "@/lib/validators";

const d = (iso: string) => new Date(iso);

describe("物件の契約日・決済予定日=取引の日付(2026-11-26 発注者「入れるのは取引からのみ」)", () => {
  it("取引の日時(UTC で保存)を日本の日付にする・空は空", () => {
    // 日本時間 11/30 08:00 = UTC 11/29 23:00
    expect(caseDatesOfDeal({ contractAt: d("2026-11-29T23:00:00Z"), settlementAt: null })).toEqual({
      contractPlannedOn: "2026-11-30", settlementPlannedOn: null,
    });
    expect(caseDatesOfDeal({ contractAt: d("2026-12-01T05:00:00Z"), settlementAt: d("2027-01-15T01:00:00Z") })).toEqual({
      contractPlannedOn: "2026-12-01", settlementPlannedOn: "2027-01-15",
    });
  });

  type Deal = { id: string; status: string; contractAt: Date | null; settlementAt: Date | null };
  function fakeTx(deals: Deal[], property: { contractPlannedOn: Date | null; settlementPlannedOn: Date | null } | null) {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const createMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      deal: { findMany: vi.fn(async () => deals) },
      property: { findUnique: vi.fn(async () => property), updateMany },
      changeLog: { createMany },
    };
    return { tx: tx as never, updateMany, createMany, findMany: tx.deal.findMany };
  }

  it("連動する取引(新しい順で中止でない最初)の日付を写す・変わった欄だけ変更履歴(auto)に残す・物件の版は上げない", async () => {
    const { tx, updateMany, createMany, findMany } = fakeTx(
      [
        { id: "new-cancel", status: "cancelled", contractAt: d("2026-12-24T01:00:00Z"), settlementAt: null },
        { id: "live", status: "contracted", contractAt: d("2026-11-29T23:00:00Z"), settlementAt: d("2026-12-20T01:00:00Z") },
      ],
      { contractPlannedOn: d("2026-11-30T00:00:00Z"), settlementPlannedOn: d("2026-12-10T00:00:00Z") },
    );
    await syncCaseDatesFromDeals(tx, { propertyId: "p1", changedBy: "u1" });
    expect((findMany.mock.calls[0] as unknown as [{ orderBy: unknown }])[0].orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { contractPlannedOn: d("2026-11-30T00:00:00Z"), settlementPlannedOn: d("2026-12-20T00:00:00Z") },
    });
    const data = (updateMany.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).not.toHaveProperty("version");
    expect(createMany).toHaveBeenCalledWith({
      data: [{
        targetTable: "properties", targetId: "p1", fieldName: "settlementPlannedOn",
        oldValue: "2026-12-10", newValue: "2026-12-20", source: "auto", changedBy: "u1",
      }],
    });
  });

  it("取引の日付が空なら物件の日付も空にする(取引の日付で上書き・発注者決定)", async () => {
    const { tx, updateMany } = fakeTx(
      [{ id: "a", status: "considering", contractAt: null, settlementAt: null }],
      { contractPlannedOn: d("2026-11-30T00:00:00Z"), settlementPlannedOn: null },
    );
    await syncCaseDatesFromDeals(tx, { propertyId: "p1", changedBy: "u1" });
    expect(updateMany).toHaveBeenCalledWith({ where: { id: "p1" }, data: { contractPlannedOn: null, settlementPlannedOn: null } });
  });

  it("取引が無い物件・同じ日付なら何もしない(取引の無い物件の今の日付は残す)", async () => {
    const none = fakeTx([], { contractPlannedOn: d("2026-11-30T00:00:00Z"), settlementPlannedOn: null });
    await syncCaseDatesFromDeals(none.tx, { propertyId: "p1", changedBy: "u1" });
    expect(none.updateMany).not.toHaveBeenCalled();
    const same = fakeTx(
      [{ id: "a", status: "considering", contractAt: d("2026-11-29T23:00:00Z"), settlementAt: null }],
      { contractPlannedOn: d("2026-11-30T00:00:00Z"), settlementPlannedOn: null },
    );
    await syncCaseDatesFromDeals(same.tx, { propertyId: "p1", changedBy: "u1" });
    expect(same.updateMany).not.toHaveBeenCalled();
    expect(same.createMany).not.toHaveBeenCalled();
  });

  it("物件の保存では契約日・決済予定日を受け付けない(取引からだけ)", () => {
    const parsed = updatePropertySchema.safeParse({ contractPlannedOn: "2026-11-30", settlementPlannedOn: "2026-12-20" });
    expect(parsed.success && ("contractPlannedOn" in parsed.data || "settlementPlannedOn" in parsed.data)).toBe(false);
  });

  it("取引を作る・取引の日付/状態を保存する・案件ステータスから取引の状態を動かす、の3か所でそろえる", () => {
    expect(readFileSync("src/app/api/deals/route.ts", "utf8")).toContain("syncCaseDatesFromDeals(tx,");
    expect(readFileSync("src/app/api/deals/[id]/route.ts", "utf8")).toContain("syncCaseDatesFromDeals(tx,");
    expect(readFileSync("src/lib/deals/status-link.ts", "utf8")).toContain("syncCaseDatesFromDeals(tx,");
  });

  it("物件の画面の欄は入力欄を持たない(見せるだけ)", () => {
    const src = readFileSync("src/components/properties/case-dates-field.tsx", "utf8");
    expect(src).not.toContain('type="date"');
    expect(src).not.toContain("runNoLockPropertyPatch");
  });

  it("反映のとき一度だけ、取引のある物件の日付を取引にそろえる migration(足すだけ・日本の日付)", () => {
    const dir = readdirSync("prisma/migrations").find((n) => n.endsWith("_case_dates_from_deal"));
    expect(dir).toBeTruthy();
    const sql = readFileSync(`prisma/migrations/${dir}/migration.sql`, "utf8");
    expect(sql).toMatch(/UPDATE "properties"/);
    expect(sql).toContain("DISTINCT ON");
    expect(sql).toContain("interval '9 hours'");
    expect(sql).not.toMatch(/\b(DROP|ALTER|DELETE)\b/i);
  });
});
