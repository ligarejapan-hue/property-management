/**
 * 補正・品質チェックが現住所を扱えること、かつ**ペアを壊さない**ことを固定する。
 *
 * 設計: docs/superpowers/specs/2026-08-10-owner-current-address-design.md §6.1 / §6.2 / §7
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/server", () => ({ NextRequest: class {} }));

const PERMS: Array<{ resource: string; action: string; granted: boolean }> = [];

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(async () => ({ id: "user-1", role: "admin" })),
    getUserPermissions: vi.fn(async () => PERMS),
    getOwnerDisplayConfig: vi.fn(async () => ({
      name: "full",
      nameKana: "full",
      phone: "full",
      zip: "full",
      address: "full",
      note: "full",
      email: "full",
      corporateNumber: "full",
    })),
    handleApiError: vi.fn((error: unknown) => {
      const e = error as { status?: number; message?: string; code?: string };
      return Response.json(
        { error: { message: e?.message ?? "", code: e?.code ?? "INTERNAL" } },
        { status: e?.status ?? 500 },
      );
    }),
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data, { status }),
    ),
  };
});

// 権限は「全部持っている」を既定にし、テストごとに欠けさせる。
const missingWrite = new Set<string>();
vi.mock("@/lib/permissions", () => ({
  hasPermission: () => true,
  hasExplicitWritePerm: (_p: unknown, resource: string) =>
    !missingWrite.has(resource),
  getOwnerFieldLevel: () => "full",
  maskValue: (v: unknown) => v ?? null,
}));

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

vi.mock("@/lib/prisma", () => {
  const tx = {
    owner: { updateMany: vi.fn(), findUnique: vi.fn() },
    changeLog: { createMany: vi.fn() },
  };
  return {
    default: {
      owner: { findUnique: vi.fn() },
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
      _tx: tx,
    },
  };
});

import prisma from "@/lib/prisma";
import { POST as textFixPOST } from "../../app/api/admin/owners/[id]/correction/text-fix/route";

const pm = prisma as unknown as {
  owner: { findUnique: Mock };
  _tx: {
    owner: { updateMany: Mock; findUnique: Mock };
    changeLog: { createMany: Mock };
  };
};

const OWNER_ID = "owner-1";

function call(body: Record<string, unknown>) {
  return textFixPOST(
    { json: async () => body } as never,
    { params: Promise.resolve({ id: OWNER_ID }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  missingWrite.clear();
  pm._tx.owner.updateMany.mockResolvedValue({ count: 1 });
  pm._tx.changeLog.createMany.mockResolvedValue({ count: 0 });
});

function setOwner(over: Record<string, unknown> = {}) {
  pm.owner.findUnique.mockResolvedValue({
    id: OWNER_ID,
    name: "山田太郎",
    nameKana: null,
    address: "横浜市南区井土ケ谷中町69-2",
    currentAddress: "渋谷区神宮前1-1-1",
    currentZip: "150-0001",
    version: 1,
    isArchived: false,
    ...over,
  });
}

describe("文字化けの補正 — 現住所も直せる", () => {
  it("現住所を直せる（欄として受け付ける）", async () => {
    setOwner();
    const res = await call({
      version: 1,
      field: "currentAddress",
      mode: "set",
      newValue: "渋谷区神宮前2-2-2",
      dryRun: false,
    });
    expect(res.status).toBe(200);
    const data = pm._tx.owner.updateMany.mock.calls[0][0].data;
    expect(data.currentAddress).toBe("渋谷区神宮前2-2-2");
  });

  it("⚠宛先が変われば郵便番号を消す（古い番号を新しい住所に付けない）", async () => {
    setOwner();
    await call({
      version: 1,
      field: "currentAddress",
      mode: "set",
      newValue: "渋谷区神宮前2-2-2",
      dryRun: false,
    });
    const data = pm._tx.owner.updateMany.mock.calls[0][0].data;
    expect(data.currentZip).toBeNull();
    const logged = pm._tx.changeLog.createMany.mock.calls[0][0].data;
    expect(logged.map((r: { fieldName: string }) => r.fieldName)).toContain(
      "currentZip",
    );
  });

  it("見た目を整えただけ（宛先は同じ）なら郵便番号は据え置く", async () => {
    setOwner({ currentAddress: "渋谷区神宮前1-1-1 " });
    await call({
      version: 1,
      field: "currentAddress",
      mode: "set",
      newValue: "渋谷区神宮前1-1-1",
      dryRun: false,
    });
    const data = pm._tx.owner.updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("currentZip");
  });

  it("⚠郵便番号を消すことになるのに、郵便番号の権限が無ければ拒否する", async () => {
    setOwner();
    missingWrite.add("owner_zip");
    const res = await call({
      version: 1,
      field: "currentAddress",
      mode: "set",
      newValue: "渋谷区神宮前2-2-2",
      dryRun: false,
    });
    expect(res.status).toBe(403);
    expect(pm._tx.owner.updateMany).not.toHaveBeenCalled();
  });

  it("登記上の住所を直しても現住所の郵便番号は触らない", async () => {
    setOwner();
    await call({
      version: 1,
      field: "address",
      mode: "set",
      newValue: "横浜市南区井土ケ谷中町70-1",
      dryRun: false,
    });
    const data = pm._tx.owner.updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("currentZip");
  });
});

describe("法人番号の反映 — 住所と郵便番号は一組でしか動かない", () => {
  const panel = readFileSync(
    join(process.cwd(), "src/components/owners/corporate-lookup-panel.tsx"),
    "utf8",
  );

  it("郵便番号だけを選べない（住所も自動で選ばれる）", () => {
    expect(panel).toContain('if (key === "zip" && next.zip) next.address = true;');
  });

  it("住所の選択を外すと郵便番号も外れる", () => {
    expect(panel).toContain(
      'if (key === "address" && !next.address) next.zip = false;',
    );
  });

  it("⚠所在地の反映先ラベルが「現住所」ではない（登記上へ入るため）", () => {
    expect(panel).not.toContain('label="所在地 → 現住所"');
    expect(panel).toContain('label="所在地 → 登記上住所"');
  });
});

describe("管理画面の所有者詳細 — ラベルが実体と合っている", () => {
  const page = readFileSync(
    join(process.cwd(), "src/app/(dashboard)/admin/owners/[id]/page.tsx"),
    "utf8",
  );

  it("登記上の住所を「現住所」と呼ばない", () => {
    expect(page).toContain('label="登記上住所" value={owner.ownerAddressMasked}');
  });

  it("現住所も表示する（未設定なら送り先が分かる文言）", () => {
    expect(page).toContain("owner.ownerCurrentAddressMasked");
    expect(page).toContain("未設定＝登記上へ送る");
  });

});
