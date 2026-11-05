import { describe, it, expect, vi, beforeEach } from "vitest";
const { syncDealScheduleSafe } = vi.hoisted(() => ({ syncDealScheduleSafe: vi.fn(async () => undefined) }));
vi.mock("@/lib/deals/schedule-sync", async (orig) => ({ ...(await orig<typeof import("../schedule-sync")>()), syncDealScheduleSafe }));
vi.mock("next/server", async () => (await import("./route-mocks")).nextServerMock());
vi.mock("@/lib/api-helpers", async () => (await import("./route-mocks")).apiHelpersMock());
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
const { recordChangesInTx } = vi.hoisted(() => ({ recordChangesInTx: vi.fn() }));
vi.mock("@/lib/change-log", async (orig) => ({ ...(await orig<typeof import("@/lib/change-log")>()), recordChangesInTx }));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    deal: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 1 })) },
    property: { findUnique: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 1 })) },
    changeLog: { create: vi.fn(async () => ({})) },
    dealDocFile: { updateMany: vi.fn(async () => ({ count: 0 })) },
    $queryRaw: vi.fn(async () => [{ id: "locked" }]),
    dealSettings: { findUnique: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => ({ isActive: true })) },
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

import prismaMock from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { jsonRequest as json, DEAL_ID, PROP_ID, USER_ID, DEAL_PERMS } from "./route-mocks";
import { DEFAULT_FUNDING_INPUTS } from "../funding-schema";
import { DEFAULT_BUSINESS_INPUTS } from "../business-schema";
import { GET, PATCH } from "../../../app/api/deals/[id]/route";
import { POST as REFRESH } from "../../../app/api/deals/[id]/refresh-property/route";

type Fn = ReturnType<typeof vi.fn>;
const pm = prismaMock as never as {
  deal: { findUnique: Fn; findMany: Fn; updateMany: Fn };
  property: { findUnique: Fn; updateMany: Fn };
  changeLog: { create: Fn };
  dealDocFile: { updateMany: Fn };
  $queryRaw: Fn;
  user: { findUnique: Fn };
};
const ctx = { params: Promise.resolve({ id: DEAL_ID }) };
const detailRow = {
  id: DEAL_ID, dealNo: "2026-0001", name: "試験の取引", businessType: "brokerage", tradeSide: "both", status: "considering",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: PROP_ID, propertyKind: "unit", hasOc: false,
  contractAt: null, contractPlace: null, settlementAt: null, settlementPlace: null, price: BigInt(30000000), buildingTax: null, deposit: null,
  taxRateBp: 1000, propertySnapshot: { roomNo: "201" }, counterpartyBroker: {}, version: 3,
  createdAt: new Date("2026-10-24T00:00:00Z"), updatedAt: new Date("2026-10-24T00:00:00Z"), parties: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Fn).mockResolvedValue({ id: "u-office", role: "office_staff" });
  (getUserPermissions as Fn).mockResolvedValue(DEAL_PERMS);
  pm.deal.findUnique.mockResolvedValue(detailRow);
  pm.deal.updateMany.mockResolvedValue({ count: 1 });
  pm.deal.findMany.mockResolvedValue([]);
  pm.user.findUnique.mockResolvedValue({ isActive: true });
});

describe("GET /api/deals/[id]", () => {
  it("金額は数・写しは空で補う・物件を開けるか", async () => {
    pm.property.findUnique.mockResolvedValue({ createdBy: "u-office", assignedTo: null });
    const body = await (await GET(new Request("http://x"), ctx)).json();
    expect(body.deal.price).toBe(30000000);
    expect(body.deal.propertySnapshot.roomNo).toBe("201");
    expect(body.deal.propertySnapshot.address).toBeNull();
    expect(body.canOpenProperty).toBe(true);
  });
  it("現地担当で担当外の物件なら、物件は開けない(取引は見られる)", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: "u-field", role: "field_staff" });
    pm.property.findUnique.mockResolvedValue({ createdBy: "other", assignedTo: null });
    const body = await (await GET(new Request("http://x"), ctx)).json();
    expect(body.canOpenProperty).toBe(false);
  });
  it("同じ物件のほかの取引を、仕入・売却と売買価格つきで返す(2026-11-05)", async () => {
    pm.property.findUnique.mockResolvedValue({ createdBy: "u-office", assignedTo: null });
    pm.deal.findMany.mockResolvedValueOnce([{
      id: "d-sale", dealNo: "2026-0031", businessType: "resale", status: "considering", price: BigInt(52_000_000),
      settlementAt: null, createdAt: new Date("2026-11-05T00:00:00Z"), parties: [{ role: "seller", isSelf: true }],
    }]);
    const body = await (await GET(new Request("http://x"), ctx)).json();
    expect(pm.deal.findMany.mock.calls[0][0].where).toEqual({ propertyId: PROP_ID, id: { not: DEAL_ID } });
    expect(body.relatedDeals).toEqual([expect.objectContaining({ id: "d-sale", dealNo: "2026-0031", side: "sale", price: 52_000_000 })]);
  });
  it("物件の無い取引は、ほかの取引を探さない", async () => {
    pm.deal.findUnique.mockResolvedValue({ ...detailRow, propertyId: null });
    const body = await (await GET(new Request("http://x"), ctx)).json();
    expect(body.relatedDeals).toEqual([]);
    expect(pm.deal.findMany).not.toHaveBeenCalled();
  });
  it("無ければ 404", async () => {
    pm.deal.findUnique.mockResolvedValue(null);
    expect((await GET(new Request("http://x"), ctx)).status).toBe(404);
  });
});

describe("PATCH /api/deals/[id]", () => {
  it("版の番号で書き、変更履歴と監査(項目名だけ)を残す", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: "u-admin", role: "admin" });
    const res = await PATCH(json("PATCH", { version: 3, status: "contracted", contractPlace: "試験区の事務所", assigneeId: USER_ID }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 4 });
    expect(pm.deal.updateMany).toHaveBeenCalledWith({
      where: { id: DEAL_ID, version: 3 },
      data: { status: "contracted", contractPlace: "試験区の事務所", assigneeId: USER_ID, version: { increment: 1 } },
    });
    expect(recordChangesInTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      targetTable: "deals", targetId: DEAL_ID, changedBy: "u-admin",
      oldValues: expect.objectContaining({ status: "considering" }), newValues: expect.objectContaining({ status: "contracted" }),
    }));
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "deal_update", targetId: DEAL_ID, detail: { fields: ["assigneeId", "contractPlace", "status"] },
    }));
  });
  describe("状態を変えられる人", () => {
    const row = (assigneeId: string | null) => ({ ...detailRow, propertyId: PROP_ID, status: "considering", assigneeId });
    it("担当でない事務担当は 403・取引も案件ステータスも変えない", async () => {
      pm.deal.findUnique.mockResolvedValue(row("someone"));
      pm.property.findUnique.mockResolvedValue({ assignedTo: "another", caseStatus: "contract_planned" });
      const res = await PATCH(json("PATCH", { version: 3, status: "contracted" }), ctx);
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("DEAL_STATUS_FORBIDDEN");
      expect(pm.deal.updateMany).not.toHaveBeenCalled();
      expect(pm.property.updateMany).not.toHaveBeenCalled();
    });
    it("担当でない現地担当も 403", async () => {
      (getApiSession as Fn).mockResolvedValue({ id: "u-field", role: "field_staff" });
      pm.deal.findUnique.mockResolvedValue(row(null));
      pm.property.findUnique.mockResolvedValue({ assignedTo: null, caseStatus: "contract_planned" });
      expect((await PATCH(json("PATCH", { version: 3, status: "cancelled" }), ctx)).status).toBe(403);
    });
    it("物件の担当者は変えられる", async () => {
      (getApiSession as Fn).mockResolvedValue({ id: "u-field", role: "field_staff" });
      pm.deal.findUnique.mockResolvedValue(row(null));
      pm.property.findUnique.mockResolvedValue({ assignedTo: "u-field", caseStatus: "contract_planned" });
      pm.deal.findMany.mockResolvedValue([{ id: DEAL_ID, status: "contracted" }]);
      expect((await PATCH(json("PATCH", { version: 3, status: "contracted" }), ctx)).status).toBe(200);
    });
    it("同じ保存で自分を担当者にしても、その保存では状態を変えられない", async () => {
      pm.deal.findUnique.mockResolvedValue(row("someone"));
      pm.property.findUnique.mockResolvedValue({ assignedTo: null, caseStatus: "contract_planned" });
      const res = await PATCH(json("PATCH", { version: 3, status: "contracted", assigneeId: USER_ID }), ctx);
      expect(res.status).toBe(403);
    });
    it("担当でない人は自分を担当者にできない(状態の制限をすり抜けられない)", async () => {
      pm.deal.findUnique.mockResolvedValue({ ...row(null), createdById: "someone" });
      pm.property.findUnique.mockResolvedValue({ assignedTo: null });
      const res = await PATCH(json("PATCH", { version: 3, assigneeId: USER_ID }), ctx);
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("DEAL_ASSIGNEE_FORBIDDEN");
      expect(pm.deal.updateMany).not.toHaveBeenCalled();
    });
    it("担当者が未設定の取引は、作成者が受け持てる", async () => {
      pm.deal.findUnique.mockResolvedValue({ ...row(null), createdById: "u-office" });
      pm.property.findUnique.mockResolvedValue({ assignedTo: null });
      expect((await PATCH(json("PATCH", { version: 3, assigneeId: USER_ID }), ctx)).status).toBe(200);
    });
    it("読んだ版と送られた版が違えば、権限を見る前に 409", async () => {
      pm.deal.findUnique.mockResolvedValue(row("u-office"));
      const res = await PATCH(json("PATCH", { version: 4, status: "contracted" }), ctx);
      expect(res.status).toBe(409);
      expect(pm.deal.updateMany).not.toHaveBeenCalled();
    });
    it("状態以外の項目は担当でなくても変えられる", async () => {
      pm.deal.findUnique.mockResolvedValue(row("someone"));
      const res = await PATCH(json("PATCH", { version: 3, status: "considering", contractPlace: "試験区の事務所" }), ctx);
      expect(res.status).toBe(200);
    });
    it("GET は変えられるかどうかを返す", async () => {
      pm.deal.findUnique.mockResolvedValue(row("someone"));
      pm.property.findUnique.mockResolvedValue({ createdBy: "x", assignedTo: "u-office" });
      expect((await (await GET(new Request("http://x/api"), ctx)).json()).canChangeStatus).toBe(true);
      pm.property.findUnique.mockResolvedValue({ createdBy: "x", assignedTo: "other" });
      expect((await (await GET(new Request("http://x/api"), ctx)).json()).canChangeStatus).toBe(false);
    });
  });
  describe("案件ステータスとの連動", () => {
    const linkedRow = () => ({ ...detailRow, propertyId: PROP_ID, status: "considering", assigneeId: "u-office" });
    const CAN_EDIT_PROPERTY = [...DEAL_PERMS, { resource: "property", action: "write", granted: true }];
    describe("物件の編集権限がない人", () => {
      it("取引の状態だけ変え、案件ステータスは動かさず、そのことを返す", async () => {
        pm.deal.findUnique.mockResolvedValue(linkedRow());
        pm.property.findUnique.mockResolvedValue({ createdBy: "x", assignedTo: null, caseStatus: "contract_planned" });
        pm.deal.findMany.mockResolvedValue([{ id: DEAL_ID, status: "contracted" }]);
        const res = await PATCH(json("PATCH", { version: 3, status: "contracted" }), ctx);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ version: 4, caseStatusNotChanged: true });
        expect(pm.deal.updateMany.mock.calls[0][0].data).toMatchObject({ status: "contracted" });
        expect(pm.property.updateMany).not.toHaveBeenCalled();
        expect(pm.changeLog.create).not.toHaveBeenCalled();
      });
      it("編集権限があっても担当範囲の外の物件(現地担当)なら動かさない", async () => {
        (getApiSession as Fn).mockResolvedValue({ id: "u-field", role: "field_staff" });
        (getUserPermissions as Fn).mockResolvedValue(CAN_EDIT_PROPERTY);
        pm.deal.findUnique.mockResolvedValue({ ...linkedRow(), assigneeId: "u-field" });
        pm.property.findUnique.mockResolvedValue({ createdBy: "x", assignedTo: "y", caseStatus: "contract_planned" });
        pm.deal.findMany.mockResolvedValue([{ id: DEAL_ID, status: "contracted" }]);
        const res = await PATCH(json("PATCH", { version: 3, status: "contracted" }), ctx);
        expect(await res.json()).toEqual({ version: 4, caseStatusNotChanged: true });
        expect(pm.property.updateMany).not.toHaveBeenCalled();
      });
      it("もともと動かない場面(除外など)では、ずれの知らせを出さない", async () => {
        pm.deal.findUnique.mockResolvedValue(linkedRow());
        pm.property.findUnique.mockResolvedValue({ createdBy: "x", assignedTo: null, caseStatus: "lead_excluded" });
        pm.deal.findMany.mockResolvedValue([{ id: DEAL_ID, status: "contracted" }]);
        expect(await (await PATCH(json("PATCH", { version: 3, status: "contracted" }), ctx)).json()).toEqual({ version: 4 });
      });
      it("GET は案件ステータスが動くかどうかも返す", async () => {
        pm.property.findUnique.mockResolvedValue({ createdBy: "u-office", assignedTo: null });
        expect((await (await GET(new Request("http://x"), ctx)).json()).canMoveCaseStatus).toBe(false);
        (getUserPermissions as Fn).mockResolvedValue(CAN_EDIT_PROPERTY);
        expect((await (await GET(new Request("http://x"), ctx)).json()).canMoveCaseStatus).toBe(true);
      });
    });
    it("状態を変えると、物件の行を先にロックして案件ステータスをそろえる", async () => {
      (getUserPermissions as Fn).mockResolvedValue(CAN_EDIT_PROPERTY);
      pm.deal.findUnique.mockResolvedValue(linkedRow());
      pm.property.findUnique.mockResolvedValue({ caseStatus: "contract_planned" });
      pm.deal.findMany.mockResolvedValue([{ id: DEAL_ID, status: "contracted" }]);
      const res = await PATCH(json("PATCH", { version: 3, status: "contracted" }), ctx);
      expect(res.status).toBe(200);
      expect(pm.property.updateMany).toHaveBeenCalledWith({
        where: { id: PROP_ID, caseStatus: "contract_planned" }, data: { caseStatus: "contracted" },
      });
      expect(pm.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(pm.deal.updateMany.mock.invocationCallOrder[0]);
      expect(pm.changeLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ targetTable: "properties", targetId: PROP_ID, source: "auto", newValue: "contracted" }),
      });
    });
    it("決済済に変えたときだけ、段取りに「決済済になった」と伝える", async () => {
      pm.deal.findUnique.mockResolvedValue({ ...detailRow, propertyId: null, status: "contracted", assigneeId: "u-office" });
      syncDealScheduleSafe.mockClear();
      await PATCH(json("PATCH", { version: 3, status: "settled" }), ctx);
      expect(syncDealScheduleSafe).toHaveBeenCalledWith(DEAL_ID, expect.objectContaining({ event: expect.objectContaining({ settled: true }) }));
      pm.deal.findUnique.mockResolvedValue({ ...detailRow, propertyId: null, status: "settled", assigneeId: "u-office" });
      syncDealScheduleSafe.mockClear();
      await PATCH(json("PATCH", { version: 3, contractPlace: "試験区の事務所" }), ctx);
      expect(syncDealScheduleSafe).toHaveBeenCalledWith(DEAL_ID, expect.objectContaining({ event: expect.objectContaining({ settled: false }) }));
    });
    it("状態を変えない保存では、ロックも案件ステータスの変更もしない", async () => {
      pm.deal.findUnique.mockResolvedValue(linkedRow());
      await PATCH(json("PATCH", { version: 3, status: "considering", contractPlace: "試験区の事務所" }), ctx);
      expect(pm.$queryRaw).not.toHaveBeenCalled();
      expect(pm.property.updateMany).not.toHaveBeenCalled();
    });
    it("物件とつながっていない取引では何もしない", async () => {
      pm.deal.findUnique.mockResolvedValue({ ...detailRow, propertyId: null, status: "considering", assigneeId: "u-office" });
      await PATCH(json("PATCH", { version: 3, status: "settled" }), ctx);
      expect(pm.$queryRaw).not.toHaveBeenCalled();
      expect(pm.property.updateMany).not.toHaveBeenCalled();
    });
    it("中止にしたら、未確認の提出ファイルに印を付ける", async () => {
      pm.deal.findUnique.mockResolvedValue({ ...detailRow, propertyId: null, status: "contracted", assigneeId: "u-office" });
      await PATCH(json("PATCH", { version: 3, status: "cancelled" }), ctx);
      expect(pm.dealDocFile.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reviewState: "deal_cancelled_unreviewed" }) }));
    });
    it("版の番号で断られたら案件ステータスも変えない", async () => {
      pm.deal.findUnique.mockResolvedValue(linkedRow());
      pm.deal.updateMany.mockResolvedValue({ count: 0 });
      const res = await PATCH(json("PATCH", { version: 2, status: "contracted" }), ctx);
      expect(res.status).toBe(409);
      expect(pm.property.updateMany).not.toHaveBeenCalled();
    });
  });
  it("ほかの人が先に保存していたら 409・上書きしない", async () => {
    pm.deal.updateMany.mockResolvedValue({ count: 0 });
    const res = await PATCH(json("PATCH", { version: 2, contractPlace: "古い画面からの保存" }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("VERSION_CONFLICT");
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
  it("無効な担当者・設定にない種別は 422", async () => {
    pm.user.findUnique.mockResolvedValue({ isActive: false });
    expect((await PATCH(json("PATCH", { version: 3, assigneeId: USER_ID }), ctx)).status).toBe(422);
    pm.user.findUnique.mockResolvedValue({ isActive: true });
    expect((await PATCH(json("PATCH", { version: 3, propertyKind: "castle" }), ctx)).status).toBe(422);
    expect(pm.deal.updateMany).not.toHaveBeenCalled();
  });
  it("すでに買取再販の取引に取引態様だけ送っても空のまま(M6)", async () => {
    pm.deal.findUnique.mockResolvedValue({ ...detailRow, businessType: "resale", tradeSide: null });
    await PATCH(json("PATCH", { version: 3, tradeSide: "seller" }), ctx);
    expect(pm.deal.updateMany.mock.calls[0][0].data).toMatchObject({ tradeSide: null });
  });
  it("金額は BigInt で書き、変更履歴に残す", async () => {
    await PATCH(json("PATCH", { version: 3, price: 31_000_000 }), ctx);
    expect(pm.deal.updateMany.mock.calls[0][0].data.price).toBe(BigInt(31_000_000));
    expect(recordChangesInTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      newValues: expect.objectContaining({ price: BigInt(31_000_000) }),
    }));
  });
  it("買取再販へ切り替えたら取引態様も空にする", async () => {
    await PATCH(json("PATCH", { version: 3, businessType: "resale" }), ctx);
    expect(pm.deal.updateMany.mock.calls[0][0].data).toMatchObject({ businessType: "resale", tradeSide: null });
  });
});

describe("PATCH /api/deals/[id] の資金計画表(plan_inputs.funding)", () => {
  const funding = { ...DEFAULT_FUNDING_INPUTS, mode: "sale" as const, customerName: "架空 太郎" };
  it("funding だけを差し替え、ほかの鍵(事業計画書)は残す・監査は項目名だけ", async () => {
    pm.deal.findUnique.mockResolvedValue({ ...detailRow, planInputs: { business: { keep: 1 }, funding: { mode: "purchase" } } });
    const res = await PATCH(json("PATCH", { version: 3, fundingPlan: funding }), ctx);
    expect(res.status).toBe(200);
    const data = pm.deal.updateMany.mock.calls[0][0].data;
    expect(data.planInputs).toEqual({ business: { keep: 1 }, funding });
    expect(data).not.toHaveProperty("fundingPlan");
    const audit = (writeAuditLog as Fn).mock.calls[0][0];
    expect(audit.detail).toEqual({ fields: ["fundingPlan"] });
    expect(JSON.stringify(audit)).not.toContain("架空 太郎");
  });
  it("保存していない取引(plan_inputs が空)でも書ける", async () => {
    pm.deal.findUnique.mockResolvedValue({ ...detailRow, planInputs: {} });
    await PATCH(json("PATCH", { version: 3, fundingPlan: funding }), ctx);
    expect(pm.deal.updateMany.mock.calls[0][0].data.planInputs).toEqual({ funding });
  });
  it("ほかの人が先に保存していたら 409", async () => {
    pm.deal.findUnique.mockResolvedValue({ ...detailRow, planInputs: {} });
    pm.deal.updateMany.mockResolvedValue({ count: 0 });
    expect((await PATCH(json("PATCH", { version: 2, fundingPlan: funding }), ctx)).status).toBe(409);
  });
  it("形の違う入力は 422", async () => {
    expect((await PATCH(json("PATCH", { version: 3, fundingPlan: { ...funding, mode: "lease" } }), ctx)).status).toBe(422);
    expect(pm.deal.updateMany).not.toHaveBeenCalled();
  });
  it("GET は資金計画表の入力を読んで返す(壊れていれば初期値)", async () => {
    pm.deal.findUnique.mockResolvedValue({ ...detailRow, planInputs: { funding: { customerName: "架空 花子" } } });
    const body = await (await GET(new Request("http://x"), ctx)).json();
    expect(body.deal.fundingPlan.customerName).toBe("架空 花子");
    expect(body.deal.fundingPlan.mode).toBe("purchase");
    expect(body.deal).not.toHaveProperty("planInputs");
  });
});

describe("PATCH /api/deals/[id] の事業計画書(plan_inputs.business)", () => {
  const business = { ...DEFAULT_BUSINESS_INPUTS, variant: "bank" as const, salePrice: 40_000_000, memo: "架空の社内メモ" };
  const resale = { ...detailRow, businessType: "resale", tradeSide: null };
  it("business だけを差し替え、資金計画表の鍵は残す・監査は項目名だけ", async () => {
    pm.deal.findUnique.mockResolvedValue({ ...resale, planInputs: { funding: { keep: 1 }, business: { variant: "internal" } } });
    const res = await PATCH(json("PATCH", { version: 3, businessPlan: business }), ctx);
    expect(res.status).toBe(200);
    const data = pm.deal.updateMany.mock.calls[0][0].data;
    expect(data.planInputs).toEqual({ funding: { keep: 1 }, business });
    expect(data).not.toHaveProperty("businessPlan");
    const audit = (writeAuditLog as Fn).mock.calls[0][0];
    expect(audit.detail).toEqual({ fields: ["businessPlan"] });
    expect(JSON.stringify(audit)).not.toContain("架空の社内メモ");
  });
  it("資金計画表と一緒に送れば両方を差し替える", async () => {
    pm.deal.findUnique.mockResolvedValue({ ...resale, planInputs: {} });
    await PATCH(json("PATCH", { version: 3, businessPlan: business, fundingPlan: DEFAULT_FUNDING_INPUTS }), ctx);
    expect(pm.deal.updateMany.mock.calls[0][0].data.planInputs).toEqual({ funding: DEFAULT_FUNDING_INPUTS, business });
  });
  it("最終レビュー: 同じ保存で事業区分を変えるときは、変えたあとの区分で決める", async () => {
    pm.deal.findUnique.mockResolvedValue({ ...resale, planInputs: {} });
    expect((await PATCH(json("PATCH", { version: 3, businessType: "brokerage", businessPlan: business }), ctx)).status).toBe(422);
    pm.deal.findUnique.mockResolvedValue({ ...detailRow, planInputs: {} });
    expect((await PATCH(json("PATCH", { version: 3, businessType: "resale", businessPlan: business }), ctx)).status).toBe(200);
  });
  it("仲介の取引には保存しない(422)", async () => {
    pm.deal.findUnique.mockResolvedValue({ ...detailRow, planInputs: {} });
    const res = await PATCH(json("PATCH", { version: 3, businessPlan: business }), ctx);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("NOT_RESALE");
    expect(pm.deal.updateMany).not.toHaveBeenCalled();
  });
  it("形の違う入力は 422・GET は入力を読んで返す(壊れていれば初期値)", async () => {
    expect((await PATCH(json("PATCH", { version: 3, businessPlan: { ...business, variant: "x" } }), ctx)).status).toBe(422);
    pm.deal.findUnique.mockResolvedValue({ ...resale, planInputs: { business: { salePrice: 5 } } });
    const body = await (await GET(new Request("http://x"), ctx)).json();
    expect(body.deal.businessPlan).toEqual({ ...DEFAULT_BUSINESS_INPUTS, salePrice: 5 });
    pm.deal.findUnique.mockResolvedValue({ ...resale, planInputs: { business: { variant: "x" } } });
    expect((await (await GET(new Request("http://x"), ctx)).json()).deal.businessPlan).toEqual(DEFAULT_BUSINESS_INPUTS);
  });
});

describe("POST /api/deals/[id]/refresh-property", () => {
  const propRow = {
    propertyType: "house", address: "東京都試験区2-2", lotNumber: null, buildingNumber: null, buildingName: null, roomNo: null,
    exclusiveArea: null, totalFloorArea: "98.5", landArea: "120", structureType: null, builtYear: null, builtMonth: null,
    access: null, layoutType: null, createdBy: "u-office", assignedTo: null,
  };
  it("物件の今の値で写しを上書きする", async () => {
    pm.deal.findUnique.mockResolvedValue({ propertyId: PROP_ID });
    pm.property.findUnique.mockResolvedValue(propRow);
    const res = await REFRESH(json("POST", { version: 3 }), ctx);
    expect(res.status).toBe(200);
    expect(pm.deal.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: DEAL_ID, version: 3 },
      data: { propertySnapshot: expect.objectContaining({ address: "東京都試験区2-2", floorArea: 98.5, landArea: 120 }) },
    });
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "deal_property_refresh" }));
  });
  it("★区分: 管理費・修繕積立金を精算へ入れる(ほかの精算の条件は残す)", async () => {
    pm.deal.findUnique.mockResolvedValue({ propertyId: PROP_ID, settlementTerms: { fixedAssetTax: 1000, managementFee: 1, repairReserve: 2 } });
    pm.property.findUnique.mockResolvedValue({ ...propRow, propertyType: "apartment_unit", managementFee: 12000, repairReserveFee: 8000 });
    expect((await REFRESH(json("POST", { version: 3 }), ctx)).status).toBe(200);
    expect(pm.deal.updateMany.mock.calls[0][0].data.settlementTerms).toMatchObject({ fixedAssetTax: 1000, managementFee: 12000, repairReserve: 8000 });
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ detail: { fields: ["propertySnapshot", "settlementTerms"] } }));
  });
  it("★物件が空の項目は、取引の額を消さない", async () => {
    pm.deal.findUnique.mockResolvedValue({ propertyId: PROP_ID, settlementTerms: { managementFee: 1, repairReserve: 2 } });
    pm.property.findUnique.mockResolvedValue({ ...propRow, propertyType: "apartment_unit", managementFee: 12000, repairReserveFee: null });
    await REFRESH(json("POST", { version: 3 }), ctx);
    expect(pm.deal.updateMany.mock.calls[0][0].data.settlementTerms).toMatchObject({ managementFee: 12000, repairReserve: 2 });
  });
  it("★区分でなければ精算に触らない", async () => {
    pm.deal.findUnique.mockResolvedValue({ propertyId: PROP_ID, settlementTerms: {} });
    pm.property.findUnique.mockResolvedValue({ ...propRow, managementFee: 12000, repairReserveFee: 8000 });
    await REFRESH(json("POST", { version: 3 }), ctx);
    expect(pm.deal.updateMany.mock.calls[0][0].data).not.toHaveProperty("settlementTerms");
  });
  it("手入力の物件の取引では 422", async () => {
    pm.deal.findUnique.mockResolvedValue({ propertyId: null });
    expect((await REFRESH(json("POST", { version: 3 }), ctx)).status).toBe(422);
  });
  it("見られない物件なら 404", async () => {
    (getApiSession as Fn).mockResolvedValue({ id: "u-field", role: "field_staff" });
    pm.deal.findUnique.mockResolvedValue({ propertyId: PROP_ID });
    pm.property.findUnique.mockResolvedValue({ ...propRow, createdBy: "other" });
    expect((await REFRESH(json("POST", { version: 3 }), ctx)).status).toBe(404);
  });
});
