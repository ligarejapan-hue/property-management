import { vi } from "vitest";
vi.mock("next/server", () => {
  class MockNextResponse extends Response {
    static redirect = (url: string, init?: number | ResponseInit) => {
      const status = typeof init === "number" ? init : (init?.status ?? 307);
      const headers = typeof init === "object" && init && "headers" in init ? (init.headers as HeadersInit) : undefined;
      return new Response(null, { status, headers: { ...(headers as Record<string, string>), Location: url } });
    };
  }
  return { NextResponse: MockNextResponse };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    dmRecipientDraft: {
      findUnique: vi.fn(async () => ({ id: "r1", lpFirstAccessAt: null, status: "sent" })),
      update: vi.fn(async () => ({ id: "r1" })),
    },
  },
}));

import { describe, it, expect } from "vitest";
import { recordTrackingHit } from "../sale-dm-letter/tracking-record";

function makeTx(existing: { id: string; lpFirstAccessAt: Date | null; status?: string } | null) {
  return {
    dmRecipientDraft: {
      findUnique: vi.fn(async () => existing),
      update: vi.fn(async (args: unknown) => {
        void args; // 呼び出し引数は mock.calls で検証する(本体では未使用)。
        return { id: existing?.id };
      }),
    },
  };
}

describe("recordTrackingHit", () => {
  it("未知トークンは matched=false・更新しない", async () => {
    const tx = makeTx(null);
    const r = await recordTrackingHit(tx as never, "nope");
    expect(r.matched).toBe(false);
    expect(tx.dmRecipientDraft.update).not.toHaveBeenCalled();
  });

  it("送付前(confirmed)のヒットは matched=false・更新しない(送付前プレビュー由来でA/Bを汚さない)", async () => {
    const tx = makeTx({ id: "r1", lpFirstAccessAt: null, status: "confirmed" });
    const r = await recordTrackingHit(tx as never, "tok");
    expect(r.matched).toBe(false);
    expect(tx.dmRecipientDraft.update).not.toHaveBeenCalled();
  });

  it("初回アクセスは lpFirstAccessAt をセット + count++", async () => {
    const tx = makeTx({ id: "r1", lpFirstAccessAt: null, status: "sent" });
    const r = await recordTrackingHit(tx as never, "tok");
    expect(r.matched).toBe(true);
    expect(r.firstHit).toBe(true); // 初回ヒット(lpFirstAccessAt が null→セット)
    const arg = tx.dmRecipientDraft.update.mock.calls[0][0] as {
      data: { lpFirstAccessAt?: Date; lpAccessCount: { increment: number }; outcome?: string };
    };
    expect(arg.data.lpFirstAccessAt).toBeInstanceOf(Date);
    expect(arg.data.lpAccessCount).toEqual({ increment: 1 });
    expect(arg.data.outcome).toBe("inquiry"); // outcome 永続キャッシュを LP アクセスで同期
  });

  it("2回目以降は lpFirstAccessAt を上書きしない(冪等)・count は ++・firstHit=false", async () => {
    const tx = makeTx({ id: "r1", lpFirstAccessAt: new Date("2020-01-01"), status: "sent" });
    const r = await recordTrackingHit(tx as never, "tok");
    expect(r.firstHit).toBe(false); // 再訪は初回でない → 監査しない判定に使う
    const arg = tx.dmRecipientDraft.update.mock.calls[0][0] as {
      data: { lpFirstAccessAt?: Date; lpAccessCount: { increment: number }; outcome?: string };
    };
    expect(arg.data.lpFirstAccessAt).toBeUndefined();
    expect(arg.data.lpAccessCount).toEqual({ increment: 1 });
    expect(arg.data.outcome).toBe("inquiry"); // 2回目以降も冪等に inquiry を維持
  });

  it("送付済み matched は variant.lpUrl を variantLpUrl で返す(型ごとLP振り分け)", async () => {
    const tx = {
      dmRecipientDraft: {
        findUnique: vi.fn(async () => ({ id: "r1", lpFirstAccessAt: null, status: "sent", variant: { lpUrl: "https://lp1.example.com" } })),
        update: vi.fn(async () => ({ id: "r1" })),
      },
    };
    const r = await recordTrackingHit(tx as never, "tok");
    expect(r.matched).toBe(true);
    expect(r.variantLpUrl).toBe("https://lp1.example.com");
  });

  it("型に lpUrl が無ければ variantLpUrl=null(既定LPへフォールバックさせる)", async () => {
    const tx = {
      dmRecipientDraft: {
        findUnique: vi.fn(async () => ({ id: "r1", lpFirstAccessAt: null, status: "sent", variant: { lpUrl: null } })),
        update: vi.fn(async () => ({ id: "r1" })),
      },
    };
    const r = await recordTrackingHit(tx as never, "tok");
    expect(r.variantLpUrl).toBeNull();
  });

  it("未知トークンは variantLpUrl=null", async () => {
    const tx = makeTx(null);
    const r = await recordTrackingHit(tx as never, "nope");
    expect(r.variantLpUrl).toBeNull();
  });
});

import { describe as d2, it as i2, expect as e2, beforeEach as b2 } from "vitest";
import prismaMock from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { GET } from "../../app/t/[token]/route";

const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const ENV = process.env;
b2(() => { vi.clearAllMocks(); process.env = { ...ENV }; });

d2("GET /t/[token]", () => {
  i2("既知トークン + LP 設定で 302 → LP・記録する・no-store", async () => {
    process.env.SALE_DM_LP_URL = "https://lp.example.com/sell";
    const res = await GET(new Request("http://x/t/tok") as never, ctx("tok"));
    e2(res.status).toBe(302);
    e2(res.headers.get("Location")).toBe("https://lp.example.com/sell");
    e2(res.headers.get("Cache-Control")).toBe("no-store");
    const pm = prismaMock as never as { dmRecipientDraft: { update: ReturnType<typeof vi.fn> } };
    e2(pm.dmRecipientDraft.update).toHaveBeenCalledOnce();
    // 初回ヒットのみ監査する。
    e2(writeAuditLog).toHaveBeenCalledOnce();
  });

  i2("送付済みトークンの再訪(2回目以降)は 302・記録(count++)するが監査しない(公開ヒットで audit_logs を肥大化させない)", async () => {
    process.env.SALE_DM_LP_URL = "https://lp.example.com/sell";
    const pm = prismaMock as never as { dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } };
    // 既に LP アクセス済み(lpFirstAccessAt がセット済み)= 再訪。
    pm.dmRecipientDraft.findUnique.mockResolvedValueOnce({ id: "r1", lpFirstAccessAt: new Date("2020-01-01"), status: "sent" });
    const res = await GET(new Request("http://x/t/tok") as never, ctx("tok"));
    e2(res.status).toBe(302);
    e2(pm.dmRecipientDraft.update).toHaveBeenCalledOnce(); // lpAccessCount の ++ は継続する
    e2(writeAuditLog).not.toHaveBeenCalled(); // 初回のみ監査 → 再訪では監査しない(無制限増加の防止)
  });

  i2("LP 未設定なら 404(fail-closed)・記録も監査もしない(LP未到達を反響計上しない)", async () => {
    delete process.env.SALE_DM_LP_URL;
    const pm = prismaMock as never as { dmRecipientDraft: { update: ReturnType<typeof vi.fn> } };
    const res = await GET(new Request("http://x/t/tok") as never, ctx("tok"));
    e2(res.status).toBe(404);
    e2(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
    e2(writeAuditLog).not.toHaveBeenCalled();
  });

  i2("非絶対の LP URL(lp.example.com)は未設定扱いで 404・記録しない", async () => {
    process.env.SALE_DM_LP_URL = "lp.example.com";
    const pm = prismaMock as never as { dmRecipientDraft: { update: ReturnType<typeof vi.fn> } };
    const res = await GET(new Request("http://x/t/tok") as never, ctx("tok"));
    e2(res.status).toBe(404);
    e2(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
  });

  i2("未知トークンでも LP 設定済みなら 302(列挙耐性)・記録は更新しない", async () => {
    process.env.SALE_DM_LP_URL = "https://lp.example.com/sell";
    const pm = prismaMock as never as { dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } };
    pm.dmRecipientDraft.findUnique.mockResolvedValueOnce(null);
    const res = await GET(new Request("http://x/t/nope") as never, ctx("nope"));
    e2(res.status).toBe(302);
    e2(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
    // 未マッチ(bot/列挙)では audit_logs に書かない=書込増幅の防止。
    e2(writeAuditLog).not.toHaveBeenCalled();
  });

  i2("送付前(confirmed)トークンは 302 だが記録・監査しない", async () => {
    process.env.SALE_DM_LP_URL = "https://lp.example.com/sell";
    const pm = prismaMock as never as { dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } };
    pm.dmRecipientDraft.findUnique.mockResolvedValueOnce({ id: "r1", lpFirstAccessAt: null, status: "confirmed" });
    const res = await GET(new Request("http://x/t/tok") as never, ctx("tok"));
    e2(res.status).toBe(302);
    e2(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
    e2(writeAuditLog).not.toHaveBeenCalled();
  });

  i2("送付済み + 型に lpUrl があれば その型のLPへ 302(型ごとLP振り分け・既定LPでなく)", async () => {
    process.env.SALE_DM_LP_URL = "https://default-lp.example.com";
    const pm = prismaMock as never as { dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn> } };
    pm.dmRecipientDraft.findUnique.mockResolvedValueOnce({ id: "r1", lpFirstAccessAt: null, status: "sent", variant: { lpUrl: "https://variant-b-lp.example.com" } });
    const res = await GET(new Request("http://x/t/tok") as never, ctx("tok"));
    e2(res.status).toBe(302);
    e2(res.headers.get("Location")).toBe("https://variant-b-lp.example.com");
  });

  i2("型に lpUrl が無ければ 既定LP(SALE_DM_LP_URL)へ 302(フォールバック)", async () => {
    process.env.SALE_DM_LP_URL = "https://default-lp.example.com";
    const pm = prismaMock as never as { dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn> } };
    pm.dmRecipientDraft.findUnique.mockResolvedValueOnce({ id: "r1", lpFirstAccessAt: null, status: "sent", variant: { lpUrl: null } });
    const res = await GET(new Request("http://x/t/tok") as never, ctx("tok"));
    e2(res.headers.get("Location")).toBe("https://default-lp.example.com");
  });

  i2("型の lpUrl が非絶対URLなら 既定LPへ(防御・不正値で redirect しない)", async () => {
    process.env.SALE_DM_LP_URL = "https://default-lp.example.com";
    const pm = prismaMock as never as { dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn> } };
    pm.dmRecipientDraft.findUnique.mockResolvedValueOnce({ id: "r1", lpFirstAccessAt: null, status: "sent", variant: { lpUrl: "not-a-url" } });
    const res = await GET(new Request("http://x/t/tok") as never, ctx("tok"));
    e2(res.headers.get("Location")).toBe("https://default-lp.example.com");
  });
});
