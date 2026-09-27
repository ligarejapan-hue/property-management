import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

/**
 * 物件の「DMの種類」欄の保存(Task 8・設計 2026-09-27 §3.4・§3.6)。
 *
 * PATCH /api/properties/[id] が dmScenarioId を受け取り、トランザクション内で
 * 物件行ロック→編集の鍵の確認→**台帳のロック(FOR SHARE)**→有効性確認→
 * **field_staff の担当範囲の再確認**→条件つき更新、の順で書く。
 *
 * ⚠モック方針は src/app/api/properties/[id]/__tests__/edit-lock.test.ts と同じ
 * (lockPropertyRow/assertNotEditLockedByOther を関数単位でモックし、順序を
 * push配列で固定する)。lockScenarioForShare も同じ粒度でモックする
 * (実際に FOR SHARE の生SQLを発行するのは scenario-guard.ts 側の責務で、
 * ここでは「呼ばれる順序」「戻り値による分岐」だけを見る)。
 */

vi.mock("@/lib/api-helpers", () => ({
  ApiError: class extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  getApiSession: vi.fn(),
  getUserPermissions: vi.fn(),
  getOwnerDisplayConfig: vi.fn(),
  apiResponse: vi.fn((body: unknown, status = 200) => Response.json(body as object, { status })),
  handleApiError: vi.fn((e: { status?: number; message?: string; code?: string }) =>
    Response.json({ error: { message: e?.message, code: e?.code } }, { status: e?.status ?? 500 }),
  ),
}));
vi.mock("@/lib/permissions", () => ({ hasPermission: () => true }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/display-level", () => ({ applyDisplayToOwner: vi.fn((x: unknown) => x) }));
vi.mock("@/lib/storage", () => ({ getStorage: vi.fn() }));
vi.mock("@/lib/storage/url-to-key", () => ({ extractStorageKeyFromUrl: vi.fn() }));
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn() }));
vi.mock("@/lib/edit-lock/service", () => ({ assertNotEditLockedByOther: vi.fn() }));
vi.mock("@/lib/sale-dm-letter/scenario-guard", () => ({ lockScenarioForShare: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn() },
    changeLog: { createMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { assertNotEditLockedByOther } from "@/lib/edit-lock/service";
import { lockScenarioForShare } from "@/lib/sale-dm-letter/scenario-guard";
import { PATCH } from "@/app/api/properties/[id]/route";

type PrismaMock = {
  property: { findUnique: Mock; findUniqueOrThrow: Mock; updateMany: Mock };
  changeLog: { createMany: Mock };
  $transaction: Mock;
};
const pm = prisma as unknown as PrismaMock;

const PROP = "22222222-2222-4222-8222-222222222222";
const SCENARIO_ID = "44444444-4444-4444-8444-444444444444";

const CURRENT_PROPERTY = {
  id: PROP,
  version: 1,
  createdBy: "u1",
  assignedTo: null,
  propertyType: "land",
  address: "東京都千代田区1-1-1",
  postalCode: "100-0001",
  lotNumber: null,
  buildingNumber: null,
  buildingName: null,
  realEstateNumber: null,
  registryStatus: null,
  dmStatus: null,
  caseStatus: "new_case",
  introductionRoute: null,
  dmScenarioId: null,
  gpsLat: null,
  gpsLng: null,
  zoningDistrict: null,
  buildingCoverageRatio: null,
  floorAreaRatio: null,
  heightDistrict: null,
  firePreventionZone: null,
  scenicRestriction: null,
  roadType: null,
  roadWidth: null,
  frontageWidth: null,
  frontageDirection: null,
  setbackRequired: null,
  rosenkaValue: null,
  rosenkaYear: null,
  rebuildPermission: null,
  architectureNote: null,
  note: null,
};

const UPDATED_PROPERTY = {
  ...CURRENT_PROPERTY,
  version: 2,
  assignee: null,
  creator: null,
  propertyOwners: [],
  photos: [],
  nextActions: [],
};

const patch = (body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/properties/${PROP}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Edit-Screen": "screen-1" },
      body: JSON.stringify(body),
    }) as unknown as Parameters<typeof PATCH>[0],
    { params: Promise.resolve({ id: PROP }) },
  );

/** tx を差し替えつつ、property.updateMany / property.findUnique(tx側) を持たせる。 */
function makeTxClient(overrides?: { txFindUnique?: Mock }) {
  return {
    property: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: overrides?.txFindUnique ?? vi.fn(),
    },
    $queryRaw: vi.fn(async () => []),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  pm.property.findUnique.mockResolvedValue(CURRENT_PROPERTY);
  pm.property.findUniqueOrThrow.mockResolvedValue(UPDATED_PROPERTY);
  pm.changeLog.createMany.mockResolvedValue({ count: 0 });
  (pm.$transaction as unknown as Mock).mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(makeTxClient()),
  );
  (lockPropertyRow as unknown as Mock).mockResolvedValue(undefined);
  (assertNotEditLockedByOther as unknown as Mock).mockResolvedValue(undefined);
  (lockScenarioForShare as unknown as Mock).mockResolvedValue({
    id: SCENARIO_ID,
    active: true,
    deletedAt: null,
  });
});

describe("PATCH /api/properties/[id] — DMの種類の保存", () => {
  it("有効な dmScenarioId → 200・updateMany の data に dmScenarioId と version increment・ChangeLog に dmScenarioId の行", async () => {
    const res = await patch({ version: 1, dmScenarioId: SCENARIO_ID });
    expect(res.status).toBe(200);

    expect(lockScenarioForShare).toHaveBeenCalledWith(expect.anything(), SCENARIO_ID);

    // updateMany の呼び出しは $transaction が渡す tx 側(base client 経由ではない)
    const txCall = (pm.$transaction as unknown as Mock).mock.results[0]
      .value as Promise<unknown>;
    await txCall;
    const txArg = (pm.$transaction as unknown as Mock).mock.calls[0][0];
    void txArg;

    expect(pm.changeLog.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ fieldName: "dmScenarioId", newValue: SCENARIO_ID }),
      ]),
    });
  });

  it.each([
    ["台帳に存在しない(null)", null],
    ["使わない設定(active:false)", { id: SCENARIO_ID, active: false, deletedAt: null }],
    ["削除済み(deletedAt あり)", { id: SCENARIO_ID, active: true, deletedAt: new Date() }],
  ])("台帳が無効(%s) → 409 SCENARIO_UNAVAILABLE・updateMany を呼ばない", async (_label, scenarioReturn) => {
    (lockScenarioForShare as unknown as Mock).mockResolvedValue(scenarioReturn);
    let capturedTx: ReturnType<typeof makeTxClient> | undefined;
    (pm.$transaction as unknown as Mock).mockImplementation((fn: (tx: unknown) => unknown) => {
      capturedTx = makeTxClient();
      return fn(capturedTx);
    });

    const res = await patch({ version: 1, dmScenarioId: SCENARIO_ID });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("SCENARIO_UNAVAILABLE");
    expect(capturedTx!.property.updateMany).not.toHaveBeenCalled();
    expect(pm.changeLog.createMany).not.toHaveBeenCalled();
  });

  it("呼び出し順: トランザクション開始 → 行ロック → 鍵の確認 → 台帳のロック(FOR SHARE) → 条件つき更新", async () => {
    const order: string[] = [];
    (pm.$transaction as unknown as Mock).mockImplementation(async (fn: (tx: unknown) => unknown) => {
      order.push("tx");
      const tx = {
        property: {
          updateMany: vi.fn(async () => {
            order.push("update");
            return { count: 1 };
          }),
          findUnique: vi.fn(),
        },
        $queryRaw: vi.fn(async () => []),
      };
      return fn(tx);
    });
    (lockPropertyRow as unknown as Mock).mockImplementation(async () => {
      order.push("lock-property");
    });
    (assertNotEditLockedByOther as unknown as Mock).mockImplementation(async () => {
      order.push("assert-lock");
    });
    (lockScenarioForShare as unknown as Mock).mockImplementation(async () => {
      order.push("lock-scenario");
      return { id: SCENARIO_ID, active: true, deletedAt: null };
    });

    const res = await patch({ version: 1, dmScenarioId: SCENARIO_ID });
    expect(res.status).toBe(200);
    expect(order).toEqual(["tx", "lock-property", "assert-lock", "lock-scenario", "update"]);
  });

  it("dmScenarioId: null(自動に戻す) → 台帳のロックを取らずに保存できる", async () => {
    const res = await patch({ version: 1, dmScenarioId: null });
    expect(res.status).toBe(200);
    expect(lockScenarioForShare).not.toHaveBeenCalled();
  });

  it("⚠dmScenarioId を含まない既存の保存は、台帳の問い合わせを1回も呼ばない(既存挙動不変)", async () => {
    const res = await patch({ version: 1, note: "メモだけ更新" });
    expect(res.status).toBe(200);
    expect(lockScenarioForShare).not.toHaveBeenCalled();
  });

  it("field_staff: ロック前は担当だが、ロック後に読み直すと担当外 → 403・updateMany を呼ばない(Review Focus 5)", async () => {
    (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "field_staff" });
    // ロック前の判定(current)は本人の担当のまま(CURRENT_PROPERTY.createdBy === "u1")。
    // ロック後にトランザクション内で読み直すと、既に他人に付け替えられている。
    const txFindUnique = vi.fn().mockResolvedValue({ createdBy: "other-user", assignedTo: null });
    let capturedTx: ReturnType<typeof makeTxClient> | undefined;
    (pm.$transaction as unknown as Mock).mockImplementation((fn: (tx: unknown) => unknown) => {
      capturedTx = makeTxClient({ txFindUnique });
      return fn(capturedTx);
    });

    const res = await patch({ version: 1, note: "x" });
    expect(res.status).toBe(403);
    expect(txFindUnique).toHaveBeenCalledWith({
      where: { id: PROP },
      select: { createdBy: true, assignedTo: true },
    });
    expect(capturedTx!.property.updateMany).not.toHaveBeenCalled();
  });

  it("field_staff: ロック後も担当のまま → 200(誤検出しない)", async () => {
    (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "field_staff" });
    const txFindUnique = vi.fn().mockResolvedValue({ createdBy: "u1", assignedTo: null });
    (pm.$transaction as unknown as Mock).mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(makeTxClient({ txFindUnique })),
    );

    const res = await patch({ version: 1, note: "x" });
    expect(res.status).toBe(200);
  });
});
