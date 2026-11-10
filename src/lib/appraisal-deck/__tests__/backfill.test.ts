import { describe, it, expect, vi } from "vitest";
import { backfillAppraisalDrafts, type BackfillDeps } from "../backfill";

const deps = (over: Partial<BackfillDeps> = {}): BackfillDeps => ({
  listReports: async () => [
    { id: "a1", targetId: "p1", uploadedBy: "u1" },
    { id: "a2", targetId: "p2", uploadedBy: "u2" },
    { id: "a3", targetId: "p3", uploadedBy: "u3" },
    { id: "a4", targetId: "p4", uploadedBy: "u4" },
  ],
  listDeckSources: async () => ["a2"],
  build: vi.fn(async ({ attachmentId }) =>
    attachmentId === "a3" ? { ok: false as const, reason: "not_sre" as const } : { ok: true as const, deckId: "d-" + attachmentId, created: true },
  ),
  ...over,
});

describe("backfillAppraisalDrafts(反映前の査定報告書から下書きを一括で作る)", () => {
  it("dry-run は件数だけ(読まない・作らない)", async () => {
    const d = deps();
    expect(await backfillAppraisalDrafts(d, { apply: false })).toEqual({ targets: 3, created: 0, existing: 0, failed: {} });
    expect(d.build).not.toHaveBeenCalled();
  });

  it("既に下書きがある報告書は飛ばし、残りを1本ずつ順に作る(添付した人を作成者に)", async () => {
    const order: string[] = [];
    let running = 0;
    const d = deps({
      build: vi.fn(async ({ attachmentId }) => {
        running++;
        expect(running).toBe(1); // 同時に読まない
        order.push(attachmentId);
        await new Promise((r) => setTimeout(r, 1));
        running--;
        return attachmentId === "a3" ? { ok: false as const, reason: "not_sre" as const } : { ok: true as const, deckId: "d", created: true };
      }),
    });
    const r = await backfillAppraisalDrafts(d, { apply: true });
    expect(order).toEqual(["a1", "a3", "a4"]);
    expect(d.build).toHaveBeenCalledWith({ attachmentId: "a1", propertyId: "p1", userId: "u1" });
    expect(r).toEqual({ targets: 3, created: 2, existing: 0, failed: { not_sre: ["a3"] } });
  });

  it("1件が例外で落ちても残りは続け、読み取れなかったとして数える", async () => {
    const d = deps({
      build: vi.fn(async ({ attachmentId }) => {
        if (attachmentId === "a1") throw new Error("東京都架空区見本町4丁目");
        return { ok: true as const, deckId: "d", created: false };
      }),
    });
    const r = await backfillAppraisalDrafts(d, { apply: true });
    expect(r).toEqual({ targets: 3, created: 0, existing: 2, failed: { read_failed: ["a1"] } });
    expect(JSON.stringify(r)).not.toContain("見本町");
  });
});
