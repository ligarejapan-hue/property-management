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

type DraftRow = {
  id: string;
  propertyId: string;
  status: string;
  representativeOwnerId: string | null;
  generatedBy: string;
  draftOwners: { ownerId: string }[];
};

const state: {
  draft: DraftRow | null;
  logs: LogRow[];
} = { draft: null, logs: [] };

vi.mock("@/lib/prisma", () => {
  const client: Record<string, unknown> = {
    dmRecipientDraft: {
      findUnique: vi.fn(async () => state.draft),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    propertyDmLog: {
      findMany: vi.fn(async () => state.logs),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => args),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => args),
    },
    propertyDmLogOwner: {
      createMany: vi.fn(async () => ({ count: 1 })),
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

// ⚠route はトークン単位のレート制限(5回/時)も持ち、モジュール保持でテスト間リセットされない。
// POST するテストは freshValid() で**毎回別トークン**を使う(VALID の使い回しは5回で共食い)。
let tokSeq = 0;
function freshValid(): string {
  tokSeq += 1;
  return buildUnsubscribeToken(`trk_t${tokSeq}`, KEY);
}

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
  state.draft = {
    id: "d1",
    propertyId: "p1",
    status: "sent",
    representativeOwnerId: "own1",
    generatedBy: "user1",
    draftOwners: [{ ownerId: "own1" }, { ownerId: "own2" }],
  };
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
    const tk = freshValid();
    const res = await POST(req("POST", tk), ctx(tk));
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
    const tk = freshValid();
    const res = await POST(req("POST", tk), ctx(tk));
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
    const tk = freshValid();
    const res = await POST(req("POST", tk), ctx(tk));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("受け付けました");
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ result: "missing" }) }),
    );
  });

  it("送付済み未押下(confirmed・行なし): その場で送付済み化+送付記録を作って拒否まで記録する(@codex R2 P1)", async () => {
    state.logs = [];
    state.draft!.status = "confirmed";
    const tk = freshValid();
    const res = await POST(req("POST", tk), ctx(tk));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("受け付けました");

    const client = prisma as unknown as {
      dmRecipientDraft: { updateMany: ReturnType<typeof vi.fn> };
      propertyDmLog: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
      propertyDmLogOwner: { createMany: ReturnType<typeof vi.fn> };
    };
    // confirmed→sent の条件付き遷移(mark-sent と同じ冪等ガード=後から係が押しても二重にならない)
    expect(client.dmRecipientDraft.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "d1", status: "confirmed" } }),
    );
    // ブリッジ行の作成: sentBy は手紙の生成者・method sale_dm・draftId 紐付け
    const created = client.propertyDmLog.create.mock.calls[0][0].data;
    expect(created.method).toBe("sale_dm");
    expect(created.sentBy).toBe("user1");
    expect(created.draftId).toBe("d1");
    expect(client.propertyDmLogOwner.createMany).toHaveBeenCalled();
    // 作った行へ拒否が書かれる
    const written = client.propertyDmLog.update.mock.calls[0][0].data;
    expect(written.reactionStatus).toBe("refused");
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ result: "recorded", markedSent: true }),
      }),
    );
  });

  it("下書きへ戻っていた(status=draft): 成功と言わず連絡先へ誘導+監査 unsent", async () => {
    state.logs = [];
    state.draft!.status = "draft";
    const tk = freshValid();
    const res = await POST(req("POST", tk), ctx(tk));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("確認できませんでした");
    expect(body).not.toContain("受け付けました");
    const client = prisma as unknown as {
      propertyDmLog: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    };
    expect(client.propertyDmLog.create).not.toHaveBeenCalled();
    expect(client.propertyDmLog.update).not.toHaveBeenCalled();
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ result: "unsent" }) }),
    );
  });

  it("sent なのに行が無い(mark-sent との交差): 書かずに「混み合っています」で再押下へ", async () => {
    state.logs = [];
    state.draft!.status = "sent";
    const tk = freshValid();
    const res = await POST(req("POST", tk), ctx(tk));
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("混み合って");
  });

  it("Origin が自分と違えば 403(第三者サイトから踏ませる攻撃)", async () => {
    const tk = freshValid();
    const res = await POST(
      req("POST", tk, { origin: "https://evil.example" }),
      ctx(tk),
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
      const tk = freshValid(); // トークン制限に引っ掛けない(per-IP だけを検証)
      last = await POST(
        new Request(`http://app.test/u/${tk}`, { method: "POST", headers: fixed }) as never,
        ctx(tk),
      );
    }
    expect(last?.status).toBe(429);
    expect(await last!.text()).toContain("アクセスが集中");
  });

  it("偽署名の連投は全体上限(60/時)を消費しない(@codex P1: 正規の停止を429で締め出せない)", async () => {
    // でたらめな署名で70回(全体上限60を超える回数)叩く。全て署名検証で弾かれ、
    // 全体枠は減らない → その後の正当な申込は通る。
    const badSig = "A".repeat(22);
    for (let i = 0; i < 70; i++) {
      const forged = `${TRK}.${badSig}`;
      const res = await POST(req("POST", forged), ctx(forged));
      expect(res.status).toBe(400);
    }
    const tk = freshValid();
    const ok = await POST(req("POST", tk), ctx(tk));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("受け付けました");
  });

  it("同一トークンの連打は5回で頭打ち(1枚の手紙が全体枠を食い潰せない・@codex R3 P1)", async () => {
    const tk = freshValid();
    let last: Response | null = null;
    for (let i = 0; i < 6; i++) {
      last = await POST(req("POST", tk), ctx(tk)); // IPは毎回変わる=per-IPには当たらない
    }
    expect(last?.status).toBe(429);
    // 別の手紙(別トークン)は影響を受けない
    const other = freshValid();
    const ok = await POST(req("POST", other), ctx(other));
    expect(ok.status).toBe(200);
  });

  it("「宛先不明」(同期由来)の上には拒否を上書きする(訂正で戻っても停止の意思が残る・@codex R4 P1)", async () => {
    state.logs = [
      baseLog({ reactionStatus: "undeliverable", reactionSource: "sale_dm_sync" }),
    ];
    const tk = freshValid();
    const res = await POST(req("POST", tk), ctx(tk));
    expect(res.status).toBe(200);
    const client = prisma as unknown as {
      propertyDmLog: { update: ReturnType<typeof vi.fn> };
    };
    const data = client.propertyDmLog.update.mock.calls[0][0].data;
    expect(data.reactionStatus).toBe("refused");
    expect(data.reactionSource).toBe("manual");
  });

  it("退避(shadow)に拒否を持つ行はそのまま(見た目undeliverableでも二重に書かない)", async () => {
    state.logs = [
      baseLog({
        reactionStatus: "undeliverable",
        reactionSource: "sale_dm_sync",
        manualReactionShadow: { status: "refused", reactedAt: null, note: null },
      }),
    ];
    const tk = freshValid();
    const res = await POST(req("POST", tk), ctx(tk));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("受け付けました");
    const client = prisma as unknown as {
      propertyDmLog: { update: ReturnType<typeof vi.fn> };
    };
    expect(client.propertyDmLog.update).not.toHaveBeenCalled();
  });

  it("監査に targetId(対象draft)が入る(許可リスト運用と独立に対象を辿れる)", async () => {
    const tk = freshValid();
    await POST(req("POST", tk), ctx(tk));
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "d1" }),
    );
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
