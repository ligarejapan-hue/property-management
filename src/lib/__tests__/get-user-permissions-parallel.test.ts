/**
 * F5(17-C): getUserPermissions の template/overrides 並列取得を検証する。
 *
 * 対象: src/lib/api-helpers.ts getUserPermissions
 * - permissionTemplate.findUnique は templateName(user.role 由来)のみ、
 *   userPermission.findMany は userId(引数)のみに依存し互いに独立のため、
 *   Promise.all で並列取得する（3直列往復→2往復）。
 *
 * 本テストが固定する仕様（すべて従来挙動の保存）:
 * 1) 並列性: template クエリが未解決でも overrides クエリは既に発行されている
 *    （直列実装では fail する＝並列化の退行ロック）
 * 2) user 不在時は 401 ApiError を投げ、template/overrides クエリを発行しない
 * 3) クエリ本数は 3 本・各 1 回のまま（user / permissionTemplate / userPermission）
 * 4) マージ仕様不変: template→overrides の順で override が優先
 * 5) 未知 role は従来どおり「現地担当用」テンプレートに fallback
 * 6) mock モード（NEXT_PUBLIC_USE_MOCK=true）は早期 return で DB 非接触
 *
 * 権限仕様（テンプレート/override のマージ・granted 判定・PII 表示制御）は
 * 一切変更していない。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

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
import { getUserPermissions, ApiError } from "../api-helpers";

const pm = prisma as unknown as {
  user: { findUnique: ReturnType<typeof vi.fn> };
  permissionTemplate: { findUnique: ReturnType<typeof vi.fn> };
  userPermission: { findMany: ReturnType<typeof vi.fn> };
};

// mock モード（NEXT_PUBLIC_USE_MOCK=true）だと DB 経路自体を通らないため、
// 各テストで明示的に無効化して実コードパスを検証する。
const ORIGINAL_USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK;
afterAll(() => {
  if (ORIGINAL_USE_MOCK === undefined) {
    delete process.env.NEXT_PUBLIC_USE_MOCK;
  } else {
    process.env.NEXT_PUBLIC_USE_MOCK = ORIGINAL_USE_MOCK;
  }
});

const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_USE_MOCK = "";
  pm.user.findUnique.mockResolvedValue({ role: "admin" });
  pm.permissionTemplate.findUnique.mockResolvedValue({
    templatePermissions: [
      { resource: "property", action: "read", granted: true },
      { resource: "owner", action: "read", granted: true },
    ],
  });
  pm.userPermission.findMany.mockResolvedValue([]);
});

describe("getUserPermissions — template/overrides 並列取得（F5）", () => {
  it("template クエリが未解決でも overrides クエリは既に発行されている（並列性ロック）", async () => {
    // template クエリを手動制御の pending promise にし、解決前に
    // userPermission.findMany が発行済みであることを確認する。
    // 直列実装（template await 後に overrides）ではこの時点で未発行のため fail する。
    let resolveTemplate!: (v: unknown) => void;
    pm.permissionTemplate.findUnique.mockReturnValue(
      new Promise((resolve) => {
        resolveTemplate = resolve;
      }),
    );

    const pending = getUserPermissions("user-1");
    await flushMicrotasks();

    expect(pm.permissionTemplate.findUnique).toHaveBeenCalledTimes(1);
    expect(pm.userPermission.findMany).toHaveBeenCalledTimes(1);

    resolveTemplate({ templatePermissions: [] });
    await expect(pending).resolves.toEqual([]);
  });

  it("user 不在時は 401 を投げ、template/overrides クエリを発行しない（従来挙動維持）", async () => {
    pm.user.findUnique.mockResolvedValue(null);

    await expect(getUserPermissions("missing-user")).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    });
    await expect(getUserPermissions("missing-user")).rejects.toBeInstanceOf(ApiError);

    expect(pm.permissionTemplate.findUnique).not.toHaveBeenCalled();
    expect(pm.userPermission.findMany).not.toHaveBeenCalled();
  });

  it("クエリ本数は 3 本・各 1 回のまま（user/permissionTemplate/userPermission）", async () => {
    await getUserPermissions("user-1");

    expect(pm.user.findUnique).toHaveBeenCalledTimes(1);
    expect(pm.permissionTemplate.findUnique).toHaveBeenCalledTimes(1);
    expect(pm.userPermission.findMany).toHaveBeenCalledTimes(1);
  });

  it("マージ仕様不変: template→overrides の順で override が優先される", async () => {
    pm.permissionTemplate.findUnique.mockResolvedValue({
      templatePermissions: [
        { resource: "property", action: "read", granted: true },
        { resource: "owner", action: "read", granted: true },
      ],
    });
    pm.userPermission.findMany.mockResolvedValue([
      // template の owner:read(granted=true) を override で打ち消す
      { resource: "owner", action: "read", granted: false },
      // template に無いエントリの追加
      { resource: "csv_export", action: "read", granted: true },
    ]);

    const result = await getUserPermissions("user-1");

    expect(result).toEqual([
      { resource: "property", action: "read", granted: true },
      { resource: "owner", action: "read", granted: false }, // override 優先
      { resource: "csv_export", action: "read", granted: true },
    ]);
  });

  it("未知 role は従来どおり「現地担当用」テンプレートに fallback する", async () => {
    pm.user.findUnique.mockResolvedValue({ role: "unknown_role" });

    await getUserPermissions("user-1");

    expect(pm.permissionTemplate.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { name: "現地担当用" } }),
    );
  });

  it("template 不在（findUnique が null）でも overrides のみで導出される（従来挙動維持）", async () => {
    pm.permissionTemplate.findUnique.mockResolvedValue(null);
    pm.userPermission.findMany.mockResolvedValue([
      { resource: "property", action: "read", granted: true },
    ]);

    const result = await getUserPermissions("user-1");

    expect(result).toEqual([{ resource: "property", action: "read", granted: true }]);
  });

  it("mock モード（NEXT_PUBLIC_USE_MOCK=true）は早期 return で DB 非接触", async () => {
    process.env.NEXT_PUBLIC_USE_MOCK = "true";

    const result = await getUserPermissions("user-1");

    expect(result.length).toBeGreaterThan(0);
    expect(pm.user.findUnique).not.toHaveBeenCalled();
    expect(pm.permissionTemplate.findUnique).not.toHaveBeenCalled();
    expect(pm.userPermission.findMany).not.toHaveBeenCalled();
  });
});
