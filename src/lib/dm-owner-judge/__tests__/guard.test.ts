import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/api-helpers", () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string, public code: string) {
      super(message);
    }
  },
}));

import { assertOwnersForDmSend, NO_OWNER_DM_SEND_MESSAGE } from "../guard";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("所有者が入っていない物件は手で「送付可」にできない(2026-11-14 発注者)", () => {
  it("所有者の無い物件が1件でもあれば 422 で断る", async () => {
    const db = { property: { count: vi.fn(async () => 1) } };
    await expect(assertOwnersForDmSend(db, ["p1", "p2"])).rejects.toMatchObject({
      status: 422,
      code: "NO_OWNER_DM_SEND",
      message: NO_OWNER_DM_SEND_MESSAGE,
    });
    expect(db.property.count).toHaveBeenCalledWith({ where: { id: { in: ["p1", "p2"] }, propertyOwners: { none: {} } } });
  });

  it("全部に所有者がいれば通す・空なら DB を引かない", async () => {
    const db = { property: { count: vi.fn(async () => 0) } };
    await expect(assertOwnersForDmSend(db, ["p1"])).resolves.toBeUndefined();
    await expect(assertOwnersForDmSend(db, [])).resolves.toBeUndefined();
    expect(db.property.count).toHaveBeenCalledTimes(1);
  });

  it("送付可にする入口3つ(ワンタッチ・まとめて変更・物件の編集)すべてで確かめる", () => {
    const actions = read("src/app/api/properties/[id]/actions/route.ts");
    expect(actions).toMatch(/action === "set_dm_send"[\s\S]{0,120}assertOwnersForDmSend\(prisma, \[propertyId\]\)/);
    const bulk = read("src/app/api/properties/bulk-update/route.ts");
    expect(bulk).toMatch(/updateFields\.dmStatus === "send"[\s\S]{0,160}assertOwnersForDmSend\(prisma, accessibleIds\)/);
    const patch = read("src/app/api/properties/[id]/route.ts");
    expect(patch).toMatch(/updateFields\.dmStatus === "send" && current\.dmStatus !== "send"[\s\S]{0,120}assertOwnersForDmSend\(prisma, \[id\]\)/);
  });
});

describe("人が DM判断を選んだら所有者待ちの印を下ろす(@codex #728 P2)", () => {
  it("ワンタッチの DM判断3つは印を下ろす", () => {
    const actions = read("src/app/api/properties/[id]/actions/route.ts");
    for (const v of ["send", "no_send", "hold"]) {
      expect(actions).toContain(`updatedFields: { dmStatus: "${v}", dmOwnerPending: false }`);
    }
  });
  it("まとめて変更で DM判断を変えたら印を下ろす", () => {
    const bulk = read("src/app/api/properties/bulk-update/route.ts");
    expect(bulk).toMatch(/\.\.\.\(updateFields\.dmStatus !== undefined \? \{ dmOwnerPending: false \} : \{\}\)/);
  });
  it("物件の編集で DM判断を変えたら印を下ろす(変えていなければそのまま)", () => {
    const patch = read("src/app/api/properties/[id]/route.ts");
    expect(patch).toMatch(
      /\.\.\.\(persistedFields\.dmStatus !== undefined && persistedFields\.dmStatus !== current\.dmStatus\s*\?\s*\{ dmOwnerPending: false \}\s*:\s*\{\}\)/,
    );
  });
});

describe("新しく作った物件は所有者待ちの印ありで始まる(@codex #728 P1)", () => {
  it("列の既定は true。ただし今ある行は false で足してから既定を変える", () => {
    const sql = read("prisma/migrations/20261114000000_property_dm_owner_pending/migration.sql");
    const add = sql.indexOf('ADD COLUMN "dm_owner_pending" BOOLEAN NOT NULL DEFAULT false');
    const setDefault = sql.indexOf('ALTER COLUMN "dm_owner_pending" SET DEFAULT true');
    expect(add).toBeGreaterThan(-1);
    expect(setDefault).toBeGreaterThan(add);
    expect(read("prisma/schema.prisma")).toMatch(/dmOwnerPending\s+Boolean\s+@default\(true\)/);
  });
});

describe("謄本の名義の確認で DM を選んだら所有者待ちの印を下ろす(@codex #728 R2 P2)", () => {
  const svc = read("src/lib/registry-owner-check/service.ts");
  it("印を下ろす関数がある(DM判断は変えない・印だけ)", () => {
    expect(svc).toMatch(
      /export async function settleDmOwnerPending\(tx: Tx, propertyId: string\)[\s\S]{0,200}data: \{ dmOwnerPending: false \}/,
    );
  });
  it("「このままでよい」は送付可に戻すかどうかにかかわらず印を下ろす", () => {
    expect(svc).toMatch(/decision: "keep"[\s\S]{0,300}await settleDmOwnerPending\(tx, propertyId\);/);
  });
  it("「謄本の名義に直す」も送付可に戻すかどうかにかかわらず印を下ろす", () => {
    const replace = read("src/app/api/registry-owner-checks/[propertyId]/replace/route.ts");
    expect(replace).toMatch(/if \(body\.restoreDm\) dmRestored = [^\n]+\n\s*await settleDmOwnerPending\(tx, propertyId\);/);
  });
});
