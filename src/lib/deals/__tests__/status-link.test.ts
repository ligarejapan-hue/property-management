import { describe, expect, it, vi } from "vitest";
import {
  canChangeDealAssignee,
  canChangeDealStatus,
  caseStatusForDealStatus,
  dealStatusForCaseStatus,
  initialDealStatusForCase,
  pickLinkedDeal,
  syncCaseStatusFromDeals,
  syncDealDocRetention,
  syncDealFromCaseStatus,
} from "../status-link";
import { CASE_STATUS_VALUES } from "@/lib/property-types";
import { DEAL_STATUSES, DEAL_STATUS_LABELS } from "../constants";

describe("取引の状態の名前", () => {
  it("検討中をやめて契約予定にする(保存する値は変えない)", () => {
    expect(DEAL_STATUS_LABELS.considering).toBe("契約予定");
    expect(Object.values(DEAL_STATUS_LABELS)).not.toContain("検討中");
  });
});

describe("取引の状態 → 案件ステータス", () => {
  it.each([
    ["considering", "on_sale", "contract_planned"],
    ["contracted", "contract_planned", "contracted"],
    ["settled", "contracted", "sold"],
    ["cancelled", "contracted", "hold"],
    ["considering", "sold", "contract_planned"],
  ])("%s / 今 %s → %s", (deal, current, next) => {
    expect(caseStatusForDealStatus(deal, current)).toBe(next);
  });

  it("同じなら動かさない", () => {
    expect(caseStatusForDealStatus("contracted", "contracted")).toBeNull();
    expect(caseStatusForDealStatus("cancelled", "hold")).toBeNull();
  });

  it("中止のとき、見送り・終了と他社で決まったは保留へ戻さない", () => {
    expect(caseStatusForDealStatus("cancelled", "closed")).toBeNull();
    expect(caseStatusForDealStatus("cancelled", "other_brokerage")).toBeNull();
  });

  it("除外申請中・除外は課金と結びつくので動かさない", () => {
    for (const d of DEAL_STATUSES) {
      expect(caseStatusForDealStatus(d, "lead_exclusion_requested")).toBeNull();
      expect(caseStatusForDealStatus(d, "lead_excluded")).toBeNull();
    }
  });

  it("やめた値は移し先と同じに扱う", () => {
    expect(caseStatusForDealStatus("contracted", "dm_sent")).toBe("contracted");
  });

  it("知らない状態では動かさない", () => {
    expect(caseStatusForDealStatus("nope", "on_sale")).toBeNull();
  });
});

describe("案件ステータス → 取引の状態", () => {
  it.each([
    ["contract_planned", "cancelled", "considering"],
    ["contracted", "considering", "contracted"],
    ["sold", "contracted", "settled"],
    ["hold", "considering", "cancelled"],
    ["closed", "contracted", "cancelled"],
    ["other_brokerage", "considering", "cancelled"],
  ])("%s / 今 %s → %s", (cs, current, next) => {
    expect(dealStatusForCaseStatus(cs, current)).toBe(next);
  });

  it("契約予定より前へ戻したら、契約済・決済済は契約予定に戻す", () => {
    expect(dealStatusForCaseStatus("on_sale", "contracted")).toBe("considering");
    expect(dealStatusForCaseStatus("negotiating", "settled")).toBe("considering");
  });

  it("契約予定より前へ戻しても、契約予定と中止はそのまま", () => {
    expect(dealStatusForCaseStatus("on_sale", "considering")).toBeNull();
    expect(dealStatusForCaseStatus("on_sale", "cancelled")).toBeNull();
  });

  it("除外申請中・除外では動かさない", () => {
    expect(dealStatusForCaseStatus("lead_exclusion_requested", "contracted")).toBeNull();
    expect(dealStatusForCaseStatus("lead_excluded", "considering")).toBeNull();
  });

  it("往復しても揺れない(取引→案件→取引で同じ状態に戻る)", () => {
    for (const d of DEAL_STATUSES) {
      for (const current of CASE_STATUS_VALUES) {
        const cs = caseStatusForDealStatus(d, current) ?? current;
        const back = dealStatusForCaseStatus(cs, d);
        if (cs === current && caseStatusForDealStatus(d, current) === null) continue;
        expect(back, `${d} / ${current}`).toBeNull();
      }
    }
  });
});

describe("取引の状態を変えられる人", () => {
  const office = { id: "u1", role: "office_staff" };
  it("管理者は変えられる", () => {
    expect(canChangeDealStatus({ id: "x", role: "admin" }, { assigneeId: null }, null)).toBe(true);
  });
  it("その取引の担当者は変えられる", () => {
    expect(canChangeDealStatus(office, { assigneeId: "u1" }, { assignedTo: "u2" })).toBe(true);
  });
  it("その物件の担当者は変えられる", () => {
    expect(canChangeDealStatus(office, { assigneeId: "u2" }, { assignedTo: "u1" })).toBe(true);
  });
  it("それ以外は事務担当でも変えられない", () => {
    expect(canChangeDealStatus(office, { assigneeId: "u2" }, { assignedTo: "u3" })).toBe(false);
    expect(canChangeDealStatus(office, { assigneeId: null }, { assignedTo: null })).toBe(false);
    expect(canChangeDealStatus(office, { assigneeId: null }, null)).toBe(false);
  });
});

describe("取引の担当者を変えられる人", () => {
  const me = { id: "u1", role: "office_staff" };
  it("状態を変えられる人は変えられる", () => {
    expect(canChangeDealAssignee({ id: "x", role: "admin" }, { assigneeId: "u9", createdById: "u9" }, null)).toBe(true);
    expect(canChangeDealAssignee(me, { assigneeId: "u1", createdById: "u9" }, null)).toBe(true);
    expect(canChangeDealAssignee(me, { assigneeId: "u9", createdById: "u9" }, { assignedTo: "u1" })).toBe(true);
  });
  it("担当者が未設定なら作成者は受け持てる", () => {
    expect(canChangeDealAssignee(me, { assigneeId: null, createdById: "u1" }, null)).toBe(true);
  });
  it("担当者が決まっていれば作成者でも変えられない", () => {
    expect(canChangeDealAssignee(me, { assigneeId: "u9", createdById: "u1" }, null)).toBe(false);
  });
  it("作成者でも担当者でもない人は変えられない(自分を担当者にして制限をすり抜けられない)", () => {
    expect(canChangeDealAssignee(me, { assigneeId: null, createdById: "u9" }, { assignedTo: null })).toBe(false);
  });
});

describe("新しい取引の最初の状態", () => {
  it("すでに契約完了・決済完了の物件はそれに合わせる", () => {
    expect(initialDealStatusForCase("contracted")).toBe("contracted");
    expect(initialDealStatusForCase("sold")).toBe("settled");
  });
  it("それ以外は契約予定", () => {
    for (const cs of ["on_sale", "contract_planned", "hold", "closed", "lead_excluded"]) {
      expect(initialDealStatusForCase(cs)).toBe("considering");
    }
  });
});

describe("連動させる取引の選び方", () => {
  it("新しい順の中で、中止でない最初の取引", () => {
    expect(pickLinkedDeal([
      { id: "new", status: "cancelled" }, { id: "mid", status: "considering" }, { id: "old", status: "contracted" },
    ])?.id).toBe("mid");
  });
  it("全部中止なら一番新しい取引", () => {
    expect(pickLinkedDeal([{ id: "new", status: "cancelled" }, { id: "old", status: "cancelled" }])?.id).toBe("new");
  });
  it("取引が無ければ null", () => {
    expect(pickLinkedDeal([])).toBeNull();
  });
});

function fakeTx(caseStatus: string, deals: { id: string; status: string }[]) {
  return {
    property: {
      findUnique: vi.fn(async () => ({ caseStatus })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    deal: {
      findMany: vi.fn(async () => deals),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    changeLog: { create: vi.fn(async () => ({})) },
    dealDocFile: { updateMany: vi.fn(async () => ({ count: 0 })) },
  };
}
const ARGS = { propertyId: "p1", changedBy: "u1" };

describe("syncDealDocRetention(未確認のまま中止を残す)", () => {
  const now = new Date("2026-11-02T00:00:00Z");
  it("中止になったら、未確認のファイルだけ印を付ける", async () => {
    const tx = fakeTx("hold", []);
    await syncDealDocRetention(tx as never, "d1", "contracted", "cancelled", now);
    expect(tx.dealDocFile.updateMany).toHaveBeenCalledWith({
      where: { reviewState: "unreviewed", request: { link: { dealId: "d1" } } },
      data: { reviewState: "deal_cancelled_unreviewed", reviewStateAt: now },
    });
  });
  it("中止から戻ったら、印を戻す", async () => {
    const tx = fakeTx("hold", []);
    await syncDealDocRetention(tx as never, "d1", "cancelled", "considering", now);
    expect(tx.dealDocFile.updateMany).toHaveBeenCalledWith({
      where: { reviewState: "deal_cancelled_unreviewed", request: { link: { dealId: "d1" } } },
      data: { reviewState: "unreviewed", reviewStateAt: now },
    });
  });
  it("中止をまたがない変更では何もしない", async () => {
    const tx = fakeTx("hold", []);
    await syncDealDocRetention(tx as never, "d1", "considering", "contracted", now);
    expect(tx.dealDocFile.updateMany).not.toHaveBeenCalled();
  });
  it("案件ステータスの連動で中止になっても印を付ける", async () => {
    const tx = fakeTx("hold", [{ id: "d1", status: "contracted" }]);
    await syncDealFromCaseStatus(tx as never, ARGS);
    expect(tx.dealDocFile.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reviewState: "deal_cancelled_unreviewed" }) }));
  });
});

describe("syncCaseStatusFromDeals", () => {
  it("案件を変え、物件の版は上げず、履歴に自動で残す", async () => {
    const tx = fakeTx("on_sale", [{ id: "d1", status: "contracted" }]);
    await syncCaseStatusFromDeals(tx as never, ARGS);
    expect(tx.property.updateMany).toHaveBeenCalledWith({
      where: { id: "p1", caseStatus: "on_sale" }, data: { caseStatus: "contracted" },
    });
    expect(tx.changeLog.create).toHaveBeenCalledWith({
      data: {
        targetTable: "properties", targetId: "p1", fieldName: "caseStatus",
        oldValue: "on_sale", newValue: "contracted", source: "auto", changedBy: "u1",
      },
    });
  });

  it("中止した取引の前に動いている取引があれば、そちらに合わせる", async () => {
    const tx = fakeTx("contract_planned", [{ id: "new", status: "cancelled" }, { id: "old", status: "contracted" }]);
    await syncCaseStatusFromDeals(tx as never, ARGS);
    expect(tx.property.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { caseStatus: "contracted" } }));
  });

  it("変わらなければ書かない", async () => {
    const tx = fakeTx("contracted", [{ id: "d1", status: "contracted" }]);
    await syncCaseStatusFromDeals(tx as never, ARGS);
    expect(tx.property.updateMany).not.toHaveBeenCalled();
    expect(tx.changeLog.create).not.toHaveBeenCalled();
  });

  it("書けなかった(間に変わった)ときは履歴を残さない", async () => {
    const tx = fakeTx("on_sale", [{ id: "d1", status: "contracted" }]);
    tx.property.updateMany.mockResolvedValueOnce({ count: 0 });
    await syncCaseStatusFromDeals(tx as never, ARGS);
    expect(tx.changeLog.create).not.toHaveBeenCalled();
  });
});

describe("syncDealFromCaseStatus", () => {
  it("取引の状態を変え、取引の版を上げ、履歴に自動で残す", async () => {
    const tx = fakeTx("hold", [{ id: "d1", status: "contracted" }]);
    expect(await syncDealFromCaseStatus(tx as never, ARGS)).toEqual({ dealId: "d1", status: "cancelled" });
    expect(tx.deal.updateMany).toHaveBeenCalledWith({
      where: { id: "d1", status: "contracted" }, data: { status: "cancelled", version: { increment: 1 } },
    });
    expect(tx.changeLog.create).toHaveBeenCalledWith({
      data: {
        targetTable: "deals", targetId: "d1", fieldName: "status",
        oldValue: "contracted", newValue: "cancelled", source: "auto", changedBy: "u1",
      },
    });
  });

  it("取引が無い物件では何もしない", async () => {
    const tx = fakeTx("hold", []);
    await syncDealFromCaseStatus(tx as never, ARGS);
    expect(tx.deal.updateMany).not.toHaveBeenCalled();
  });

  it("変わらなければ書かない", async () => {
    const tx = fakeTx("contracted", [{ id: "d1", status: "contracted" }]);
    await syncDealFromCaseStatus(tx as never, ARGS);
    expect(tx.deal.updateMany).not.toHaveBeenCalled();
  });
});
