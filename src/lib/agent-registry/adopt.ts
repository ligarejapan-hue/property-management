import { Prisma } from "@/generated/prisma";
import prisma from "@/lib/prisma";
import type { AgentHit } from "@/lib/agent-inquiry/agent-search";
import { widthVariants } from "@/lib/agent-inquiry/desk-property";
import { licenseKeyFromText } from "./parse";

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
    // 一覧から外れた・電話が無い・詳細の取り直し待ち(古い電話のままかもしれない)は写さない(@codex #477)。
    if (!reg || !reg.listed || !reg.phone || !reg.phoneDigits || reg.needsDetail) {
      return { ok: false, reason: "unavailable" } as const;
    }
    // 一覧の行のロックは同じ行どうしだけ。代表電話が同じ別の会社(グループ会社)の写しも1本ずつにするため、
    // 電話の数字で取引の終わりまで続く鍵をかけてから名簿を見る(@codex #477)。
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`agent-phone:${reg.phoneDigits}`}))`);

    const linked = await tx.agent.findFirst({
      where: { mlitAgentId, isArchived: false },
      orderBy: { createdAt: "asc" },
      select: HIT_SELECT,
    });
    if (linked) return { ok: true, created: false, agent: toHit(linked) } as const;

    // 名簿に同じ免許番号の業者(手入力で電話が古い等)があればそれを使う(@codex #477)。
    // 手入力の免許番号は書き方がまちまち=番号の数字(半角・全角)で候補を拾い、文字から鍵を作って照らす。
    // ⚠件数で切らない(第1号のような小さい番号は「1」を含む業者が多い=切ると本物を取りこぼして二重に作る・
    // @codex #477)。名簿は実際に関わった業者だけなので、全部見ても軽い。
    const num = String(Number(reg.licenseKey.slice(2)));
    const byLicense = await tx.agent.findMany({
      where: { isArchived: false, OR: widthVariants(num).map((v) => ({ licenseNo: { contains: v } })) },
      orderBy: { createdAt: "asc" },
      select: { id: true, licenseNo: true, mlitAgentId: true },
    });
    const sameLicense = byLicense.find((c) => c.licenseNo && licenseKeyFromText(c.licenseNo) === reg.licenseKey);
    if (sameLicense) {
      if (sameLicense.mlitAgentId && sameLicense.mlitAgentId !== mlitAgentId) {
        const a = await tx.agent.findUnique({ where: { id: sameLicense.id }, select: HIT_SELECT });
        if (a) return { ok: true, created: false, agent: toHit(a) } as const;
      }
      const a = await tx.agent.update({ where: { id: sameLicense.id }, data: { mlitAgentId }, select: HIT_SELECT });
      return { ok: true, created: false, agent: toHit(a) } as const;
    }

    const samePhone = await tx.$queryRaw<{ id: string; mlit_agent_id: string | null }[]>(Prisma.sql`
      SELECT id, mlit_agent_id FROM "agents"
      WHERE is_archived = false AND regexp_replace(phone, '[^0-9]', '', 'g') = ${reg.phoneDigits}
      ORDER BY created_at ASC
      LIMIT 1
    `);
    if (samePhone[0]) {
      // すでに別の一覧の会社と結び付いている(グループ会社で代表電話が同じ等)なら書き換えず、その業者を返すだけ。
      if (samePhone[0].mlit_agent_id) {
        const a = await tx.agent.findUnique({ where: { id: samePhone[0].id }, select: HIT_SELECT });
        if (a) return { ok: true, created: false, agent: toHit(a) } as const;
      }
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
