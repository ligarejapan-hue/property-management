import { Prisma } from "@/generated/prisma";
import prisma from "@/lib/prisma";
import type { AgentHit } from "@/lib/agent-inquiry/agent-search";

/**
 * 国交省の一覧の会社を名簿へ写す(計画 Task 6)。受付の窓で一覧の候補を選んだときだけ呼ぶ。
 * 1. 名簿に写し済み(しまっていない)→ それを返す
 * 2. 名簿に同じ代表電話の業者(しまっていない)→ それに元の行を覚えさせて返す
 * 3. どちらも無い → 一覧の値で名簿に作る(登録者=押した人)
 * 同時に2回押されても1件: 先に一覧の行をロックし、名簿はロックを取ってから読む。
 */
export type AdoptResult =
  | { ok: true; created: boolean; agent: AgentHit }
  | { ok: false; reason: "not_found" | "unavailable" };

const HIT_SELECT = { id: true, companyName: true, branchName: true, phone: true } as const;

const toHit = (a: { id: string; companyName: string; branchName: string | null; phone: string }): AgentHit => ({
  ...a,
  lastContact: null,
  matchedBy: "text",
});

export async function adoptRegistryAgent(mlitAgentId: string, userId: string): Promise<AdoptResult> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT id FROM "mlit_agents" WHERE id = ${mlitAgentId}::uuid FOR UPDATE`,
    );
    if (locked.length === 0) return { ok: false, reason: "not_found" } as const;
    const reg = await tx.mlitAgent.findUnique({ where: { id: mlitAgentId } });
    if (!reg || !reg.listed || !reg.phone || !reg.phoneDigits) return { ok: false, reason: "unavailable" } as const;

    const linked = await tx.agent.findFirst({
      where: { mlitAgentId, isArchived: false },
      orderBy: { createdAt: "asc" },
      select: HIT_SELECT,
    });
    if (linked) return { ok: true, created: false, agent: toHit(linked) } as const;

    const samePhone = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM "agents"
      WHERE is_archived = false AND regexp_replace(phone, '[^0-9]', '', 'g') = ${reg.phoneDigits}
      ORDER BY created_at ASC
      LIMIT 1
    `);
    if (samePhone[0]) {
      const a = await tx.agent.update({
        where: { id: samePhone[0].id },
        data: { mlitAgentId },
        select: HIT_SELECT,
      });
      return { ok: true, created: false, agent: toHit(a) } as const;
    }

    const created = await tx.agent.create({
      data: {
        companyName: reg.companyName,
        companyKana: reg.companyKana,
        licenseNo: reg.licenseLabel,
        address: reg.address,
        phone: reg.phone,
        createdById: userId,
        mlitAgentId,
      },
      select: HIT_SELECT,
    });
    return { ok: true, created: true, agent: toHit(created) } as const;
  });
}
