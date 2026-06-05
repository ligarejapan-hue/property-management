/**
 * F6(17-C): getOwnerDisplayConfig の権限二重解決の整理を検証する。
 *
 * 1) unit: 実物の getOwnerDisplayConfig に preloadedPermissions を渡すと
 *    getUserPermissions の DB クエリ（user / permissionTemplate / userPermission）
 *    が一切発行されないこと、導出結果が従来の DB 経路と完全一致すること。
 * 2) wiring: 同一リクエスト内で permissions 取得済みの全 route 呼び出し箇所が
 *    第2引数で取得済み permissions を渡していること（ソース表明）。
 *
 * 権限仕様（resolveLevel の優先順・owner_email→owner_phone fallback・
 * owner_corporate_number→owner_name fallback）は一切変更していない。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "fs";
import path from "path";

// api-helpers は @/lib/auth(NextAuth) を import するため mock で遮断する。
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  default: {
    user: { findUnique: vi.fn() },
    permissionTemplate: { findUnique: vi.fn() },
    userPermission: { findMany: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import {
  getOwnerDisplayConfig,
  type PermissionEntry,
} from "../api-helpers";

const pm = prisma as unknown as {
  user: { findUnique: ReturnType<typeof vi.fn> };
  permissionTemplate: { findUnique: ReturnType<typeof vi.fn> };
  userPermission: { findMany: ReturnType<typeof vi.fn> };
};

// mock モード（NEXT_PUBLIC_USE_MOCK=true）だと DB 経路自体を通らないため、
// 本テストでは明示的に無効化して実コードパスを検証する。
const ORIGINAL_USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK;
afterAll(() => {
  if (ORIGINAL_USE_MOCK === undefined) {
    delete process.env.NEXT_PUBLIC_USE_MOCK;
  } else {
    process.env.NEXT_PUBLIC_USE_MOCK = ORIGINAL_USE_MOCK;
  }
});

const PERMS: PermissionEntry[] = [
  { resource: "owner", action: "read", granted: true },
  { resource: "owner_name", action: "full", granted: true },
  { resource: "owner_name_kana", action: "masked", granted: true },
  { resource: "owner_phone", action: "partial", granted: true },
  { resource: "owner_zip", action: "hidden", granted: true },
  { resource: "owner_address", action: "read", granted: true },
  { resource: "owner_note", action: "edit", granted: true },
  // owner_email エントリなし → owner_phone("partial") に fallback する既存仕様
  // owner_corporate_number エントリなし → owner_name("full") に fallback する既存仕様
];

const EXPECTED = {
  name: "full",
  nameKana: "masked",
  phone: "partial",
  zip: "hidden",
  address: "read",
  note: "edit",
  email: "partial", // owner_phone fallback
  corporateNumber: "full", // owner_name fallback
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_USE_MOCK = "";
  // DB 経路用: template に PERMS と同一エントリを持たせる（override なし）
  pm.user.findUnique.mockResolvedValue({ role: "admin" });
  pm.permissionTemplate.findUnique.mockResolvedValue({
    templatePermissions: PERMS.map((p) => ({ ...p })),
  });
  pm.userPermission.findMany.mockResolvedValue([]);
});

describe("getOwnerDisplayConfig — preloadedPermissions（F6）", () => {
  it("preloadedPermissions ありなら権限 DB クエリを一切発行しない", async () => {
    const config = await getOwnerDisplayConfig("user-1", PERMS);
    expect(config).toEqual(EXPECTED);
    expect(pm.user.findUnique).not.toHaveBeenCalled();
    expect(pm.permissionTemplate.findUnique).not.toHaveBeenCalled();
    expect(pm.userPermission.findMany).not.toHaveBeenCalled();
  });

  it("preloadedPermissions なしは従来どおり DB 経路（後方互換）", async () => {
    const config = await getOwnerDisplayConfig("user-1");
    expect(config).toEqual(EXPECTED);
    expect(pm.user.findUnique).toHaveBeenCalledTimes(1);
    expect(pm.permissionTemplate.findUnique).toHaveBeenCalledTimes(1);
    expect(pm.userPermission.findMany).toHaveBeenCalledTimes(1);
  });

  it("同一 permissions なら DB 経路と preloaded 経路の導出結果が完全一致（parity）", async () => {
    const viaDb = await getOwnerDisplayConfig("user-1");
    const viaPreloaded = await getOwnerDisplayConfig("user-1", PERMS);
    expect(viaPreloaded).toEqual(viaDb);
  });

  it("granted=false のエントリは preloaded でも採用されない（権限仕様不変）", async () => {
    const config = await getOwnerDisplayConfig("user-1", [
      { resource: "owner_name", action: "full", granted: false },
      { resource: "owner_name", action: "masked", granted: true },
    ]);
    expect(config.name).toBe("masked");
  });

  it("空配列の preloaded は全フィールド hidden（fallback 含め安全側）", async () => {
    const config = await getOwnerDisplayConfig("user-1", []);
    expect(config).toEqual({
      name: "hidden",
      nameKana: "hidden",
      phone: "hidden",
      zip: "hidden",
      address: "hidden",
      note: "hidden",
      email: "hidden",
      corporateNumber: "hidden",
    });
    expect(pm.user.findUnique).not.toHaveBeenCalled();
  });
});

// ---------- wiring（ソース表明）----------
// 同一 handler 内で getUserPermissions 済みの全呼び出し箇所が
// 取得済み permissions を第2引数で渡していること。

const ROUTES: Array<{ file: string; count: number; arg: "permissions" | "perms" }> = [
  { file: "src/app/api/properties/route.ts", count: 1, arg: "permissions" },
  { file: "src/app/api/properties/[id]/route.ts", count: 2, arg: "permissions" },
  { file: "src/app/api/properties/export/route.ts", count: 1, arg: "permissions" },
  { file: "src/app/api/properties/dm-export/route.ts", count: 1, arg: "permissions" },
  { file: "src/app/api/properties/suggest/route.ts", count: 1, arg: "perms" },
  { file: "src/app/api/owners/route.ts", count: 1, arg: "permissions" },
  { file: "src/app/api/owners/[id]/route.ts", count: 2, arg: "perms" },
  { file: "src/app/api/owners/search/route.ts", count: 1, arg: "perms" },
  { file: "src/app/api/admin/owners/[id]/corporate-candidate/route.ts", count: 1, arg: "perms" },
  { file: "src/app/api/admin/owners/correction-candidates/route.ts", count: 1, arg: "perms" },
  {
    file: "src/app/api/admin/owners/correction/corporate-number-candidates/route.ts",
    count: 1,
    arg: "perms",
  },
];

describe("getOwnerDisplayConfig 呼び出し配線（F6・ソース表明）", () => {
  for (const { file, count, arg } of ROUTES) {
    it(`${file}: 全 ${count} 箇所が取得済み ${arg} を渡す`, () => {
      const src = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      const withArg = src.match(
        new RegExp(`getOwnerDisplayConfig\\(\\s*session\\.id,\\s*${arg}\\s*\\)`, "g"),
      );
      expect(withArg?.length ?? 0).toBe(count);
      // 第2引数なしの旧形が残っていない
      expect(src).not.toMatch(/getOwnerDisplayConfig\(\s*session\.id\s*\)/);
    });
  }
});
