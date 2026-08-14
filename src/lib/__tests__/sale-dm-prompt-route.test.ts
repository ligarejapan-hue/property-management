import { vi } from "vitest";
vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response {
    static json = (b: unknown, init?: ResponseInit) => Response.json(b, init);
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(s: number, m: string, c = "ERROR") {
      super(m);
      this.status = s;
      this.code = c;
    }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    getOwnerDisplayConfig: vi.fn(),
    parseJsonBody: vi.fn(async () => ({})),
    handleApiError: vi.fn((e: unknown) =>
      e instanceof MockApiError
        ? Response.json(
            { error: { message: e.message, code: e.code } },
            { status: e.status },
          )
        : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 }),
    ),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    dmCampaign: { findFirst: vi.fn() },
    dmVariant: { findFirst: vi.fn() },
    dmRecipientDraft: { count: vi.fn() },
  },
}));

import { describe, it, expect, beforeEach } from "vitest";
import prismaMock from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
} from "@/lib/api-helpers";
import { GET } from "../../app/api/properties/sale-dm/campaigns/[id]/variants/[variantId]/prompt/route";
import { promptDigest, bodyTemplateDigest } from "../sale-dm-letter/external-prompt";

const pm = prismaMock as never as {
  dmCampaign: { findFirst: ReturnType<typeof vi.fn> };
  dmVariant: { findFirst: ReturnType<typeof vi.fn> };
  dmRecipientDraft: { count: ReturnType<typeof vi.fn> };
};

const READS = ["property", "csv_export", "csv_export_personal", "owner"];
const ctx = { params: Promise.resolve({ id: "c1", variantId: "v1" }) };
const req = () => new Request("http://x") as never;

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "u1",
    role: "admin",
  });
  (getUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue(
    READS.map((r) => ({ resource: r, action: "read", granted: true })),
  );
  (getOwnerDisplayConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
    name: "full",
    zip: "full",
    address: "full",
    nameKana: "full",
  });
  pm.dmCampaign.findFirst.mockResolvedValue({ id: "c1" });
  pm.dmVariant.findFirst.mockResolvedValue({
    id: "v1",
    tone: "formal",
    length: "medium",
    appeal: "price",
    strength: "medium",
    templateFrozenAt: null,
    bodyTemplate: null,
  });
  pm.dmRecipientDraft.count.mockResolvedValue(0);
});

describe("GET sale-dm variant prompt", () => {
  it("プロンプト全文と、その指紋を返す", async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { prompt: string; digest: string };
    expect(body.prompt).toContain("{{物件所在}}");
    // 指紋は返したプロンプトそのものから作られている(表示と貼り付けの版ずれ検出に使う)
    expect(body.digest).toBe(promptDigest(body.prompt));
  });

  it("プロンプトに宛先の個人情報が入らない", async () => {
    const res = await GET(req(), ctx);
    const body = (await res.json()) as { prompt: string };
    expect(body.prompt).not.toMatch(/様|御中/);
  });

  it("他人のキャンペーンは 404(存在を漏らさない)", async () => {
    pm.dmCampaign.findFirst.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
    expect(pm.dmVariant.findFirst).not.toHaveBeenCalled();
  });

  it("そのキャンペーンに無い型は 404", async () => {
    pm.dmVariant.findFirst.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
  });

  it("配下に確定/送付済みがあれば frozen=true(列が未設定でも)", async () => {
    pm.dmRecipientDraft.count.mockResolvedValue(1);
    const res = await GET(req(), ctx);
    const body = (await res.json()) as { frozen: boolean };
    expect(body.frozen).toBe(true);
  });

  it("凍結印が立っていれば frozen=true(配下に確定が無くても)", async () => {
    pm.dmVariant.findFirst.mockResolvedValue({
      id: "v1",
      tone: "formal",
      length: "medium",
      appeal: "price",
      strength: "medium",
      templateFrozenAt: new Date("2026-08-01T00:00:00.000Z"),
      bodyTemplate: "保存済み本文",
    });
    const res = await GET(req(), ctx);
    const body = (await res.json()) as { frozen: boolean; bodyTemplate: string };
    expect(body.frozen).toBe(true);
    expect(body.bodyTemplate).toBe("保存済み本文");
  });

  it("いまの原本の指紋も返す(保存時の版ずれ検出に使う・@codex #376 R14)", async () => {
    // ⚠設定の指紋(digest)は2つのタブで同じ値になる。原本の指紋を返さないと、
    //   先に保存・適用された文面を古い画面からの保存が黙って差し替えられる。
    pm.dmVariant.findFirst.mockResolvedValue({
      id: "v1",
      tone: "formal",
      length: "medium",
      appeal: "price",
      strength: "medium",
      templateFrozenAt: null,
      bodyTemplate: "保存済み本文",
    });
    const saved = (await (await GET(req(), ctx)).json()) as { bodyDigest: string };
    expect(saved.bodyDigest).toBe(bodyTemplateDigest("保存済み本文"));
    // 原本がまだ無い型は「空」の指紋(未設定と空文字は同じ扱い)。
    pm.dmVariant.findFirst.mockResolvedValue({
      id: "v1",
      tone: "formal",
      length: "medium",
      appeal: "price",
      strength: "medium",
      templateFrozenAt: null,
      bodyTemplate: null,
    });
    const empty = (await (await GET(req(), ctx)).json()) as { bodyDigest: string };
    expect(empty.bodyDigest).toBe(bodyTemplateDigest(null));
    expect(empty.bodyDigest).not.toBe(saved.bodyDigest);
  });

  it("監査は1件・本文やプロンプトを残さない", async () => {
    await GET(req(), ctx);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(writeAuditLog).mock.calls[0][0] as {
      action: string;
      detail?: Record<string, unknown>;
    };
    expect(arg.action).toBe("sale_dm_prompt_view");
    expect(JSON.stringify(arg.detail)).not.toMatch(/物件所在|不動産/);
  });
});
