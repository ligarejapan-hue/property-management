import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- 物件1件ぶんの調査情報の行と監査ログを持つ、最小の偽 DB ----
type Row = {
  id: string;
  propertyId: string;
  status: string;
  fetchedAt: Date | null;
  updatedAt: Date;
  version: number;
  [k: string]: unknown;
};
const db: {
  row: Row | null;
  logs: Array<{ id: string; action: string; note?: string; beforeJson?: unknown; afterJson?: unknown }>;
} = {
  row: null,
  logs: [],
};
let seq = 0;

function applyData(row: Row, data: Record<string, unknown>) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && "increment" in (v as object)) {
      row[k] = (row[k] as number) + (v as { increment: number }).increment;
    } else if (v !== undefined) {
      row[k] = v;
    }
  }
  row.updatedAt = new Date();
}

const tx = {
  propertyInvestigation: {
    findUnique: vi.fn(async () => (db.row ? { ...db.row } : null)),
    upsert: vi.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
      if (!db.row) {
        db.row = {
          id: `inv${++seq}`,
          propertyId: "p1",
          status: "draft",
          fetchedAt: null,
          updatedAt: new Date(),
          version: 1,
          fetchVersion: 0,
          ...create,
        } as Row;
      } else {
        applyData(db.row, update);
      }
      return { id: db.row.id, version: db.row.version };
    }),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      applyData(db.row!, data);
      return { ...db.row };
    }),
    delete: vi.fn(async () => {
      db.row = null;
    }),
  },
  propertyInvestigationAuditLog: {
    create: vi.fn(
      async ({ data }: { data: { action: string; note?: string; beforeJson?: unknown; afterJson?: unknown } }) => {
      const log = {
        id: `log${++seq}`,
        action: data.action,
        note: data.note,
        beforeJson: data.beforeJson,
        afterJson: data.afterJson,
      };
      db.logs.push(log);
      return { id: log.id };
    }),
    deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => {
      db.logs = db.logs.filter((l) => l.id !== where.id);
    }),
  },
};

vi.mock("@/lib/prisma", () => ({
  default: { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) },
}));
vi.mock("@/lib/api-helpers", () => ({ ApiError: class extends Error {} }));
vi.mock("@/lib/property-record-guard", () => ({
  lockPropertyRow: vi.fn(async () => {}),
  lockPropertyRecordForWrite: vi.fn(async () => {}),
  propertyRecordScopeFilter: vi.fn(),
}));
const runInvestigation = vi.fn();
vi.mock("../index", () => ({ runInvestigation: (...a: unknown[]) => runInvestigation(...a) }));

import { runAutoInvestigation } from "../fetch-investigation";

const okResult = {
  status: "success",
  data: { zoningDistrict: "第一種住居地域" },
  providers: [{ name: "reinfolib", status: "success", source: "国土交通省 不動産情報ライブラリ", fields: ["zoningDistrict"], meta: {} }],
  fetchedAt: "2026-11-14T00:00:00Z",
};
const ctx = { address: "東京都千代田区霞が関1-1", lotNumber: null, gpsLat: null, gpsLng: null };
const stuckBefore = new Date(Date.now() - 15 * 60_000);
const opts = (isOutage = false) => ({ stuckBefore, auditNote: "自動取得", isOutage: () => isOutage });

beforeEach(() => {
  db.row = null;
  db.logs = [];
  runInvestigation.mockReset();
});

describe("runAutoInvestigation", () => {
  it("一度も取っていない物件を取り、要確認で保存して、自動取得の印を残す", async () => {
    runInvestigation.mockResolvedValue(okResult);
    expect(await runAutoInvestigation("p1", "u1", ctx, opts())).toBe("done");
    expect(db.row?.status).toBe("needs_review");
    expect(db.row?.zoningDistrict).toBe("第一種住居地域");
    expect(db.logs.map((l) => [l.action, l.note])).toEqual([
      ["fetch_requested", "自動取得"],
      ["fetch_succeeded", "自動取得"],
    ]);
  });

  it("選んだあとに手動の取得が入って行ができていたら、外部へ送らずに何もしない", async () => {
    db.row = { id: "inv0", propertyId: "p1", status: "fetching", fetchedAt: null, updatedAt: new Date(), version: 2 };
    expect(await runAutoInvestigation("p1", "u1", ctx, opts())).toBe("skipped");
    expect(runInvestigation).not.toHaveBeenCalled();
    expect(db.row.version).toBe(2);
    expect(db.logs).toEqual([]);
  });

  it("取得済み・確認済みの物件には触らない", async () => {
    for (const status of ["needs_review", "confirmed", "failed"]) {
      db.row = { id: "inv0", propertyId: "p1", status, fetchedAt: new Date(0), updatedAt: new Date(0), version: 3 };
      expect(await runAutoInvestigation("p1", "u1", ctx, opts())).toBe("skipped");
    }
    expect(runInvestigation).not.toHaveBeenCalled();
  });

  it("取得中のまま15分以上止まった行は取り直す", async () => {
    db.row = { id: "inv0", propertyId: "p1", status: "fetching", fetchedAt: null, updatedAt: new Date(0), version: 2 };
    runInvestigation.mockResolvedValue(okResult);
    expect(await runAutoInvestigation("p1", "u1", ctx, opts())).toBe("done");
    expect(db.row?.status).toBe("needs_review");
  });

  it("問い合わせ中に手動の取得・編集が入ったら(版が変わったら)、結果を捨てて人の結果を残す", async () => {
    runInvestigation.mockImplementation(async () => {
      applyData(db.row!, { status: "confirmed", version: { increment: 1 } });
      return okResult;
    });
    expect(await runAutoInvestigation("p1", "u1", ctx, opts())).toBe("superseded");
    expect(db.row?.status).toBe("confirmed");
    expect(db.row?.zoningDistrict).toBeUndefined();
  });

  it("相手が落ちていたら保存せず、作った行と開始の記録を消して、次の見回りでまた対象にする", async () => {
    runInvestigation.mockResolvedValue(okResult);
    expect(await runAutoInvestigation("p1", "u1", ctx, opts(true))).toBe("outage");
    expect(db.row).toBeNull();
    expect(db.logs).toEqual([]);
  });

  it("前から取得中で止まっていた行は、相手が落ちていても消さない", async () => {
    db.row = { id: "inv0", propertyId: "p1", status: "fetching", fetchedAt: null, updatedAt: new Date(0), version: 2 };
    runInvestigation.mockResolvedValue(okResult);
    expect(await runAutoInvestigation("p1", "u1", ctx, opts(true))).toBe("outage");
    expect(db.row?.status).toBe("fetching");
    expect(tx.propertyInvestigation.delete).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: "inv0" } }));
  });

  it("監査ログに住所の原文を残さない(@codex #723・住所は調査情報の sourceAddress にだけ)", async () => {
    runInvestigation.mockResolvedValue(okResult);
    await runAutoInvestigation("p1", "u1", ctx, opts());
    expect(db.logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(db.logs)).not.toContain(ctx.address);
    expect(db.row?.sourceAddress).toBe(ctx.address);
  });

  it("取得の処理が例外を出したら、失敗として記録する", async () => {
    runInvestigation.mockRejectedValue(new Error("boom"));
    expect(await runAutoInvestigation("p1", "u1", ctx, opts())).toBe("done");
    expect(db.row?.status).toBe("failed");
    expect(db.row?.lastFetchError).toBe("boom");
    expect(db.logs.map((l) => l.action)).toEqual(["fetch_requested", "fetch_failed"]);
  });
});
