import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

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
    // 実 parseJsonBody と同じ挙動: 空ボディ→{} / 不正JSON→throw。
    parseJsonBody: vi.fn(async (req: Request) => {
      const text = await req.text();
      return text.trim() === "" ? {} : JSON.parse(text);
    }),
    handleApiError: vi.fn((e: unknown) => {
      const err = e as { status?: number; message?: string; code?: string; issues?: unknown[] };
      if (typeof err?.status === "number") {
        return Response.json(
          { error: { message: err.message, code: err.code } },
          { status: err.status },
        );
      }
      if (Array.isArray(err?.issues)) {
        return Response.json(
          { error: { message: "invalid input", code: "VALIDATION_ERROR" } },
          { status: 422 },
        );
      }
      return Response.json(
        { error: { message: "internal", code: "INTERNAL_ERROR" } },
        { status: 500 },
      );
    }),
  };
});

vi.mock("@/lib/permissions", () => ({
  hasPermission: vi.fn(
    (
      perms: { resource: string; action: string; granted: boolean }[],
      resource: string,
      action: string,
    ) => perms.some((p) => p.resource === resource && p.action === action && p.granted),
  ),
}));

vi.mock("@/lib/property-access", () => ({
  canAccessPropertyRecord: vi.fn(
    (
      session: { id: string; role: string },
      property: { createdBy: string; assignedTo: string | null },
    ) => {
      if (session.role !== "field_staff") return true;
      return property.createdBy === session.id || property.assignedTo === session.id;
    },
  ),
}));

const LAND_PROPERTY = {
  id: "p1",
  createdBy: "u1",
  assignedTo: null,
  propertyType: "land",
  address: "東京都新宿区1-1-1",
  zoningDistrict: null,
  buildingCoverageRatio: null,
  floorAreaRatio: null,
  roadType: null,
  roadWidth: null,
  occupancyStatus: null,
  roomNo: null,
  exclusiveArea: null,
  balconyArea: null,
  layoutType: null,
  floorNo: null,
  orientation: null,
  managementFee: null,
  repairReserveFee: null,
  building: null,
};

const MANSION_PROPERTY = {
  ...LAND_PROPERTY,
  propertyType: "apartment_unit",
  roomNo: "301",
  exclusiveArea: "62.45",
  balconyArea: "8.20",
  layoutType: "2LDK",
  floorNo: 3,
  orientation: "南",
  managementFee: 12000,
  repairReserveFee: 8500,
  building: {
    name: "テストレジデンス",
    totalFloors: 10,
    builtYear: 2015,
    structureType: "RC",
    managementCompany: "テスト管理サービス",
    totalUnits: 45,
  },
};

vi.mock("@/lib/prisma", () => ({
  default: {
    property: {
      findUnique: vi.fn(async () => LAND_PROPERTY),
    },
    propertyOwner: {
      findFirst: vi.fn(async () => null),
    },
    propertyPhoto: {
      findMany: vi.fn(async () => []),
    },
  },
}));

// createDesign: DB書き込みはモック。ただし parseSalesSheetDocument を通じた
// document 検証は実行する（無効な document が 422 になることをこのテストで検出できるように）。
vi.mock("@/lib/sales-sheet/design-service", async () => {
  const { parseSalesSheetDocument } = await import("@/lib/sales-sheet/document-schema");
  return {
    createDesign: vi.fn(async (input: { document: unknown }) => {
      parseSalesSheetDocument(input.document); // invalid document は throw → handleApiError が 422
      return { id: "sheet-1" };
    }),
  };
});

// 写真の保存前認可（caller 認可＋物件所属）。既定 true、テストで上書き。
vi.mock("@/lib/sales-sheet/authorize-document-images", () => ({
  isImageKeyAuthorizedForProperty: vi.fn(async () => true),
}));

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

// build-document はモックしない — 実関数でドキュメントを組むことで /uploads/ src が
// 実際にバリデーション経路を通る。

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { createDesign } from "@/lib/sales-sheet/design-service";
import { isImageKeyAuthorizedForProperty } from "@/lib/sales-sheet/authorize-document-images";
import { writeAuditLog } from "@/lib/audit";
import { POST } from "../route";

type PrismaMock = {
  property: { findUnique: Mock };
  propertyOwner: { findFirst: Mock };
  propertyPhoto: { findMany: Mock };
};
const pm = prisma as unknown as PrismaMock;

const ADMIN_SESSION = { id: "u1", email: "a@b.com", name: "Admin", role: "admin" };
const WRITE_PERMS = [{ resource: "property", action: "write", granted: true }];

function makeRequest() {
  return new Request("http://localhost/api/properties/p1/sales-sheets/new", { method: "POST" });
}

function lastDocument() {
  return (createDesign as Mock).mock.calls[0][0].document as {
    elements: {
      type: string;
      id?: string;
      content?: string;
      rows?: { label: string; value: string }[];
    }[];
  };
}
// [F2-A Task4] 売土地スペック表（overview テーブル要素）の行を label で引く小道具。
function landOverviewRow(label: string): string | undefined {
  const overview = lastDocument().elements.find((e) => e.id === "overview");
  return overview?.rows?.find((r) => r.label === label)?.value;
}
function lastTemplateId() {
  return (createDesign as Mock).mock.calls[0][0].templateId as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue(ADMIN_SESSION);
  (getUserPermissions as Mock).mockResolvedValue(WRITE_PERMS);
  pm.property.findUnique.mockResolvedValue(LAND_PROPERTY);
  pm.propertyOwner.findFirst.mockResolvedValue(null);
  pm.propertyPhoto.findMany.mockResolvedValue([]);
  (isImageKeyAuthorizedForProperty as Mock).mockResolvedValue(true);
});

describe("POST /api/properties/[id]/sales-sheets/new", () => {
  it("401 — 未認証", async () => {
    (getApiSession as Mock).mockRejectedValue(
      Object.assign(new Error("auth"), { status: 401, code: "UNAUTHORIZED" }),
    );
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(401);
  });

  it("403 — property:write 権限なし", async () => {
    (getUserPermissions as Mock).mockResolvedValue([]);
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(403);
  });

  it("404 — 物件が存在しない", async () => {
    pm.property.findUnique.mockResolvedValue(null);
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(404);
  });

  it("403 — field_staff がスコープ外物件にアクセス", async () => {
    (getApiSession as Mock).mockResolvedValue({
      id: "other-user",
      email: "x@y.com",
      name: "Field",
      role: "field_staff",
    });
    pm.property.findUnique.mockResolvedValue({ ...LAND_PROPERTY, createdBy: "u1", assignedTo: null });
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(403);
  });

  it("422 — 対応外の物件種別（例: 店舗）", async () => {
    pm.property.findUnique.mockResolvedValue({ ...LAND_PROPERTY, propertyType: "store" });
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_PROPERTY_TYPE");
  });

  it("201 — 土地物件: sale-land で design 作成して id を返す", async () => {
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("sheet-1");
    expect(createDesign).toHaveBeenCalledOnce();
    expect(lastTemplateId()).toBe("sale-land");
  });

  // [F2-A Task4] landOverridesSchema を LAND_FIELDS 駆動へ総入れ替え（旧: price/access/
  // landArea/landCategory:string/transactionType/deliveryTiming/remarks の固定7項目）。
  function makeLandRequest(body: unknown) {
    return new Request("http://localhost/api/properties/p1/sales-sheets/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("201 — 土地: 新schemaの multiselect（地目）を受理し、生成documentのスペック表に併記される", async () => {
    const res = await POST(makeLandRequest({ landCategory: ["宅地", "雑種地"] }), {
      params: Promise.resolve({ id: "p1" }),
    });
    expect(res.status).toBe(201);
    expect(landOverviewRow("地目")).toBe("宅地 / 雑種地");
  });

  it("201 — 土地: 用途地域は自動反映(zoningDistrict)+overrideの追加選択を併記する", async () => {
    pm.property.findUnique.mockResolvedValue({ ...LAND_PROPERTY, zoningDistrict: "商業地域" });
    const res = await POST(makeLandRequest({ useDistrict: ["近隣商業地域"] }), {
      params: Promise.resolve({ id: "p1" }),
    });
    expect(res.status).toBe(201);
    expect(landOverviewRow("用途地域")).toBe("商業地域 / 近隣商業地域");
  });

  it("201 — 土地: 消費税の行は生成されない（土地は非課税・LAND_FIELDS に tax 系キーが無い）", async () => {
    const res = await POST(makeLandRequest({ price: "3480" }), {
      params: Promise.resolve({ id: "p1" }),
    });
    expect(res.status).toBe(201);
    const overview = lastDocument().elements.find((e) => e.id === "overview");
    expect(overview?.rows?.some((r) => r.label.includes("消費税"))).toBe(false);
    expect(JSON.stringify(lastDocument())).not.toContain("消費税");
  });

  it("201 — 土地: 所在地（自動反映専用）がスペック表の実在の行として入る", async () => {
    const res = await POST(makeLandRequest({}), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(201);
    expect(landOverviewRow("所在地")).toBe(LAND_PROPERTY.address);
  });

  it("201 — 土地: 見出し要素は「売土地」固定（自社マイソク様式・field-model駆動の証跡）", async () => {
    const res = await POST(makeLandRequest({}), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(201);
    const heading = lastDocument().elements.find((e) => e.id === "heading");
    expect(heading?.content).toBe("売土地");
  });

  it("201 — 土地: 写真は最大3枚まで seed される（旧: 土地のみ1枚 → mansion/house/buildingと統一）", async () => {
    pm.propertyPhoto.findMany.mockResolvedValue([
      { fileUrl: "/uploads/a/1.jpg" },
      { fileUrl: "/uploads/a/2.jpg" },
      { fileUrl: "/uploads/a/3.jpg" },
    ]);
    (isImageKeyAuthorizedForProperty as Mock).mockResolvedValue(true);
    const res = await POST(makeLandRequest({}), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(201);
    expect(lastDocument().elements.filter((e) => e.type === "image").length).toBe(3);
  });

  it("201 — 区分マンション: sale-mansion（建物名・専有面積を含む）", async () => {
    pm.property.findUnique.mockResolvedValue(MANSION_PROPERTY);
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(201);
    expect(lastTemplateId()).toBe("sale-mansion");
    // 自社マイソク様式（Task4 rework）は冗長な種別ラベル「売マンション」を印字せず、
    // 建物名+号室の見出し要素を出す（意図的な仕様変更・[T4→T5] carry-forward 参照）。
    // 見出し要素そのものを検証することで、単なる文字列の偶然の一致ではないことを担保する。
    const heading = lastDocument().elements.find((e) => e.id === "heading");
    expect(heading?.content).toContain("テストレジデンス");
    expect(heading?.content).toContain("301号室");
    expect(JSON.stringify(lastDocument())).toContain("テストレジデンス");
    expect(JSON.stringify(lastDocument())).toContain("301"); // 部屋番号が図面に入る
    // route.ts の building select に managementCompany/totalUnits を追加し、builder へ
    // 渡していることをこの route レベルのテストでも確認する（builder 単体は
    // build-mansion.test.ts で既に検証済み・ここでは配線の回帰を検知する）。
    expect(JSON.stringify(lastDocument())).toContain("テスト管理サービス");
    expect(JSON.stringify(lastDocument())).toContain("45戸");
  });

  it("201 — 区分（旧 unit）: sale-mansion（legacy propertyType も対応）", async () => {
    pm.property.findUnique.mockResolvedValue({ ...MANSION_PROPERTY, propertyType: "unit" });
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(201);
    expect(lastTemplateId()).toBe("sale-mansion");
  });

  it("201 — 戸建: sale-house", async () => {
    pm.property.findUnique.mockResolvedValue({ ...LAND_PROPERTY, propertyType: "house", layoutType: "4LDK" });
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(201);
    expect(lastTemplateId()).toBe("sale-house");
    expect(JSON.stringify(lastDocument())).toContain("売戸建");
  });

  // [F2-B Task3] houseOverridesSchema を HOUSE_FIELDS(field-model) 駆動へ総入れ替え（旧:
  // price/access/landArea/buildingArea/builtYearMonth/structure/transactionType/
  // deliveryTiming/remarks の固定8項目）。landOverridesSchema の検証パターン
  // （makeLandRequest/landOverviewRow）と同じ形で戸建にも用意する。
  function makeHouseRequest(body: unknown) {
    return new Request("http://localhost/api/properties/p1/sales-sheets/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  function houseOverviewRow(label: string): string | undefined {
    const overview = lastDocument().elements.find((e) => e.id === "overview");
    return overview?.rows?.find((r) => r.label === label)?.value;
  }

  it("201 — 戸建: 新schemaの multiselect（地目）を受理し、生成documentのスペック表に併記される", async () => {
    pm.property.findUnique.mockResolvedValue({ ...LAND_PROPERTY, propertyType: "house" });
    const res = await POST(makeHouseRequest({ landCategory: ["宅地", "雑種地"] }), {
      params: Promise.resolve({ id: "p1" }),
    });
    expect(res.status).toBe(201);
    expect(houseOverviewRow("地目")).toBe("宅地 / 雑種地");
  });

  it("201 — 戸建: 用途地域は自動反映(zoningDistrict)+overrideの追加選択を併記する", async () => {
    pm.property.findUnique.mockResolvedValue({
      ...LAND_PROPERTY,
      propertyType: "house",
      zoningDistrict: "商業地域",
    });
    const res = await POST(makeHouseRequest({ useDistrict: ["近隣商業地域"] }), {
      params: Promise.resolve({ id: "p1" }),
    });
    expect(res.status).toBe(201);
    expect(houseOverviewRow("用途地域")).toBe("商業地域 / 近隣商業地域");
  });

  it("201 — 戸建: 課税指定で「うち消費税」行が入る（マンションと同じ tax/taxAmount 欄）", async () => {
    pm.property.findUnique.mockResolvedValue({ ...LAND_PROPERTY, propertyType: "house" });
    const res = await POST(makeHouseRequest({ tax: "課税", taxAmount: "180" }), {
      params: Promise.resolve({ id: "p1" }),
    });
    expect(res.status).toBe(201);
    expect(houseOverviewRow("うち消費税")).toBe("180万円");
  });

  it("201 — 戸建: 旧キー名 deliveryTiming を後方互換で受理し、引渡時期欄に入る（キャッシュ済みクライアント対応）", async () => {
    pm.property.findUnique.mockResolvedValue({ ...LAND_PROPERTY, propertyType: "house" });
    const res = await POST(makeHouseRequest({ deliveryTiming: "即時" }), {
      params: Promise.resolve({ id: "p1" }),
    });
    expect(res.status).toBe(201);
    expect(houseOverviewRow("引渡時期")).toBe("即時");
  });

  it("201 — 戸建: 見出し要素は「売戸建」固定（自社マイソク様式・field-model駆動の証跡）", async () => {
    pm.property.findUnique.mockResolvedValue({ ...LAND_PROPERTY, propertyType: "house" });
    const res = await POST(makeHouseRequest({}), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(201);
    const heading = lastDocument().elements.find((e) => e.id === "heading");
    expect(heading?.content).toBe("売戸建");
  });

  it("201 — 一棟マンション: sale-building（apartment_building）", async () => {
    pm.property.findUnique.mockResolvedValue({ ...LAND_PROPERTY, propertyType: "apartment_building" });
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(201);
    expect(lastTemplateId()).toBe("sale-building");
    expect(JSON.stringify(lastDocument())).toContain("一棟マンション");
  });

  it("201 — 一棟アパート: 表題は一棟アパート（apartment_block）", async () => {
    pm.property.findUnique.mockResolvedValue({ ...LAND_PROPERTY, propertyType: "apartment_block" });
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(201);
    expect(lastTemplateId()).toBe("sale-building");
    expect(JSON.stringify(lastDocument())).toContain("一棟アパート");
  });

  it("201 — 認可OKの写真は最大3枚まで document に入る（順序 isPrimary→sortOrder）", async () => {
    pm.property.findUnique.mockResolvedValue(MANSION_PROPERTY);
    pm.propertyPhoto.findMany.mockResolvedValue([
      { fileUrl: "/uploads/a/1.jpg" },
      { fileUrl: "/uploads/a/2.jpg" },
      { fileUrl: "/uploads/a/3.jpg" },
    ]);
    (isImageKeyAuthorizedForProperty as Mock).mockResolvedValue(true);
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(201);
    expect(lastDocument().elements.filter((e) => e.type === "image").length).toBe(3);
  });

  it("201 — 認可NG/別物件の写真は document に入れず「写真なし初期図面」で作成", async () => {
    pm.propertyPhoto.findMany.mockResolvedValue([{ fileUrl: "/uploads/photo.jpg" }]);
    (isImageKeyAuthorizedForProperty as Mock).mockResolvedValue(false); // caller NG または別物件
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(201); // 拒否ではなく写真 drop で作成
    expect(lastDocument().elements.some((e) => e.type === "image")).toBe(false);
  });

  it("作成成功時に AuditLog を1件記録する（非PIIメタのみ）", async () => {
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(201);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const arg = (writeAuditLog as Mock).mock.calls[0][0];
    expect(arg).toMatchObject({
      userId: "u1",
      action: "sales_sheet_design_create",
      targetTable: "sales_sheet_designs",
      targetId: "sheet-1",
      detail: { propertyId: "p1" },
    });
    // detail に document 本文・画像 key/URL・overrides 等の PII を含めない（propertyId のみ）。
    expect(Object.keys(arg.detail as object)).toEqual(["propertyId"]);
    expect(JSON.stringify(arg.detail)).not.toContain("data:");
    expect(JSON.stringify(arg.detail)).not.toContain("uploads");
  });

  it("対応外種別（422）では AuditLog を記録しない", async () => {
    pm.property.findUnique.mockResolvedValue({ ...LAND_PROPERTY, propertyType: "store" });
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(422);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});
