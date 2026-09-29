/**
 * まとめ取込の「書き込みを止める」ための重複確認(@codex PR#456 7巡目)。
 * ⚠見る人の権限・担当で絞らない(担当外の物件も数える)。住所や氏名は返さず件数だけ。
 * ⚠渡されたクライアント(=登録のトランザクション)だけでDBを引く。
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy({}, { get: () => { throw new Error("global prisma must not be used"); } }),
}));

import { countPasteDuplicatesUnscoped } from "../paste-import-duplicates";

function fakeDb(props: { id: string; address: string; lotNumber: string | null }[], owners: { name: string }[]) {
  const calls: string[] = [];
  return {
    calls,
    db: {
      property: {
        findMany: vi.fn(async () => {
          calls.push("property.findMany");
          return props.map((p) => ({ ...p, externalLinkKey: null }));
        }),
      },
      owner: {
        findMany: vi.fn(async () => {
          calls.push("owner.findMany");
          return owners.map((o, i) => ({ id: `o${i}`, name: o.name }));
        }),
      },
    },
  };
}

const input = {
  address: "東京都港区1-1",
  lotNumber: null,
  ownerName: "渡辺　一",
};

describe("countPasteDuplicatesUnscoped", () => {
  it("★担当や権限に関係なく、同じ住所の物件・同じ名前の所有者を数える", async () => {
    const { db } = fakeDb(
      [{ id: "p1", address: "東京都港区１－１", lotNumber: null }, { id: "p2", address: "東京都港区9-9", lotNumber: null }],
      [{ name: "渡辺一" }, { name: "渡辺　二" }],
    );
    const r = await countPasteDuplicatesUnscoped(db as never, input);
    expect(r).toEqual({ similarCount: 1, ownerCount: 1, truncated: false });
  });

  it("★グローバルの prisma を使わず、渡されたクライアントだけを使う(接続を奪い合わない)", async () => {
    const { db, calls } = fakeDb([], []);
    await countPasteDuplicatesUnscoped(db as never, input);
    expect(calls).toEqual(["property.findMany", "owner.findMany"]);
  });

  it("候補を取りきれなかったら truncated(「無い」と同じ顔をさせない)", async () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, address: `東京都港区${i}`, lotNumber: null }));
    const { db } = fakeDb(many, []);
    expect((await countPasteDuplicatesUnscoped(db as never, input)).truncated).toBe(true);
  });

  it("住所・氏名が空なら引かない", async () => {
    const { db, calls } = fakeDb([], []);
    expect(await countPasteDuplicatesUnscoped(db as never, { address: null, lotNumber: null, ownerName: "" }))
      .toEqual({ similarCount: 0, ownerCount: 0, truncated: false });
    expect(calls).toEqual([]);
  });
});
