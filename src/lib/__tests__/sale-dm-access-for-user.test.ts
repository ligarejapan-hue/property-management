import { vi, describe, it, expect, beforeEach } from "vitest";

// api-helpers.ts は auth/prisma/sales-sheet 等を巻き込むため丸ごとモックする
// （既存の sale-dm-mark-sent-route.test.ts 等と同じ方式）。一方 permissions.ts /
// dm-export.ts は外部依存の無い純関数なので実物を使い、hasPermission /
// isPlainOwnerLevel の実シグネチャ・実挙動をそのままテストで踏む。
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
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    getOwnerDisplayConfig: vi.fn(),
  };
});
vi.mock("@/lib/prisma", () => ({ default: {} }));

import {
  checkSaleDmAccessFor,
  requireSaleDmAccess,
} from "@/lib/sale-dm-letter/route-guard";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
  type PermissionEntry,
  type OwnerDisplayConfig,
} from "@/lib/api-helpers";

const perms = vi.mocked(getUserPermissions);
const display = vi.mocked(getOwnerDisplayConfig);
const session = vi.mocked(getApiSession);

// checkSaleDmAccessFor / requireSaleDmAccess が要求する 4 権限すべてを read=granted で揃えた基準値。
const ALL_GRANTED: PermissionEntry[] = [
  { resource: "property", action: "read", granted: true },
  { resource: "property", action: "write", granted: true },
  { resource: "csv_export", action: "read", granted: true },
  { resource: "csv_export_personal", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
];

// isPlainOwnerLevel(実物) は "full" | "read" | "edit" のときのみ true を返す。
// 氏名/郵便番号/住所すべてが平文で読める設定。
const PLAIN_DISPLAY: OwnerDisplayConfig = {
  name: "full",
  nameKana: "full",
  phone: "full",
  zip: "full",
  address: "full",
  note: "full",
  email: "full",
  corporateNumber: "full",
};

beforeEach(() => {
  vi.clearAllMocks();
  perms.mockResolvedValue(ALL_GRANTED);
  display.mockResolvedValue(PLAIN_DISPLAY);
});

describe("checkSaleDmAccessFor", () => {
  it("4権限+氏名/郵便番号/住所が平文なら ok", async () => {
    const r = await checkSaleDmAccessFor("u1");
    expect(r).toEqual({ ok: true, permissions: ALL_GRANTED, ownerDisplayConfig: PLAIN_DISPLAY });
    expect(perms).toHaveBeenCalledWith("u1");
    expect(display).toHaveBeenCalledWith("u1", ALL_GRANTED);
  });

  it.each(["property", "csv_export", "csv_export_personal", "owner"] as const)(
    "%s の read が無ければ permission",
    async (resource) => {
      perms.mockResolvedValue(
        ALL_GRANTED.filter((p) => !(p.resource === resource && p.action === "read")),
      );
      expect(await checkSaleDmAccessFor("u1")).toEqual({ ok: false, reason: "permission" });
    },
  );

  it.each(["name", "zip", "address"] as const)(
    "%s が平文でなければ display",
    async (key) => {
      display.mockResolvedValue({ ...PLAIN_DISPLAY, [key]: "masked" });
      expect(await checkSaleDmAccessFor("u1")).toEqual({ ok: false, reason: "display" });
    },
  );

  it("nameKana / phone / note / email / corporateNumber が平文でなくても ok(判定対象外)", async () => {
    display.mockResolvedValue({
      ...PLAIN_DISPLAY,
      nameKana: "hidden",
      phone: "hidden",
      note: "hidden",
      email: "hidden",
      corporateNumber: "hidden",
    });
    expect((await checkSaleDmAccessFor("u1")).ok).toBe(true);
  });

  it("例外を投げない(getUserPermissions/getOwnerDisplayConfig が reject しない限り)", async () => {
    perms.mockResolvedValue([]);
    await expect(checkSaleDmAccessFor("u1")).resolves.toEqual({ ok: false, reason: "permission" });
  });
});

describe("requireSaleDmAccess は従来どおり", () => {
  it("権限が揃っていれば session/permissions/ownerDisplayConfig を返す", async () => {
    session.mockResolvedValue({ id: "u1", email: "a@example.com", name: "A", role: "office_staff" });
    const r = await requireSaleDmAccess();
    expect(r).toEqual({ session: { id: "u1", email: "a@example.com", name: "A", role: "office_staff" }, permissions: ALL_GRANTED, ownerDisplayConfig: PLAIN_DISPLAY });
  });

  it("owner:read が無ければ 403 の文言を投げる", async () => {
    session.mockResolvedValue({ id: "u1", email: "a@example.com", name: "A", role: "office_staff" });
    perms.mockResolvedValue(ALL_GRANTED.filter((p) => p.resource !== "owner"));
    await expect(requireSaleDmAccess()).rejects.toThrow("所有者情報の閲覧権限がありません");
  });

  it("表示レベルが平文でなければ 403 の文言を投げる(checkSaleDmAccessFor とは別の文言)", async () => {
    session.mockResolvedValue({ id: "u1", email: "a@example.com", name: "A", role: "office_staff" });
    display.mockResolvedValue({ ...PLAIN_DISPLAY, zip: "masked" });
    await expect(requireSaleDmAccess()).rejects.toThrow(
      "DM作成に必要な所有者情報の表示権限がありません",
    );
  });
});
