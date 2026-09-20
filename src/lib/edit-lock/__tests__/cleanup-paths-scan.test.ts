import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 資源を消す/アーカイブする経路は、同じトランザクションで鍵も消す。 */
const PATHS = [
  "src/app/api/properties/[id]/route.ts",
  "src/app/api/admin/owners/[id]/correction/archive/route.ts",
  "src/app/api/admin/owners/correction/merge/route.ts",
  "src/app/api/import/jobs/[jobId]/rollback/route.ts",
];

describe("鍵の後始末", () => {
  for (const rel of PATHS) {
    it(`${rel} は deleteEditLocksFor を呼ぶ`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
      expect(src).toMatch(/deleteEditLocksFor\(/);
    });
  }
});

// ⚠走査(名前が出てくるか)だけでは順序の穴を防げない(@codex R11 P2)。
//   取り消し(rollback)の経路は、これまで物件行をロックせずに削除していたため、
//   後始末をただ同じ tx に足すだけでは「まだ commit されていない acquireEditLock」を
//   取りこぼし、鍵が孤児になる窓が残る。$transaction をモックして
//   ["tx","lockRows","deleteLocks","deleteProperty"] の順で呼ばれることを固定する。

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
  apiResponse: vi.fn((body: unknown, status = 200) => Response.json(body as object, { status })),
  handleApiError: vi.fn((e: { status?: number; message?: string; code?: string }) =>
    Response.json({ error: { message: e?.message, code: e?.code } }, { status: e?.status ?? 500 }),
  ),
}));
vi.mock("@/lib/permissions", () => ({ hasPermission: () => true }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/change-log", () => ({ recordChanges: vi.fn() }));
vi.mock("@/lib/edit-lock/service", () => ({ deleteEditLocksFor: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    importJob: { findUnique: vi.fn() },
    property: { findMany: vi.fn(), delete: vi.fn() },
    changeLog: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { deleteEditLocksFor } from "@/lib/edit-lock/service";
import prisma from "@/lib/prisma";
import { POST as rollbackPOST } from "@/app/api/import/jobs/[jobId]/rollback/route";

type PrismaMock = {
  importJob: { findUnique: Mock };
  property: { findMany: Mock; delete: Mock };
  changeLog: { findMany: Mock };
  $transaction: Mock;
};
const pm = prisma as unknown as PrismaMock;

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const PROP_ID = "22222222-2222-4222-8222-222222222222";
const COMPLETED_AT = new Date("2026-01-01T00:05:00Z");

const JOB = {
  id: JOB_ID,
  status: "completed" as const,
  jobType: "property_csv" as const,
  executedBy: "u1",
  startedAt: new Date("2026-01-01T00:00:00Z"),
  createdAt: new Date("2026-01-01T00:00:00Z"),
  completedAt: COMPLETED_AT,
  rows: [
    {
      id: "row-1",
      rowNumber: 1,
      status: "success" as const,
      errorMessage: null,
      createdId: PROP_ID,
    },
  ],
};

const rollbackRequest = (body: unknown) =>
  new Request("http://localhost/api/import/jobs/x/rollback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof rollbackPOST>[0];

describe("取り消しは 行ロック → 後始末 → 削除 の順", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getApiSession as unknown as Mock).mockResolvedValue({ id: "u1", role: "admin" });
    (getUserPermissions as unknown as Mock).mockResolvedValue([]);
    pm.importJob.findUnique.mockResolvedValue(JOB);
    pm.property.findMany.mockResolvedValue([
      {
        id: PROP_ID,
        updatedAt: COMPLETED_AT,
        _count: {
          photos: 0,
          attachments: 0,
          propertyOwners: 0,
          comments: 0,
          nextActions: 0,
          dmLogs: 0,
          investigationLogs: 0,
        },
      },
    ]);
    pm.changeLog.findMany.mockResolvedValue([]);
  });

  it("物件の行をロックしてから鍵を消し、最後に物件を消す", async () => {
    const order: string[] = [];
    let txClient: unknown;

    pm.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      order.push("tx");
      txClient = {
        importJob: {
          findUnique: vi.fn(async () => ({ status: "completed" })),
          update: vi.fn(async () => ({})),
        },
        property: {
          delete: vi.fn(async () => {
            order.push("deleteProperty");
            return {};
          }),
        },
        $queryRaw: vi.fn(async () => {
          order.push("lockRows");
          return [];
        }),
      };
      return fn(txClient);
    });
    (deleteEditLocksFor as unknown as Mock).mockImplementation(async () => {
      order.push("deleteLocks");
      return 1;
    });

    const res = await rollbackPOST(rollbackRequest({ dryRun: false }), {
      params: Promise.resolve({ jobId: JOB_ID }),
    });

    expect(res.status).toBe(200);
    expect(order).toEqual(["tx", "lockRows", "deleteLocks", "deleteProperty"]);
    // ⚠tx そのもの(identity)に対して呼ばれたこと・base client には漏れていないことを固定する。
    expect((deleteEditLocksFor as unknown as Mock).mock.calls[0][0]).toBe(txClient);
    expect(pm.property.delete).not.toHaveBeenCalled();
  });
});
