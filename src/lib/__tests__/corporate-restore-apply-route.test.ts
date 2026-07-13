/**
 * POST /api/admin/owners/correction/corporate-restore-apply の統合テスト。
 *
 * 割れた会社法人等番号の復元反映:
 *  - 分断型: 復元13桁で国税庁lookup → found∧非廃止のとき
 *    氏名(国税庁の会社名)+住所(モードにより最新本店 or 断片除去)+12桁/13桁を反映
 *  - 断片型: lookupなしで氏名から断片を除去(会社名の救出)のみ
 * version 楽観ロック・廃止/該当なし/競合は skip。lookup 未設定は 503。
 * 検出エンジンは純関数の実物。prisma / api-helpers / audit / change-log / lookup は mock。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { PermissionEntry } from "@/lib/api-helpers";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  return { NextRequest: MockNextRequest };
});

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
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data, { status }),
    ),
    handleApiError: vi.fn((error: unknown) => {
      if (error instanceof MockApiError) {
        return Response.json(
          { error: { message: error.message, code: error.code } },
          { status: error.status },
        );
      }
      return Response.json(
        { error: { message: "Server error", code: "INTERNAL_ERROR" } },
        { status: 500 },
      );
    }),
  };
});

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/change-log", () => ({
  recordChanges: vi.fn(),
}));
vi.mock("@/lib/property-field-constants", async (importOriginal) => {
  return importOriginal();
});
vi.mock("@/lib/corporate-lookup", () => ({
  isCorporateLookupConfigured: vi.fn(),
  lookupCorporateNumber: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  default: { owner: { findUnique: vi.fn(), updateMany: vi.fn() } },
}));

import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
} from "@/lib/api-helpers";
import {
  isCorporateLookupConfigured,
  lookupCorporateNumber,
} from "@/lib/corporate-lookup";
import { recordChanges } from "@/lib/change-log";
import { writeAuditLog } from "@/lib/audit";
import { POST } from "../../app/api/admin/owners/correction/corporate-restore-apply/route";

const SPLIT_ID = "11111111-1111-4111-8111-111111111111";
const FRAG_ID = "22222222-2222-4222-8222-222222222222";

const p = prisma as unknown as {
  owner: { findUnique: Mock; updateMany: Mock };
};
const sessionMock = getApiSession as unknown as Mock;
const permsMock = getUserPermissions as unknown as Mock;
const displayConfigMock = getOwnerDisplayConfig as unknown as Mock;
const configuredMock = isCorporateLookupConfigured as unknown as Mock;
const lookupMock = lookupCorporateNumber as unknown as Mock;
const recordChangesMock = recordChanges as unknown as Mock;
const auditMock = writeAuditLog as unknown as Mock;

const FULL_DISPLAY = {
  name: "full",
  address: "full",
  note: "full",
  corporateNumber: "full",
} as const;

const FULL_PERMS: PermissionEntry[] = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "owner", action: "write", granted: true },
  { resource: "owner_corporate_number", action: "full", granted: true },
  { resource: "owner_name", action: "full", granted: true },
  { resource: "owner_address", action: "full", granted: true },
  { resource: "owner_zip", action: "full", granted: true },
];

const SPLIT_OWNER = {
  id: SPLIT_ID,
  name: "５９４４２",
  address:
    "東京都渋谷区渋谷二丁目１７番１号渋谷アクシュ２１Ｆ会社法人等番号０１１０－０１－０",
  zip: null,
  corporateNumber: null,
  companyRegistryNumber: null,
  version: 2,
  isArchived: false,
};
const FRAG_OWNER = {
  id: FRAG_ID,
  name: "株式会社テスト商事会社法人等番号０１２４－０１－０",
  address: "東京都中央区銀座1-1-1",
  zip: null,
  corporateNumber: null,
  companyRegistryNumber: null,
  version: 1,
  isArchived: false,
};

const NTA_RECORD = {
  corporateNumber: "5011001059442",
  name: "株式会社リガーレ商事",
  furigana: null,
  address: "東京都渋谷区代々木一丁目1番1号",
  prefectureName: "東京都",
  cityName: "渋谷区",
  streetNumber: "代々木一丁目1番1号",
  postCode: "1510053",
  updateDate: "2026-01-01",
};

function foundLookup() {
  return {
    found: true,
    isClosed: false,
    closeDate: null,
    closeCause: null,
    record: NTA_RECORD,
    fetchedAt: "2026-07-13T00:00:00.000Z",
    source: "nta-houjin-bangou-v4",
  };
}

function req(
  owners: Array<{ ownerId: string; version: number }>,
  addressMode: "nta" | "cleaned" = "nta",
) {
  return new Request("http://t/", {
    method: "POST",
    body: JSON.stringify({ owners, addressMode }),
    headers: { "content-type": "application/json" },
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.mockResolvedValue({ id: "user-1" });
  permsMock.mockResolvedValue(FULL_PERMS);
  displayConfigMock.mockResolvedValue(FULL_DISPLAY);
  configuredMock.mockReturnValue(true);
  lookupMock.mockResolvedValue(foundLookup());
  p.owner.findUnique.mockResolvedValue(SPLIT_OWNER);
  p.owner.updateMany.mockResolvedValue({ count: 1 });
});

describe("認可・前提", () => {
  it.each([
    ["user_management:read", "user_management"],
    ["owner:read/write", "owner"],
    ["owner_corporate_number", "owner_corporate_number"],
    ["owner_name", "owner_name"],
    ["owner_address", "owner_address"],
    ["owner_zip", "owner_zip"],
  ])("%s が無ければ 403", async (_label, resource) => {
    permsMock.mockResolvedValue(
      FULL_PERMS.filter((perm) => perm.resource !== resource),
    );
    const res = await POST(req([{ ownerId: SPLIT_ID, version: 2 }]));
    expect(res.status).toBe(403);
  });

  it("lookup 未設定なら 503", async () => {
    configuredMock.mockReturnValue(false);
    const res = await POST(req([{ ownerId: SPLIT_ID, version: 2 }]));
    expect(res.status).toBe(503);
  });

  it("body 不正は 400", async () => {
    const res = await POST(
      new Request("http://t/", {
        method: "POST",
        body: JSON.stringify({ owners: [], addressMode: "nta" }),
        headers: { "content-type": "application/json" },
      }) as never,
    );
    expect(res.status).toBe(400);
  });
});

describe("分断型の反映", () => {
  it("addressMode=nta: 国税庁の会社名・最新本店住所・郵便番号・12/13桁を反映する", async () => {
    const res = await POST(req([{ ownerId: SPLIT_ID, version: 2 }], "nta"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([{ ownerId: SPLIT_ID, status: "applied" }]);
    expect(body.applied).toBe(1);

    expect(lookupMock).toHaveBeenCalledWith(
      expect.stringMatching(/^\d011001059442$/),
    );
    expect(p.owner.updateMany).toHaveBeenCalledTimes(1);
    const call = p.owner.updateMany.mock.calls[0][0];
    // version に加え、lookup 待機中の別経路書込(versionを上げないパス)を検知する
    // corporateNumber スナップショット条件が入っていること(レビューP2対応)。
    expect(call.where).toEqual({
      id: SPLIT_ID,
      version: 2,
      corporateNumber: null,
    });
    expect(call.data.name).toBe("株式会社リガーレ商事");
    expect(call.data.address).toBe("東京都渋谷区代々木一丁目1番1号");
    expect(call.data.zip).toBe("151-0053"); // XXX-XXXX 形式に整形して保存
    expect(call.data.companyRegistryNumber).toBe("011001059442");
    expect(call.data.corporateNumber).toMatch(/^\d011001059442$/);
    expect(call.data.version).toEqual({ increment: 1 });
  });

  it("addressMode=cleaned: 住所は断片除去のみ・郵便番号は触らない", async () => {
    const res = await POST(req([{ ownerId: SPLIT_ID, version: 2 }], "cleaned"));
    expect(res.status).toBe(200);
    const call = p.owner.updateMany.mock.calls[0][0];
    expect(call.data.address).toBe(
      "東京都渋谷区渋谷二丁目１７番１号渋谷アクシュ２１Ｆ",
    );
    expect(call.data).not.toHaveProperty("zip");
    expect(call.data.name).toBe("株式会社リガーレ商事");
  });

  it("廃止法人は closed で skip(書込なし)", async () => {
    lookupMock.mockResolvedValue({
      ...foundLookup(),
      isClosed: true,
      closeDate: "2020-01-01",
    });
    const res = await POST(req([{ ownerId: SPLIT_ID, version: 2 }]));
    const body = await res.json();
    expect(body.results[0].status).toBe("closed");
    expect(p.owner.updateMany).not.toHaveBeenCalled();
  });

  it("国税庁に該当なしは lookup_no_result で skip", async () => {
    lookupMock.mockResolvedValue({
      ...foundLookup(),
      found: false,
      record: null,
    });
    const res = await POST(req([{ ownerId: SPLIT_ID, version: 2 }]));
    const body = await res.json();
    expect(body.results[0].status).toBe("lookup_no_result");
    expect(p.owner.updateMany).not.toHaveBeenCalled();
  });

  it("version 不一致は version_conflict で skip", async () => {
    const res = await POST(req([{ ownerId: SPLIT_ID, version: 99 }]));
    const body = await res.json();
    expect(body.results[0].status).toBe("version_conflict");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("updateMany count=0(レース)は version_conflict", async () => {
    p.owner.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(req([{ ownerId: SPLIT_ID, version: 2 }]));
    const body = await res.json();
    expect(body.results[0].status).toBe("version_conflict");
  });

  it("検出パターンに該当しない owner は no_detection", async () => {
    p.owner.findUnique.mockResolvedValue({
      ...SPLIT_OWNER,
      name: "田中一郎",
      address: "東京都千代田区1-1",
    });
    const res = await POST(req([{ ownerId: SPLIT_ID, version: 2 }]));
    const body = await res.json();
    expect(body.results[0].status).toBe("no_detection");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("ChangeLog に変更フィールドの old/new を記録する", async () => {
    await POST(req([{ ownerId: SPLIT_ID, version: 2 }], "nta"));
    expect(recordChangesMock).toHaveBeenCalledTimes(1);
    const arg = recordChangesMock.mock.calls[0][0];
    expect(arg.targetTable).toBe("owners");
    expect(arg.targetId).toBe(SPLIT_ID);
    expect(arg.oldValues.name).toBe("５９４４２");
    expect(arg.newValues.name).toBe("株式会社リガーレ商事");
    expect(arg.newValues.companyRegistryNumber).toBe("011001059442");
  });
});

describe("番号あり氏名欠落型の反映(取込ガード適用後のレコード)", () => {
  const NAME_LOST_ID = "55555555-5555-4555-8555-555555555555";
  const NAME_LOST_OWNER = {
    id: NAME_LOST_ID,
    name: "５９４４２",
    address: "東京都渋谷区渋谷二丁目１７番１号",
    zip: null,
    corporateNumber: "4011001059442",
    companyRegistryNumber: null,
    version: 4,
    isArchived: false,
  };

  beforeEach(() => {
    p.owner.findUnique.mockResolvedValue(NAME_LOST_OWNER);
  });

  it("既存13桁で国税庁照会し、会社名を復元する(番号は不変・12桁は補完)", async () => {
    const res = await POST(req([{ ownerId: NAME_LOST_ID, version: 4 }], "nta"));
    const body = await res.json();
    expect(body.results[0].status).toBe("applied");
    expect(lookupMock).toHaveBeenCalledWith("4011001059442");
    const call = p.owner.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({
      id: NAME_LOST_ID,
      version: 4,
      corporateNumber: "4011001059442",
    });
    expect(call.data.name).toBe("株式会社リガーレ商事");
    expect(call.data.companyRegistryNumber).toBe("011001059442");
    // ChangeLog: 変わらない corporateNumber は old/new に載せない
    const arg = recordChangesMock.mock.calls[0][0];
    expect(arg.newValues).not.toHaveProperty("corporateNumber");
    expect(arg.newValues.companyRegistryNumber).toBe("011001059442");
    expect(arg.newValues.name).toBe("株式会社リガーレ商事");
  });

  it("addressMode=cleaned では住所を触らない(元々断片なし)", async () => {
    const res = await POST(
      req([{ ownerId: NAME_LOST_ID, version: 4 }], "cleaned"),
    );
    const body = await res.json();
    expect(body.results[0].status).toBe("applied");
    const call = p.owner.updateMany.mock.calls[0][0];
    expect(call.data).not.toHaveProperty("address");
    expect(call.data).not.toHaveProperty("zip");
  });
});

describe("断片型の反映(lookupなし)", () => {
  beforeEach(() => {
    p.owner.findUnique.mockResolvedValue(FRAG_OWNER);
  });

  it("氏名から断片を除去して反映する(番号・住所は触らない)", async () => {
    const res = await POST(req([{ ownerId: FRAG_ID, version: 1 }]));
    const body = await res.json();
    expect(body.results[0].status).toBe("applied");
    expect(lookupMock).not.toHaveBeenCalled();
    const call = p.owner.updateMany.mock.calls[0][0];
    // 読み取り時点の name をスナップショット条件にする(レビューP2対応)。
    expect(call.where).toEqual({
      id: FRAG_ID,
      version: 1,
      name: FRAG_OWNER.name,
    });
    expect(call.data.name).toBe("株式会社テスト商事");
    expect(call.data).not.toHaveProperty("address");
    expect(call.data).not.toHaveProperty("corporateNumber");
    expect(call.data).not.toHaveProperty("companyRegistryNumber");
  });

  it("会社名が救出できない(ラベルのみの氏名)は not_eligible で skip", async () => {
    p.owner.findUnique.mockResolvedValue({
      ...FRAG_OWNER,
      name: "会社法人等番号２９００－０１－０",
    });
    const res = await POST(req([{ ownerId: FRAG_ID, version: 1 }]));
    const body = await res.json();
    expect(body.results[0].status).toBe("not_eligible");
    expect(p.owner.updateMany).not.toHaveBeenCalled();
  });
});

describe("audit", () => {
  it("件数のみ記録(生値・owner id 配列なし)", async () => {
    await POST(req([{ ownerId: SPLIT_ID, version: 2 }]));
    expect(auditMock).toHaveBeenCalledTimes(1);
    const arg = auditMock.mock.calls[0][0];
    const detailStr = JSON.stringify(arg.detail ?? {});
    expect(detailStr).not.toContain(SPLIT_ID);
    expect(detailStr).not.toContain("011001059442");
    expect(detailStr).not.toContain("リガーレ");
    expect(arg.detail.requested).toBe(1);
    expect(arg.detail.applied).toBe(1);
  });
});
