import { describe, it, expect, vi, beforeEach } from "vitest";

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
  // 実 handleApiError を模倣: status を持つ error(ApiError / route-guard reject)はその status、
  // zod の ZodError(issues 配列)は 422、それ以外は 500。
  return {
    ApiError: MockApiError,
    // 実 parseJsonBody を模倣: 空ボディ→{}・不正JSON→ApiError(400)。
    parseJsonBody: vi.fn(async (r: Request) => {
      const t = await r.text();
      if (t.trim() === "") return {};
      try {
        return JSON.parse(t);
      } catch {
        throw new MockApiError(400, "リクエストボディが不正な JSON です", "INVALID_JSON");
      }
    }),
    handleApiError: vi.fn((e: unknown) => {
      if (e && typeof e === "object") {
        const x = e as { status?: unknown; code?: unknown; message?: unknown; issues?: unknown };
        if (typeof x.status === "number") {
          return Response.json({ error: { message: x.message, code: x.code } }, { status: x.status });
        }
        if (Array.isArray(x.issues)) {
          return Response.json({ error: { code: "VALIDATION_ERROR" } }, { status: 422 });
        }
      }
      return Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 });
    }),
  };
});

vi.mock("@/lib/sale-dm-letter/route-guard", () => ({
  requireSaleDmAccess: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
// ブリッジ同期とOwnerロックは呼び出し(順序・引数)を検証するため mock(実装は sync.test.ts で担保)。
vi.mock("@/lib/dm-reaction/sync", () => ({ syncSaleDmReaction: vi.fn() }));
vi.mock("@/lib/dm-batch/locks", () => ({ lockOwnersForUpdate: vi.fn() }));
vi.mock("@/lib/prisma", () => {
  const draftUpdate = vi.fn();
  const draftCount = vi.fn();
  const propertyUpdate = vi.fn();
  const draftFindUnique = vi.fn();
  const logFindMany = vi.fn(async () => []);
  const logCount = vi.fn(async () => 0);
  const logUpdate = vi.fn();
  const txQueryRaw = vi.fn(async () => []); // FOR UPDATE ロック(結果は使わない)。tx 内の再読込・直列化用。
  return {
    default: {
      dmRecipientDraft: { findUnique: draftFindUnique, update: draftUpdate, count: draftCount },
      property: { update: propertyUpdate },
      propertyDmLog: { findMany: logFindMany, count: logCount, update: logUpdate },
      $queryRaw: txQueryRaw,
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
        fn({
          dmRecipientDraft: { update: draftUpdate, count: draftCount, findUnique: draftFindUnique },
          property: { update: propertyUpdate },
          propertyDmLog: { findMany: logFindMany, count: logCount, update: logUpdate },
          $queryRaw: txQueryRaw,
        }),
      ),
    },
  };
});

import prismaMock from "@/lib/prisma";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { writeAuditLog } from "@/lib/audit";
import { syncSaleDmReaction } from "@/lib/dm-reaction/sync";
import { lockOwnersForUpdate } from "@/lib/dm-batch/locks";
import { PATCH } from "../../app/api/properties/sale-dm/drafts/[id]/outcome/route";

const pm = prismaMock as never as {
  dmRecipientDraft: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
  property: { update: ReturnType<typeof vi.fn> };
  propertyDmLog: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  $queryRaw: ReturnType<typeof vi.fn>;
};
const req = (b: unknown) =>
  new Request("http://x", { method: "PATCH", body: JSON.stringify(b) });
const ctx = (id = "r1") => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1" }, permissions: [{ resource: "property", action: "write", granted: true }] });
  pm.dmRecipientDraft.findUnique.mockResolvedValue({
    id: "r1",
    propertyId: "p1",
    deliveryStatus: "unknown",
    lpFirstAccessAt: null,
    phoneInquiryAt: null,
    status: "sent",
    campaign: { createdBy: "u1" },
  });
  pm.dmRecipientDraft.update.mockResolvedValue({ id: "r1" });
  pm.dmRecipientDraft.count.mockResolvedValue(0);
  pm.property.update.mockResolvedValue({ id: "p1" });
});

describe("PATCH outcome", () => {
  it("delivered を記録し deliveryStatus/returnedAt を更新・物件は触らない", async () => {
    const res = await PATCH(req({ deliveryStatus: "delivered" }) as never, ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(pm.dmRecipientDraft.update).toHaveBeenCalled();
    const arg = pm.dmRecipientDraft.update.mock.calls[0][0];
    expect(arg.data.deliveryStatus).toBe("delivered");
    expect(arg.data.returnedAt).toBeNull();
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("電話反響を記録し outcome を inquiry に同期する", async () => {
    const res = await PATCH(req({ phoneInquiry: true }) as never, ctx());
    expect(res.status).toBe(200);
    const arg = pm.dmRecipientDraft.update.mock.calls[0][0];
    expect(arg.data.phoneInquiryAt).toBeInstanceOf(Date);
    expect(arg.data.outcome).toBe("inquiry");
  });

  it("電話反響を取り消すと outcome は LP の有無で再導出(LPなし→none)", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1",
      propertyId: "p1",
      deliveryStatus: "delivered",
      lpFirstAccessAt: null,
      phoneInquiryAt: new Date(),
      status: "sent",
      campaign: { createdBy: "u1" },
    });
    const res = await PATCH(req({ phoneInquiry: false }) as never, ctx());
    expect(res.status).toBe(200);
    const arg = pm.dmRecipientDraft.update.mock.calls[0][0];
    expect(arg.data.phoneInquiryAt).toBeNull();
    expect(arg.data.outcome).toBe("none");
  });

  it("更新中に公開LPヒットが入っても tx内の最新再読込(FOR UPDATE)で outcome を inquiry に確定する(古いsnapshotのnoneで上書きしない・C3)", async () => {
    // 進入時 snapshot は lpFirstAccessAt=null。だが tx 内の最新再読込では、同時 /t/ ヒットで lpFirstAccessAt が
    // セット済み(=inquiry)。古い null snapshot 由来の outcome=none で上書きしてはならない。
    pm.dmRecipientDraft.findUnique
      .mockResolvedValueOnce({ id: "r1", propertyId: "p1", deliveryStatus: "unknown", lpFirstAccessAt: null, phoneInquiryAt: null, status: "sent", campaign: { createdBy: "u1" } })
      .mockResolvedValueOnce({ lpFirstAccessAt: new Date(), phoneInquiryAt: null }); // tx 内ロック下の最新値
    const res = await PATCH(req({ deliveryStatus: "delivered" }) as never, ctx());
    expect(res.status).toBe(200);
    expect(pm.dmRecipientDraft.findUnique).toHaveBeenCalledTimes(2); // 進入時 + tx 内の最新再読込
    const arg = pm.dmRecipientDraft.update.mock.calls[0][0];
    expect(arg.data.outcome).toBe("inquiry"); // 最新の inquiry(古い snapshot の none ではない)
    const body = await res.json();
    expect(body.outcome).toBe("inquiry");
  });

  it("配達遷移もロック下の最新 deliveryStatus で判定する(並行解除後の再設定で no_send 連動を取りこぼさない・Codex)", async () => {
    // 進入時 snapshot は returned_undeliverable だが、tx 内ロック下の最新では別 PATCH が delivered に解除済み。
    // この request が returned_undeliverable を再設定 → 最新基準で becameUndeliverable=true → 物件を no_send 連動。
    pm.dmRecipientDraft.findUnique
      .mockResolvedValueOnce({ id: "r1", propertyId: "p1", deliveryStatus: "returned_undeliverable", lpFirstAccessAt: null, phoneInquiryAt: null, status: "sent", campaign: { createdBy: "u1" } })
      .mockResolvedValueOnce({ lpFirstAccessAt: null, phoneInquiryAt: null, deliveryStatus: "delivered" });
    const res = await PATCH(req({ deliveryStatus: "returned_undeliverable" }) as never, ctx());
    expect(res.status).toBe(200);
    const propArg = pm.property.update.mock.calls[0][0];
    expect(propArg.data.dmStatus).toBe("no_send"); // 古い snapshot だと取りこぼす連動を、最新基準で実施
    expect(propArg.data.dmUndeliverableAt).toBeInstanceOf(Date);
  });

  it("returned_undeliverable を記録すると物件を no_send + dmUndeliverableAt にし監査する", async () => {
    const res = await PATCH(req({ deliveryStatus: "returned_undeliverable" }) as never, ctx());
    expect(res.status).toBe(200);
    const draftArg = pm.dmRecipientDraft.update.mock.calls[0][0];
    expect(draftArg.data.deliveryStatus).toBe("returned_undeliverable");
    expect(draftArg.data.returnedAt).toBeInstanceOf(Date);
    const propArg = pm.property.update.mock.calls[0][0];
    expect(propArg.where.id).toBe("p1");
    expect(propArg.data.dmStatus).toBe("no_send");
    expect(propArg.data.dmUndeliverableAt).toBeInstanceOf(Date);
    expect(writeAuditLog).toHaveBeenCalled();
    const audit = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.stringify(audit.detail)).not.toContain("本文");
  });

  it("returned_other は物件連動しない", async () => {
    const res = await PATCH(req({ deliveryStatus: "returned_other" }) as never, ctx());
    expect(res.status).toBe(200);
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("返戻(returned_undeliverable)はブリッジ行の所有者を FOR UPDATE してから行ロックへ(Owner→親→子=R47)", async () => {
    pm.propertyDmLog.findMany.mockResolvedValueOnce([
      { ownerId: "o1", logOwners: [{ ownerId: "o2" }] },
    ]);
    const res = await PATCH(req({ deliveryStatus: "returned_undeliverable" }) as never, ctx());
    expect(res.status).toBe(200);
    const lockCall = (lockOwnersForUpdate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect([...(lockCall[1] as string[])].sort()).toEqual(["o1", "o2"]);
    // Owner ロックは最初の $queryRaw(親行・draft行ロック)より先
    expect((lockOwnersForUpdate as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
      .toBeLessThan(pm.$queryRaw.mock.invocationCallOrder[0]);
  });

  it("draft 更新後に syncSaleDmReaction を同一 tx で呼ぶ(ブリッジ行へ反響を同期)", async () => {
    const res = await PATCH(req({ deliveryStatus: "returned_undeliverable" }) as never, ctx());
    expect(res.status).toBe(200);
    expect(syncSaleDmReaction).toHaveBeenCalledWith(expect.anything(), "r1");
    expect(pm.dmRecipientDraft.update.mock.invocationCallOrder[0])
      .toBeLessThan((syncSaleDmReaction as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
  });

  it("terminal でない更新(delivered)では Owner ロックを取らない・同期は常に呼ぶ", async () => {
    const res = await PATCH(req({ deliveryStatus: "delivered" }) as never, ctx());
    expect(res.status).toBe(200);
    expect(lockOwnersForUpdate).not.toHaveBeenCalled();
    expect(syncSaleDmReaction).toHaveBeenCalled();
  });

  it("宛先不明の解除でも汎用送付記録側に宛先不明が残っていれば物件フラグを消さない(整合)", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", propertyId: "p1", deliveryStatus: "returned_undeliverable",
      lpFirstAccessAt: null, phoneInquiryAt: null, status: "sent", campaign: { createdBy: "u1" },
    });
    pm.propertyDmLog.count.mockResolvedValueOnce(1); // 手動反響の宛先不明ログが残存
    const res = await PATCH(req({ deliveryStatus: "delivered" }) as never, ctx());
    expect(res.status).toBe(200);
    expect(pm.property.update).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.undeliverableCleared).toBe(false);
  });

  it("宛先不明から配達済み等へ訂正すると物件の dmUndeliverableAt を null クリア(dmStatus は据え置き)・監査", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", propertyId: "p1", deliveryStatus: "returned_undeliverable",
      lpFirstAccessAt: null, phoneInquiryAt: null, status: "sent", campaign: { createdBy: "u1" },
    });
    const res = await PATCH(req({ deliveryStatus: "delivered" }) as never, ctx());
    expect(res.status).toBe(200);
    // C2: 解除分岐では下書き行ロック + 物件行ロックの2回 FOR UPDATE(兄弟カウント前に物件を直列化)。
    expect(pm.$queryRaw).toHaveBeenCalledTimes(2);
    const propArg = pm.property.update.mock.calls[0][0];
    expect(propArg.where.id).toBe("p1");
    expect(propArg.data.dmUndeliverableAt).toBeNull();
    // dmStatus は人の判断で戻す(clear-undeliverable と同じ方針)ため自動では触らない。
    expect(propArg.data.dmStatus).toBeUndefined();
    const audit = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(audit.detail.undeliverableCleared).toBe(true);
  });

  it("同じ物件に未解決の宛先不明が他に残る場合は物件フラグを消さない(undeliverableCleared=false)", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", propertyId: "p1", deliveryStatus: "returned_undeliverable",
      lpFirstAccessAt: null, phoneInquiryAt: null, status: "sent", campaign: { createdBy: "u1" },
    });
    pm.dmRecipientDraft.count.mockResolvedValue(1); // 他に1件 returned_undeliverable が残存
    const res = await PATCH(req({ deliveryStatus: "delivered" }) as never, ctx());
    expect(res.status).toBe(200);
    expect(pm.property.update).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.undeliverableCleared).toBe(false);
  });

  it("宛先不明のまま(unchanged)や他状態間の訂正では物件を触らない", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", propertyId: "p1", deliveryStatus: "delivered",
      lpFirstAccessAt: null, phoneInquiryAt: null, status: "sent", campaign: { createdBy: "u1" },
    });
    const res = await PATCH(req({ deliveryStatus: "unknown" }) as never, ctx());
    expect(res.status).toBe(200);
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("不正な deliveryStatus は 422", async () => {
    const res = await PATCH(req({ deliveryStatus: "bogus" }) as never, ctx());
    expect(res.status).toBe(422);
  });

  it("不正な JSON ボディは 400(500 でなく)・更新しない", async () => {
    const res = await PATCH(new Request("http://x", { method: "PATCH", body: "{ broken" }) as never, ctx());
    expect(res.status).toBe(400);
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
  });

  it("存在しない draft は 404", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue(null);
    const res = await PATCH(req({ deliveryStatus: "delivered" }) as never, ctx());
    expect(res.status).toBe(404);
  });

  it("他人のキャンペーン配下の draft は 404・副作用なし(横断アクセス防止)", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", propertyId: "p1", deliveryStatus: "unknown", lpFirstAccessAt: null, phoneInquiryAt: null,
      status: "sent", campaign: { createdBy: "other-user" },
    });
    const res = await PATCH(req({ deliveryStatus: "delivered" }) as never, ctx());
    expect(res.status).toBe(404);
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("未送付(status!=sent)の draft への記録は 409・物件を触らない", async () => {
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", propertyId: "p1", deliveryStatus: "unknown", lpFirstAccessAt: null, phoneInquiryAt: null,
      status: "confirmed", campaign: { createdBy: "u1" },
    });
    const res = await PATCH(req({ deliveryStatus: "returned_undeliverable" }) as never, ctx());
    expect(res.status).toBe(409);
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("権限不足(requireSaleDmAccess が 403 throw)で 403・副作用なし", async () => {
    class MockApiError extends Error {
      status = 403;
      code = "FORBIDDEN";
    }
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new MockApiError("x"), { status: 403, code: "FORBIDDEN" }),
    );
    const res = await PATCH(req({ deliveryStatus: "delivered" }) as never, ctx());
    expect(res.status).toBe(403);
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("property:write 不足だと宛先不明連動(returned_undeliverable)は 403・副作用なし", async () => {
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1" }, permissions: [{ resource: "property", action: "write", granted: false }] });
    const res = await PATCH(req({ deliveryStatus: "returned_undeliverable" }) as never, ctx());
    expect(res.status).toBe(403);
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("property:write 不足は物件連動しない記録(delivered/電話)も 403(全outcome更新にwrite必須=権限失効後の集計汚染防止)", async () => {
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1" }, permissions: [{ resource: "property", action: "write", granted: false }] });
    const res = await PATCH(req({ deliveryStatus: "delivered" }) as never, ctx());
    expect(res.status).toBe(403);
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("property:write 不足は電話反響の記録も 403(下書きの delivery/response 書込を許さない)", async () => {
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1" }, permissions: [{ resource: "property", action: "write", granted: false }] });
    const res = await PATCH(req({ phoneInquiry: true }) as never, ctx());
    expect(res.status).toBe(403);
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
  });

  it("field_staff が作成/担当でない物件への宛先不明連動は 403・副作用なし(物件 record scope)", async () => {
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1", role: "field_staff" }, permissions: [{ resource: "property", action: "write", granted: true }] });
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", propertyId: "p1", deliveryStatus: "unknown", lpFirstAccessAt: null, phoneInquiryAt: null,
      status: "sent", campaign: { createdBy: "u1" }, property: { createdBy: "other", assignedTo: "other" },
    });
    const res = await PATCH(req({ deliveryStatus: "returned_undeliverable" }) as never, ctx());
    expect(res.status).toBe(403);
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("field_staff でも担当物件なら宛先不明連動できる(200)", async () => {
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1", role: "field_staff" }, permissions: [{ resource: "property", action: "write", granted: true }] });
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", propertyId: "p1", deliveryStatus: "unknown", lpFirstAccessAt: null, phoneInquiryAt: null,
      status: "sent", campaign: { createdBy: "u1" }, property: { createdBy: "other", assignedTo: "u1" },
    });
    const res = await PATCH(req({ deliveryStatus: "returned_undeliverable" }) as never, ctx());
    expect(res.status).toBe(200);
    expect(pm.property.update).toHaveBeenCalled();
  });

  it("field_staff の担当外宛先は status(409)より先に 403(未送付の送付状態を漏らさない・順序統一)", async () => {
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1", role: "field_staff" }, permissions: [{ resource: "property", action: "write", granted: true }] });
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", propertyId: "p1", deliveryStatus: "unknown", lpFirstAccessAt: null, phoneInquiryAt: null,
      status: "draft", // 未送付=従来は status チェックが先で 409 を返し、担当外でも送付状態を漏らしていた
      campaign: { createdBy: "u1" }, property: { createdBy: "other", assignedTo: "other" },
    });
    const res = await PATCH(req({ deliveryStatus: "delivered" }) as never, ctx());
    expect(res.status).toBe(403); // 409 ではない(認可を状態より先に判定)
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
  });

  it("field_staff は担当外物件の宛先には配達結果も記録できない(403・record scope を全 outcome 更新に適用)", async () => {
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1", role: "field_staff" }, permissions: [{ resource: "property", action: "write", granted: true }] });
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", propertyId: "p1", deliveryStatus: "unknown", lpFirstAccessAt: null, phoneInquiryAt: null,
      status: "sent", campaign: { createdBy: "u1" }, property: { createdBy: "other", assignedTo: "other" },
    });
    const res = await PATCH(req({ deliveryStatus: "delivered" }) as never, ctx());
    expect(res.status).toBe(403);
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
    expect(pm.property.update).not.toHaveBeenCalled();
  });

  it("field_staff は担当外物件の宛先には電話反響も記録できない(403)", async () => {
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1", role: "field_staff" }, permissions: [{ resource: "property", action: "write", granted: true }] });
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", propertyId: "p1", deliveryStatus: "unknown", lpFirstAccessAt: null, phoneInquiryAt: null,
      status: "sent", campaign: { createdBy: "u1" }, property: { createdBy: "other", assignedTo: "other" },
    });
    const res = await PATCH(req({ phoneInquiry: true }) as never, ctx());
    expect(res.status).toBe(403);
    expect(pm.dmRecipientDraft.update).not.toHaveBeenCalled();
  });

  it("field_staff でも担当物件なら配達結果を記録できる(200)", async () => {
    (requireSaleDmAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: "u1", role: "field_staff" }, permissions: [{ resource: "property", action: "write", granted: true }] });
    pm.dmRecipientDraft.findUnique.mockResolvedValue({
      id: "r1", propertyId: "p1", deliveryStatus: "unknown", lpFirstAccessAt: null, phoneInquiryAt: null,
      status: "sent", campaign: { createdBy: "u1" }, property: { createdBy: "other", assignedTo: "u1" },
    });
    const res = await PATCH(req({ deliveryStatus: "delivered" }) as never, ctx());
    expect(res.status).toBe(200);
    expect(pm.dmRecipientDraft.update).toHaveBeenCalled();
  });
});
