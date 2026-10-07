import { Prisma } from "@/generated/prisma";
import prisma from "@/lib/prisma";
import { agentQueryReady, classifyAgentQuery } from "@/lib/agent-inquiry/agent-query";
import { widthVariants } from "@/lib/agent-inquiry/desk-property";

/**
 * 受付の窓で、名簿に無い会社を国交省の一覧から探す(計画 Task 6)。
 * - 一覧に載っている(listed)・電話がある・詳細を取り終えた(needs_detail=false)会社だけ。
 * - 名簿に写し済み(agents.mlit_agent_id)・名簿に同じ代表電話の業者がある会社は出さない(二重の候補にしない)。
 * - 返すのは会社名・代表電話・免許の表示だけ。
 */

export const REGISTRY_LIMIT = 10;

export interface RegistryHit {
  id: string;
  companyName: string;
  phone: string;
  licenseLabel: string;
}

const toKatakana = (s: string) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

/** 全角/半角の両方と、ひらがなで打ったときのカタカナ(一覧のふりがなはカタカナ)。 */
export function registryQueryVariants(text: string): string[] {
  const base = widthVariants(text);
  return [...new Set([...base, ...base.map(toKatakana)])];
}

type Row = { id: string; company_name: string; phone: string; license_label: string };

export async function searchRegistry(q: string): Promise<RegistryHit[]> {
  // 打ちかけの電話番号(6桁以下)を会社名として探さない(受付の窓の探し方と同じ)。
  if (!agentQueryReady(q)) return [];
  const cq = classifyAgentQuery(q);
  if (cq.type === "none") return [];
  const match =
    cq.type === "digits"
      ? Prisma.sql`m.phone_digits LIKE ${`%${cq.digits}%`}`
      : (() => {
          const patterns = registryQueryVariants(cq.text).map((v) => `%${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
          return Prisma.sql`(m.company_name ILIKE ANY (${patterns}) OR m.company_kana ILIKE ANY (${patterns}))`;
        })();
  const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
    SELECT m.id, m.company_name, m.phone, m.license_label
    FROM "mlit_agents" m
    WHERE m.listed = true
      AND m.phone_digits IS NOT NULL
      -- 詳細の取り直し待ち(電話・ふりがなが古いかもしれない)は出さない=古い連絡先を名簿へ写さない(@codex #477)
      AND m.needs_detail = false
      AND ${match}
      AND NOT EXISTS (
        SELECT 1 FROM "agents" a
        WHERE a.is_archived = false
          AND (a.mlit_agent_id = m.id OR regexp_replace(a.phone, '[^0-9]', '', 'g') = m.phone_digits)
      )
    ORDER BY m.company_name
    LIMIT ${REGISTRY_LIMIT}
  `);
  return rows.map((r) => ({ id: r.id, companyName: r.company_name, phone: r.phone, licenseLabel: r.license_label }));
}
