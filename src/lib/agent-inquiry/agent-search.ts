import prisma from "@/lib/prisma";
import { classifyAgentQuery } from "./agent-query";
import { widthVariants } from "./desk-property";

const LIMIT = 20;
const LIST_PAGE = 50;

export interface AgentListRow {
  id: string;
  companyName: string;
  branchName: string | null;
  phone: string;
  isArchived: boolean;
  inquiryCount: number;
  lastReceivedAt: Date | null;
}

/**
 * 業者の名簿の一覧(設計 §2.3 の名簿画面・名前順・カーソル式)。反響件数と最終日つき。
 * archived=true でしまった業者だけを出す=しまった業者を見つけて戻せる(レビュー Important 3)。
 */
export async function listAgents(opts: { archived: boolean; cursor?: string }) {
  const rows = await prisma.agent.findMany({
    where: { isArchived: opts.archived },
    orderBy: [{ companyName: "asc" }, { id: "asc" }],
    take: LIST_PAGE + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      companyName: true,
      branchName: true,
      phone: true,
      isArchived: true,
      _count: { select: { inquiries: true } },
      inquiries: { orderBy: { receivedAt: "desc" }, take: 1, select: { receivedAt: true } },
    },
  });
  const agents: AgentListRow[] = rows.slice(0, LIST_PAGE).map(({ _count, inquiries, ...r }) => ({
    ...r,
    inquiryCount: _count.inquiries,
    lastReceivedAt: inquiries[0]?.receivedAt ?? null,
  }));
  return { agents, nextCursor: rows.length > LIST_PAGE ? agents[agents.length - 1].id : null };
}

export interface AgentHit {
  id: string;
  companyName: string;
  branchName: string | null;
  phone: string;
  lastContact: { name: string | null; mobile: string | null; email: string | null } | null;
  matchedBy: "phone" | "mobile" | "text";
}

type Row = {
  id: string;
  company_name: string;
  branch_name: string | null;
  phone: string;
  c_name: string | null;
  c_mobile: string | null;
  c_email: string | null;
  matched_by: "phone" | "mobile";
};

/**
 * 業者検索(設計 §2.2-1)。
 * - 数字(7桁以上)=代表電話と過去の反響の携帯を数字だけで照合(打ちかけ・ハイフンの有無でも当たる)。
 *   regexp_replace は index が効かないので 7 桁以上のときだけ・件数上限の前にしまった業者を外す。
 *   携帯で当たったら、**その携帯で問い合わせてきた人**の最新の反響の名前・携帯・メールを返す(フォームを
 *   前回の値で埋めるため)。⚠業者全体の最新の反響ではない=同じ会社の別の担当者の名前を埋めない
 *   (電話をかけてきた本人の情報が要る・@codex #454 R5 の指摘は意図どおりとして据え置き)。
 * - 文字=商号・ふりがな・支店の部分一致。
 */
export async function searchAgents(q: string): Promise<AgentHit[]> {
  const cq = classifyAgentQuery(q);
  if (cq.type === "none") return [];
  if (cq.type === "text") {
    const rows = await prisma.agent.findMany({
      where: {
        isArchived: false,
        // 全角/半角の候補ごとに OR(DB の商号は正規化していない=「ＡＢＣ不動産」も「ABC」で当てる)。
        OR: widthVariants(cq.text).flatMap((v) => [
          { companyName: { contains: v, mode: "insensitive" as const } },
          { companyKana: { contains: v, mode: "insensitive" as const } },
          { branchName: { contains: v, mode: "insensitive" as const } },
        ]),
      },
      select: { id: true, companyName: true, branchName: true, phone: true },
      orderBy: { companyName: "asc" },
      take: LIMIT,
    });
    return rows.map((r) => ({ ...r, lastContact: null, matchedBy: "text" as const }));
  }
  const like = `%${cq.digits}%`;
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT * FROM (
      SELECT a.id, a.company_name, a.branch_name, a.phone,
             NULL::text AS c_name, NULL::text AS c_mobile, NULL::text AS c_email, 'phone' AS matched_by
      FROM "agents" a
      WHERE a.is_archived = false
        AND regexp_replace(a.phone, '[^0-9]', '', 'g') LIKE ${like}
      LIMIT ${LIMIT}
    ) p
    UNION ALL
    SELECT * FROM (
      SELECT DISTINCT ON (a.id) a.id, a.company_name, a.branch_name, a.phone,
             i.contact_name AS c_name, i.contact_mobile AS c_mobile, i.contact_email AS c_email, 'mobile' AS matched_by
      FROM "agent_inquiries" i JOIN "agents" a ON a.id = i.agent_id
      WHERE a.is_archived = false
        AND regexp_replace(coalesce(i.contact_mobile, ''), '[^0-9]', '', 'g') LIKE ${like}
      ORDER BY a.id, i.received_at DESC
      LIMIT ${LIMIT}
    ) m
  `;
  // 同じ業者が代表電話と携帯の両方で当たったら携帯側(問い合わせ者を埋められる)を残す。
  const byId = new Map<string, AgentHit>();
  for (const r of rows) {
    const hit: AgentHit = {
      id: r.id,
      companyName: r.company_name,
      branchName: r.branch_name,
      phone: r.phone,
      lastContact: r.matched_by === "mobile" ? { name: r.c_name, mobile: r.c_mobile, email: r.c_email } : null,
      matchedBy: r.matched_by,
    };
    const prev = byId.get(r.id);
    if (!prev || (prev.matchedBy === "phone" && hit.matchedBy === "mobile")) byId.set(r.id, hit);
  }
  return [...byId.values()].slice(0, LIMIT);
}
