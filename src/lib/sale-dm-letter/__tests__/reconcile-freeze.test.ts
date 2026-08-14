import { describe, it, expect, vi } from "vitest";
import { reconcileTemplateFreeze } from "../reconcile-freeze";

// 反映(restart)後に1回流す冪等スクリプトの中身（設計 §2.4 @codex R16/R21）。
// migration では埋めない: migrate→restart の窓で、凍結を知らない旧ルートが
// 凍結済みの型を書き換え・削除できてしまうため。

function client(variants: Array<{ id: string; drafts: Array<{ status: string; confirmedAt: Date | null; sentAt: Date | null }> }>) {
  const updated: Array<{ id: string; at: Date }> = [];
  return {
    updated,
    dmVariant: {
      findMany: vi.fn(async () =>
        variants.map((v) => ({
          id: v.id,
          recipients: v.drafts.map((d) => ({
            confirmedAt: d.confirmedAt,
            sentAt: d.sentAt,
          })),
        })),
      ),
      update: vi.fn(async (args: { where: { id: string }; data: { templateFrozenAt: Date } }) => {
        updated.push({ id: args.where.id, at: args.data.templateFrozenAt });
        return { id: args.where.id };
      }),
    },
  };
}

const D1 = new Date("2026-07-01T00:00:00.000Z");
const D2 = new Date("2026-08-01T00:00:00.000Z");

describe("reconcileTemplateFreeze", () => {
  it("dry-run は何も書かず、対象の件数だけ返す", async () => {
    const c = client([
      { id: "v1", drafts: [{ status: "confirmed", confirmedAt: D2, sentAt: null }] },
    ]);
    const r = await reconcileTemplateFreeze(c as never, { apply: false });
    expect(r.candidates).toBe(1);
    expect(r.updated).toBe(0);
    expect(c.dmVariant.update).not.toHaveBeenCalled();
  });

  it("確定/送付の一番古い日時を凍結印にする", async () => {
    const c = client([
      {
        id: "v1",
        drafts: [
          { status: "sent", confirmedAt: D2, sentAt: D2 },
          { status: "confirmed", confirmedAt: D1, sentAt: null },
        ],
      },
    ]);
    await reconcileTemplateFreeze(c as never, { apply: true });
    expect(c.updated).toEqual([{ id: "v1", at: D1 }]);
  });

  it("日時が無ければ実行時刻を使う(証拠はあるので凍結はする)", async () => {
    const now = new Date("2026-08-14T00:00:00.000Z");
    const c = client([
      { id: "v1", drafts: [{ status: "confirmed", confirmedAt: null, sentAt: null }] },
    ]);
    await reconcileTemplateFreeze(c as never, { apply: true, now });
    expect(c.updated).toEqual([{ id: "v1", at: now }]);
  });

  it("対象が無ければ何もしない", async () => {
    const c = client([]);
    const r = await reconcileTemplateFreeze(c as never, { apply: true });
    expect(r).toEqual({ candidates: 0, updated: 0 });
  });

  it("2回流しても結果が変わらない(冪等)", async () => {
    const c = client([
      { id: "v1", drafts: [{ status: "confirmed", confirmedAt: D1, sentAt: null }] },
    ]);
    await reconcileTemplateFreeze(c as never, { apply: true });
    // 1回目で印が付いた前提＝2回目は候補に出ない（クエリが未設定のみを拾う）
    c.dmVariant.findMany.mockResolvedValueOnce([]);
    const r2 = await reconcileTemplateFreeze(c as never, { apply: true });
    expect(r2).toEqual({ candidates: 0, updated: 0 });
    expect(c.updated).toHaveLength(1);
  });

  it("未設定の型だけを拾うクエリになっている(既に立っている印を上書きしない)", async () => {
    const c = client([]);
    await reconcileTemplateFreeze(c as never, { apply: true });
    const call = c.dmVariant.findMany.mock.calls[0] as unknown as [
      { where: Record<string, unknown> },
    ];
    const where = call[0].where;
    expect(where.templateFrozenAt).toBeNull();
  });
});
