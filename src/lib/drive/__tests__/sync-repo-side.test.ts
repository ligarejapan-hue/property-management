/**
 * 写しを「仕入/販売」「購入/売却」のどちらへ入れるかを決める、物件の取引の状態(sync-repo の sideContext)。
 * 買取再販は仕入と販売が別の取引=当社の立場(買主=仕入)で見分ける(@codex #770)。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({ default: { deal: { findMany: vi.fn() } } }));
vi.mock("@/lib/storage", () => ({ getStorage: () => ({}) }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn() }));
vi.mock("@/lib/report-inbox/access", () => ({ reportInboxStorageKey: vi.fn(), SCRUB_ON_DISCARD: {} }));
vi.mock("@/lib/report-inbox/remove-file", () => ({ removeFileAndVerify: vi.fn() }));

import prisma from "@/lib/prisma";
import { createSyncRepo } from "../sync-repo";

const findMany = (prisma as unknown as { deal: { findMany: Mock } }).deal.findMany;
const self = (role: string) => [{ role, isSelf: true }, { role: role === "buyer" ? "seller" : "buyer", isSelf: false }];

beforeEach(() => findMany.mockReset());

describe("sideContext", () => {
  it("中止・決済完了でない取引だけを当事者つきで読む", async () => {
    findMany.mockResolvedValue([]);
    await createSyncRepo("u1").sideContext("p1");
    expect(findMany).toHaveBeenCalledWith({
      where: { propertyId: "p1", status: { notIn: ["settled", "cancelled"] } },
      select: { businessType: true, tradeSide: true, parties: { select: { role: true, isSelf: true } } },
    });
  });

  it("仕入の取引(当社が買主)が途中なら resaleOpen", async () => {
    findMany.mockResolvedValue([{ businessType: "resale", tradeSide: null, parties: self("buyer") }]);
    expect(await createSyncRepo("u1").sideContext("p1")).toEqual({ resaleOpen: true, brokerageBuyer: false });
  });

  it("★仕入が済んで販売の取引(当社が売主)だけが途中なら resaleOpen にしない", async () => {
    findMany.mockResolvedValue([{ businessType: "resale", tradeSide: null, parties: self("seller") }]);
    expect(await createSyncRepo("u1").sideContext("p1")).toEqual({ resaleOpen: false, brokerageBuyer: false });
  });

  it("仲介は全部が買主側のときだけ brokerageBuyer", async () => {
    findMany.mockResolvedValue([{ businessType: "brokerage", tradeSide: "buyer", parties: [] }]);
    expect((await createSyncRepo("u1").sideContext("p1")).brokerageBuyer).toBe(true);
    findMany.mockResolvedValue([
      { businessType: "brokerage", tradeSide: "buyer", parties: [] },
      { businessType: "brokerage", tradeSide: "seller", parties: [] },
    ]);
    expect((await createSyncRepo("u1").sideContext("p1")).brokerageBuyer).toBe(false);
  });
});
