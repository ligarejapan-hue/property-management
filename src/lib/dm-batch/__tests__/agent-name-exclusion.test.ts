import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@/generated/prisma";
import { agentNameKeySql, findAgentNameOwnerIds } from "../agent-name-exclusion";
import { NAME_VARIANTS } from "@/lib/name-variants";

// 業者と同じ名前の所有者には DM を送らない(2026-11-09 発注者指示)。
// ⚠名前のそろえ方は SQL の式1つを所有者・業者の両側に当てる(手元の PostgreSQL 16 で
//   「株式会社 ＡＢＣ不動産」「㈱ABC不動産」「(株)abc不動産」→ 同じ・「ＡＢＣ不動産(株)」は別・髙橋=高橋 を実測)。

describe("agentNameKeySql", () => {
  const sql = agentNameKeySql(Prisma.sql`o.name`);
  it("NFKC・空白を除く・小文字・(株)(有)(同)・異体字の順でそろえる", () => {
    expect(sql.sql).toContain("normalize(coalesce(o.name, ''), NFKC)");
    expect(sql.sql).toContain("regexp_replace(");
    expect(sql.sql).toContain("'\\s+', '', 'g'");
    expect(sql.sql).toContain("lower(");
    expect(sql.sql).toContain("'(株)', '株式会社'");
    expect(sql.sql).toContain("'(有)', '有限会社'");
    expect(sql.sql).toContain("'(同)', '合同会社'");
    expect(sql.sql.startsWith("translate(")).toBe(true);
    // 異体字の表(name-variants.ts)から作る。translate は1字ずつなので、左右の字数(符号位置の数)が同じこと。
    expect(sql.values).toEqual([Object.keys(NAME_VARIANTS).join(""), Object.values(NAME_VARIANTS).join("")]);
    const [from, to] = sql.values as string[];
    expect(Array.from(from).length).toBe(Array.from(to).length);
    expect(from.startsWith("髙﨑")).toBe(true);
  });
});

describe("findAgentNameOwnerIds", () => {
  it("所有者がいなければ DB を引かない", async () => {
    const $queryRaw = vi.fn();
    expect((await findAgentNameOwnerIds({ $queryRaw } as never, [])).size).toBe(0);
    expect($queryRaw).not.toHaveBeenCalled();
  });
  it("名簿(使っているものだけ)と国交省の一覧(全行)の両方と照合し、空の名前は一致にしない", async () => {
    const $queryRaw = vi.fn(async () => [{ id: "o1" }]);
    const got = await findAgentNameOwnerIds({ $queryRaw } as never, ["o2", "o1", "o1"]);
    expect([...got]).toEqual(["o1"]);
    const q = ($queryRaw.mock.calls[0] as unknown as [Prisma.Sql])[0];
    expect(q.sql).toContain("FROM agents a WHERE a.is_archived = false");
    expect(q.sql).toContain("FROM mlit_agents m)");
    expect(q.sql).toContain("k.key <> ''");
    // 所有者は重複を除いて渡す
    expect(q.values.filter((v) => v === "o1" || v === "o2")).toEqual(["o1", "o2"]);
  });
});
