/**
 * 実況パネル配信 route のテスト。
 *  - GET /api/properties/[id]/registry/search/live/[ref] (進行 JSON)
 *  - GET /api/properties/[id]/registry/search/live/[ref]/shot/[seq] (JPEG)
 *
 * 検証: 権限境界 (registry:auto_fetch + property:read)・実行者本人限定
 * (userId が違えば 404)・不正 ref/seq の 404・no-store/nosniff ヘッダ。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", async () => {
  const actual =
    await vi.importActual<typeof import("next/server")>("next/server");
  class MockNextRequest extends Request {}
  return { ...actual, NextRequest: MockNextRequest };
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
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data, { status }),
    ),
  };
});

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { GET as GET_LIVE } from "@/app/api/properties/[id]/registry/search/live/[ref]/route";
import { GET as GET_SHOT } from "@/app/api/properties/[id]/registry/search/live/[ref]/shot/[seq]/route";
import {
  beginLiveView,
  reportLiveStep,
  completeLiveView,
  __clearLiveViewStoreForTests,
} from "@/lib/registry-fetch/live-view-store";

const user = { id: "u-1", email: "a@x", name: "A", role: "admin" };
const fullPerms = [
  { resource: "registry", action: "auto_fetch", granted: true },
  { resource: "property", action: "read", granted: true },
];
const REF = "ref-12345678";
const PROP = "prop-1";

function req(url: string) {
  return new Request(url) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  __clearLiveViewStoreForTests();
  (getApiSession as Mock).mockResolvedValue(user);
  (getUserPermissions as Mock).mockResolvedValue(fullPerms);
});

describe("GET live/[ref]", () => {
  it("registry:auto_fetch 不所持は 403", async () => {
    (getUserPermissions as Mock).mockResolvedValue([
      { resource: "property", action: "read", granted: true },
    ]);
    const res = await GET_LIVE(req("http://x"), {
      params: Promise.resolve({ id: PROP, ref: REF }),
    });
    expect(res.status).toBe(403);
  });

  it("property:read 不所持は 403", async () => {
    (getUserPermissions as Mock).mockResolvedValue([
      { resource: "registry", action: "auto_fetch", granted: true },
    ]);
    const res = await GET_LIVE(req("http://x"), {
      params: Promise.resolve({ id: PROP, ref: REF }),
    });
    expect(res.status).toBe(403);
  });

  it("未開始 / 期限切れの ref は 404", async () => {
    const res = await GET_LIVE(req("http://x"), {
      params: Promise.resolve({ id: PROP, ref: REF }),
    });
    expect(res.status).toBe(404);
  });

  it("不正形式の ref は 404 (store に触れない)", async () => {
    const res = await GET_LIVE(req("http://x"), {
      params: Promise.resolve({ id: PROP, ref: "a/b" }),
    });
    expect(res.status).toBe(404);
  });

  it("実行者本人は steps/done を取得できる (no-store)", async () => {
    beginLiveView(user.id, PROP, REF);
    reportLiveStep(user.id, PROP, REF, "自動検索を受け付けました", null);
    reportLiveStep(user.id, PROP, REF, "所在と地番・家屋番号を入力しました", new Uint8Array(8));
    completeLiveView(user.id, PROP, REF);
    const res = await GET_LIVE(req("http://x"), {
      params: Promise.resolve({ id: PROP, ref: REF }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as {
      data: { steps: Array<{ label: string; hasShot: boolean }>; done: boolean };
    };
    expect(body.data.done).toBe(true);
    expect(body.data.steps.length).toBe(2);
    expect(body.data.steps[1].hasShot).toBe(true);
  });

  it("他人の実況は (権限があっても) 404", async () => {
    beginLiveView("someone-else", PROP, REF);
    const res = await GET_LIVE(req("http://x"), {
      params: Promise.resolve({ id: PROP, ref: REF }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET live/[ref]/shot/[seq]", () => {
  it("本人のスクショを image/jpeg + no-store + nosniff で返す", async () => {
    beginLiveView(user.id, PROP, REF);
    reportLiveStep(user.id, PROP, REF, "step", new Uint8Array([1, 2, 3]));
    const res = await GET_SHOT(req("http://x"), {
      params: Promise.resolve({ id: PROP, ref: REF, seq: "0" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(buf)).toEqual([1, 2, 3]);
  });

  it("shot の無い step / 不正 seq は 404", async () => {
    beginLiveView(user.id, PROP, REF);
    reportLiveStep(user.id, PROP, REF, "text-only", null);
    for (const seq of ["0", "-1", "1.5", "abc"]) {
      const res = await GET_SHOT(req("http://x"), {
        params: Promise.resolve({ id: PROP, ref: REF, seq }),
      });
      expect(res.status).toBe(404);
    }
  });

  it("他人のスクショは (権限があっても) 404", async () => {
    beginLiveView("someone-else", PROP, REF);
    reportLiveStep("someone-else", PROP, REF, "s", new Uint8Array([9]));
    const res = await GET_SHOT(req("http://x"), {
      params: Promise.resolve({ id: PROP, ref: REF, seq: "0" }),
    });
    expect(res.status).toBe(404);
  });

  it("registry:auto_fetch 不所持は 403", async () => {
    (getUserPermissions as Mock).mockResolvedValue([
      { resource: "property", action: "read", granted: true },
    ]);
    const res = await GET_SHOT(req("http://x"), {
      params: Promise.resolve({ id: PROP, ref: REF, seq: "0" }),
    });
    expect(res.status).toBe(403);
  });
});
