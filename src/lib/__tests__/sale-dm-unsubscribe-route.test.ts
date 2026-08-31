import { vi, describe, it, expect, beforeEach } from "vitest";

// 公開 /u/[token](配信停止)の route テスト。
// 実DBは使わず、prisma/audit/sync/ロックを mock し「呼び出しの形と順序」を検証する
// (sale-dm-tracking-route.test.ts と同じ流儀)。

vi.mock("next/server", () => ({ NextResponse: Response }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/dm-reaction/sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dm-reaction/sync")>();
  return { ...actual, syncSaleDmReaction: vi.fn() };
});
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn() }));
vi.mock("@/lib/dm-batch/locks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dm-batch/locks")>();
  return { ...actual, lockOwnersForUpdate: vi.fn() };
});

type LogRow = {
  id: string;
  ownerId: string | null;
  reactionStatus: string;
  reactedAt: Date | null;
  reactionNote: string | null;
  reactionSource: string | null;
  manualReactionShadow: unknown;
  logOwners: { ownerId: string }[];
};

const state: {
  draft: { id: string; propertyId: string } | null;
  logs: LogRow[];
} = { draft: null, logs: [] };

vi.mock("@/lib/prisma", () => {
  const client: Record<string, unknown> = {
    dmRecipientDraft: {
      findUnique: vi.fn(async () => state.draft),
    },
    propertyDmLog: {
      findMany: vi.fn(async () => state.logs),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => args),
    },
    $queryRaw: vi.fn(async () => []),
  };
  client.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(client));
  return { default: client };
});

process.env.NEXTAUTH_SECRET = "unit-test-secret";

import { GET, POST } from "@/app/u/[token]/route";
import { buildUnsubscribeToken, deriveUnsubscribeKey } from "@/lib/sale-dm-letter/unsubscribe-token";
import { writeAuditLog } from "@/lib/audit";
import { syncSaleDmReaction } from "@/lib/dm-reaction/sync";
import { lockOwnersForUpdate } from "@/lib/dm-batch/locks";
import { lockPropertyRow } from "@/lib/property-record-guard";
import prisma from "@/lib/prisma";

const KEY = deriveUnsubscribeKey("unit-test-secret");
const TRK = "trk_abc123";
const VALID = buildUnsubscribeToken(TRK, KEY);

// ⚠route モジュールの postGlobalLimiter(全体上限 60/時)はテスト間でリセットされない。
// このファイルの POST 呼び出し合計が 60 に近づくと共食いで 429 になる。テストを足すときは
// 合計回数に注意する(現在は20回未満)。per-IP 側は下の ipSeq で毎回別IPにして回避している。
let ipSeq = 0;
function req(
  method: "GET" | "POST",
  token: string,
  headers: Record<string, string> = {},
): never {
  // テストごとに送信元IPを変える(モジュール保持のレート制限に共食いさせない)。
  ipSeq += 1;
  return new Request(`http://app.test/u/${encodeURIComponent(token)}`, {
    method,
    headers: { "x-forwarded-for": `10.0.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`, ...headers },
  }) as never;
}

function ctx(token: string) {
  return { params: Promise.resolve({ token }) };
}

function baseLog(over: Partial<LogRow> = {}): LogRow {
  return {
    id: "log1",
    ownerId: "own1",
    reactionStatus: "no_response",
    reactedAt: null,
    reactionNote: null,
    reactionSource: null,
    manualReactionShadow: null,
    logOwners: [{ ownerId: "own1" }, { ownerId: "own2" }],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.draft = { id: "d1", propertyId: "p1" };
  state.logs = [baseLog()];
});

describe("GET /u/[token](確認画面)", () => {
  it("形式が正しければ確認画面(ボタンを押すまで何も起きない=DBに触らない)", async () => {
    const res = await GET(req("GET", VALID), ctx(VALID));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("配信停止のお手続き");
    expect(html).toContain('method="post"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    const client = prisma as unknown as {
      dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn> };
    };
    expect(client.dmRecipientDraft.findUnique).not.toHaveBeenCalled();
  });

  it("形式外(門前払い)は 404 で、DB を引かない", async () => {
    const res = await GET(req("GET", "not-a-token"), ctx("not-a-token"));
    expect(res.status).toBe(404);
    const client = prisma as unknown as {
      dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn> };
    };
    expect(client.dmRecipientDraft.findUnique).not.toHaveBeenCalled();
  });
});

describe("POST /u/[token](停止の記録)", () => {
  it("正当トークン: Owner→物件→子の順にロックし、拒否を書いて同期・監査する", async () => {
    const res = await POST(req("POST", VALID), ctx(VALID));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("受け付けました");

    // ロック順序(R47): Owner FOR UPDATE → 物件親行
    const ownersOrder = (lockOwnersForUpdate as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const propOrder = (lockPropertyRow as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    expect(ownersOrder).toBeLessThan(propOrder);
    expect(
      (lockOwnersForUpdate as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).toEqual(expect.arrayContaining(["own1", "own2"]));

    const client = prisma as unknown as {
      propertyDmLog: { update: ReturnType<typeof vi.fn> };
    };
    const data = client.propertyDmLog.update.mock.calls[0][0].data;
    expect(data.reactionStatus).toBe("refused");
    expect(data.reactionSource).toBe("manual");
    expect(data.reactionNote).toContain("QRコード");

    expect(syncSaleDmReaction).toHaveBeenCalledWith(expect.anything(), "d1");
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sale_dm_qr_unsubscribe",
        detail: expect.objectContaining({ result: "recorded" }),
      }),
    );
  });

  it("既に拒否済みなら書かずに同じ完了画面(冪等・二度読み取りで壊れない)", async () => {
    state.logs = [baseLog({ reactionStatus: "refused", reactionSource: "manual" })];
    const res = await POST(req("POST", VALID), ctx(VALID));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("受け付けました");
    const client = prisma as unknown as {
      propertyDmLog: { update: ReturnType<typeof vi.fn> };
    };
    expect(client.propertyDmLog.update).not.toHaveBeenCalled();
    expect(syncSaleDmReaction).not.toHaveBeenCalled();
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ result: "already" }) }),
    );
  });

  it("署名が違えば 400(お手紙の連絡先へ誘導)。DB を引かない", async () => {
    const other = buildUnsubscribeToken("other-token", KEY).split(".")[1];
    const forged = `${TRK}.${other}`;
    const res = await POST(req("POST", forged), ctx(forged));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("確認できませんでした");
    const client = prisma as unknown as {
      dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn> };
    };
    expect(client.dmRecipientDraft.findUnique).not.toHaveBeenCalled();
  });

  it("正当署名だが宛先が消えている: 同じ完了画面(在否を答えない)+監査 missing", async () => {
    state.draft = null;
    const res = await POST(req("POST", VALID), ctx(VALID));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("受け付けました");
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ result: "missing" }) }),
    );
  });

  it("送付済みの印が無い(ブリッジ行なし): 完了画面+監査 unsent(黙って握りつぶさない)", async () => {
    state.logs = [];
    const res = await POST(req("POST", VALID), ctx(VALID));
    expect(res.status).toBe(200);
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ result: "unsent" }) }),
    );
  });

  it("Origin が自分と違えば 403(第三者サイトから踏ませる攻撃)", async () => {
    const res = await POST(
      req("POST", VALID, { origin: "https://evil.example" }),
      ctx(VALID),
    );
    expect(res.status).toBe(403);
    const client = prisma as unknown as {
      dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn> };
    };
    expect(client.dmRecipientDraft.findUnique).not.toHaveBeenCalled();
  });

  it("同一IPの連打は 429(per-IP 制限)", async () => {
    const fixed = { "x-forwarded-for": "198.51.100.200" };
    let last: Response | null = null;
    for (let i = 0; i < 11; i++) {
      last = await POST(
        new Request(`http://app.test/u/${VALID}`, { method: "POST", headers: fixed }) as never,
        ctx(VALID),
      );
    }
    expect(last?.status).toBe(429);
    expect(await last!.text()).toContain("アクセスが集中");
  });

  it("ロック後の再読取で所有者集合が変わっていたら書かずに「混み合っています」", async () => {
    const client = prisma as unknown as {
      propertyDmLog: { findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    };
    client.propertyDmLog.findMany
      .mockResolvedValueOnce([baseLog()]) // 先読み
      .mockResolvedValueOnce([baseLog({ logOwners: [{ ownerId: "own3" }] })]); // ロック後
    const res = await POST(req("POST", VALID), ctx(VALID));
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("混み合って");
    expect(client.propertyDmLog.update).not.toHaveBeenCalled();
  });
});
