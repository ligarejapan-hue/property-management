/**
 * POST /api/field-survey/pins/:id/suggest-address のテスト。
 *
 * 要点:
 * - 認可は物件化(convert-to-property)と同一ゲート
 * - **座標はクライアントへ返さない**（返すのは組み立て済み住所のみ）
 * - **POST 固定**（座標の外部送信という副作用を cross-site 遷移で発動させない）
 * - env 未設定 = 503 休眠 / 上流失敗 = 502 / 海上等 = 200 + found:false
 */
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
    handleApiError: vi.fn((error: unknown) => {
      const e = error as { status?: number; message?: string; code?: string };
      return Response.json(
        { error: { message: e.message, code: e.code } },
        { status: typeof e.status === "number" ? e.status : 500 },
      );
    }),
    apiResponse: vi.fn((data: unknown, status = 200) => Response.json(data, { status })),
  };
});
vi.mock("@/lib/prisma", () => ({
  default: { fieldSurveyPin: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
// ReverseGeocodeError / isPlausibleJapanCoordinate は実物を使い、外部接続する
// reverseGeocode と env 依存の isReverseGeocodeConfigured だけ差し替える
// （instanceof 判定を実クラスで通すため）。
vi.mock("@/lib/reverse-geocode", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/reverse-geocode")>();
  return {
    ...actual,
    reverseGeocode: vi.fn(),
    isReverseGeocodeConfigured: vi.fn(),
  };
});
// ローカル街区照合(第2弾)。既定はデータ無し=null(GSI フォールバック)。
vi.mock("@/lib/address-blocks/lookup", () => ({
  findNearestBlock: vi.fn(),
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import {
  reverseGeocode,
  isReverseGeocodeConfigured,
  ReverseGeocodeError,
} from "@/lib/reverse-geocode";
import { findNearestBlock } from "@/lib/address-blocks/lookup";
import { POST } from "../route";

const pm = prisma as unknown as { fieldSurveyPin: { findUnique: Mock } };
const FS_READ = { resource: "field_survey", action: "read", granted: true };
const WRITE = [{ resource: "property", action: "write", granted: true }, FS_READ];
const WRITE_ONLY = [{ resource: "property", action: "write", granted: true }];
const WRITE_READ_ALL = [...WRITE, { resource: "field_survey", action: "read_all", granted: true }];
const WRITE_MANAGE = [...WRITE, { resource: "field_survey", action: "manage", granted: true }];
const PIN_ID = "11111111-1111-1111-1111-111111111111";

const req = new Request(
  `http://localhost/api/field-survey/pins/${PIN_ID}/suggest-address`,
  // POST 固定(Codex R7 P2): 座標の外部送信という副作用を持つため
  // cross-site 遷移(GET)では発動させない。
  { method: "POST" },
) as unknown as import("next/server").NextRequest;
const ctx = { params: Promise.resolve({ id: PIN_ID }) };

const FOUND = {
  found: true,
  address: "東京都杉並区西荻北三丁目",
  town: "西荻北三丁目",
  precision: "town",
  municipalityCode: "13115",
};
const BLOCK_HIT = {
  address: "東京都杉並区西荻北3-1",
  town: "西荻北三丁目",
  distanceM: 18,
  isResidential: true,
};

function pin(overrides: Record<string, unknown> = {}) {
  // Prisma は Decimal を返す。route 側の Number() 変換を通すため
  // number でない Decimal 風オブジェクトで模す。
  return {
    id: PIN_ID,
    staffUserId: "user-1",
    lat: { toString: () => "35.7237362" } as unknown,
    lng: { toString: () => "139.5992861" } as unknown,
    pinType: "candidate",
    status: "open",
    propertyId: null,
    ...overrides,
  };
}

describe("POST /api/field-survey/pins/[id]/suggest-address", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getApiSession as Mock).mockResolvedValue({ id: "user-1", role: "member" });
    (getUserPermissions as Mock).mockResolvedValue(WRITE);
    pm.fieldSurveyPin.findUnique.mockResolvedValue(pin());
    (isReverseGeocodeConfigured as Mock).mockReturnValue(true);
    (findNearestBlock as Mock).mockResolvedValue(null); // 既定: 街区データ未取込
    (reverseGeocode as Mock).mockResolvedValue(FOUND);
  });

  it("property:write が無ければ 403（pin を読まない・外部も呼ばない）", async () => {
    (getUserPermissions as Mock).mockResolvedValue([FS_READ]);
    const res = await POST(req, ctx);
    expect(res.status).toBe(403);
    expect(pm.fieldSurveyPin.findUnique).not.toHaveBeenCalled();
    expect(reverseGeocode).not.toHaveBeenCalled();
  });

  it("field_survey:read が無ければ 403", async () => {
    (getUserPermissions as Mock).mockResolvedValue(WRITE_ONLY);
    const res = await POST(req, ctx);
    expect(res.status).toBe(403);
    expect(pm.fieldSurveyPin.findUnique).not.toHaveBeenCalled();
  });

  it("pin が無ければ 404", async () => {
    pm.fieldSurveyPin.findUnique.mockResolvedValue(null);
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
    expect(reverseGeocode).not.toHaveBeenCalled();
  });

  it("他人の pin は read_all/manage が無ければ 403（外部を呼ばない）", async () => {
    pm.fieldSurveyPin.findUnique.mockResolvedValue(pin({ staffUserId: "other" }));
    const res = await POST(req, ctx);
    expect(res.status).toBe(403);
    expect(reverseGeocode).not.toHaveBeenCalled();
  });

  it.each([
    ["候補外(blocked)", { pinType: "blocked" }, 422],
    ["対応済み(closed)", { status: "closed" }, 409],
    ["アーカイブ済み", { status: "archived" }, 409],
    ["物件化済み", { propertyId: "prop-1" }, 409],
  ] as const)(
    "変換できない状態のピン(%s)は %i(外部送信・監査より前に弾く=Codex R8 P2)",
    async (_label, overrides, status) => {
      pm.fieldSurveyPin.findUnique.mockResolvedValue(pin(overrides));
      const res = await POST(req, ctx);
      expect(res.status).toBe(status);
      // 座標を外部へ送らない・監査も書かない(状態チェックが先)。
      expect(reverseGeocode).not.toHaveBeenCalled();
      expect(writeAuditLog).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["read_all", WRITE_READ_ALL],
    ["manage", WRITE_MANAGE],
  ])(
    "他人の pin でも %s があれば 200 + field_survey_pin_view 監査(座標・住所なし)",
    async (_label, perms) => {
      (getUserPermissions as Mock).mockResolvedValue(perms);
      pm.fieldSurveyPin.findUnique.mockResolvedValue(pin({ staffUserId: "other" }));
      const res = await POST(req, ctx);
      expect(res.status).toBe(200);
      // location route と同じ cross-staff 追跡(Codex P2)。detail は ID のみ。
      expect(writeAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          action: "field_survey_pin_view",
          targetTable: "field_survey_pins",
          targetId: PIN_ID,
          detail: { pinId: PIN_ID, ownerStaffUserId: "other" },
        }),
      );
      const logged = JSON.stringify((writeAuditLog as Mock).mock.calls);
      expect(logged).not.toContain("35.7237362");
      expect(logged).not.toContain("西荻北");
    },
  );

  it("自分の pin → 200・住所を返す。⚠座標(lat/lng)は応答に含めない・監査も残さない", async () => {
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ result: FOUND });
    expect(writeAuditLog).not.toHaveBeenCalled();
    // 応答のどこにも座標が漏れていないこと（数値・文字列どちらの形でも）
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("35.7237362");
    expect(raw).not.toContain("139.5992861");
    expect(raw).not.toMatch(/lat|lng/);
  });

  it("海上・国外(found:false)は 200 でそのまま返す（エラーにしない）", async () => {
    (reverseGeocode as Mock).mockResolvedValue({ found: false });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { found: false } });
  });

  it("座標が壊れた pin は外部を呼ばず found:false", async () => {
    pm.fieldSurveyPin.findUnique.mockResolvedValue(
      pin({ lat: { toString: () => "0" }, lng: { toString: () => "0" } }),
    );
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { found: false } });
    expect(reverseGeocode).not.toHaveBeenCalled();
  });

  it("街区データにヒット → 番までの住所を precision:'block' で返し、外部(GSI)を呼ばない", async () => {
    (findNearestBlock as Mock).mockResolvedValue(BLOCK_HIT);
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      result: {
        found: true,
        address: "東京都杉並区西荻北3-1",
        town: "西荻北三丁目",
        precision: "block",
      },
    });
    // ローカルで引けたら座標の外部送信は発生しない。
    expect(reverseGeocode).not.toHaveBeenCalled();
  });

  it("街区データに無ければ GSI(町丁目まで)へフォールバック", async () => {
    (findNearestBlock as Mock).mockResolvedValue(null);
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: FOUND });
    expect(findNearestBlock).toHaveBeenCalledTimes(1);
    expect(reverseGeocode).toHaveBeenCalledTimes(1);
  });

  it("env 未設定(NOT_CONFIGURED) → 503 休眠。ローカル街区照合も含め一切動かない", async () => {
    (isReverseGeocodeConfigured as Mock).mockReturnValue(false);
    const res = await POST(req, ctx);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_CONFIGURED");
    expect(findNearestBlock).not.toHaveBeenCalled();
    expect(reverseGeocode).not.toHaveBeenCalled();
  });

  it.each(["TIMEOUT", "NETWORK", "UPSTREAM_ERROR", "PARSE_ERROR"] as const)(
    "上流失敗(%s) → 502（メッセージに内部情報を含めない）",
    async (code) => {
      (reverseGeocode as Mock).mockRejectedValue(new ReverseGeocodeError(code));
      const res = await POST(req, ctx);
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error.code).toBe("UPSTREAM_ERROR");
      expect(JSON.stringify(body)).not.toContain("gsi.go.jp");
    },
  );
});
