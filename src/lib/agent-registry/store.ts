import prisma from "@/lib/prisma";
import type { CrawlPhase, CrawlState, CrawlStore } from "./crawl";
import type { Detail, ListRow } from "./parse";

/**
 * 進め方(crawl.ts)が使う保存の prisma 版。
 * - 一覧の行は免許の鍵で upsert。新しい会社・商号/所在地/免許の表示が変わった会社だけ詳細を取り直す。
 * - 所在地は一覧の値を正にする(詳細の書き方の違いで毎月「変わった」と判定しないため)。
 *   一覧に所在地が無いときだけ詳細の値で埋める。
 */
export function createPrismaCrawlStore(): CrawlStore {
  return {
    async loadStates() {
      const rows = await prisma.mlitCrawlState.findMany();
      return rows.map((r) => ({ ...r, phase: r.phase as CrawlPhase }));
    },

    async saveStates(states: CrawlState[]) {
      await prisma.$transaction(
        states.map((s) => {
          const data = {
            cycle: s.cycle,
            phase: s.phase,
            nextPage: s.nextPage,
            totalPages: s.totalPages,
            failStreak: s.failStreak,
            dayOffUntil: s.dayOffUntil,
            lastError: s.lastError,
            lastRunAt: s.lastRunAt,
          };
          return prisma.mlitCrawlState.upsert({
            where: { authority: s.authority },
            create: { authority: s.authority, ...data },
            update: data,
          });
        }),
      );
    },

    async upsertListRows(rows: ListRow[], cycle: string) {
      if (rows.length === 0) return 0;
      const existing = await prisma.mlitAgent.findMany({
        where: { licenseKey: { in: rows.map((r) => r.licenseKey) } },
        select: { licenseKey: true, companyName: true, address: true, licenseLabel: true },
      });
      const prev = new Map(existing.map((e) => [e.licenseKey, e]));
      await prisma.$transaction(
        rows.map((r) => {
          const p = prev.get(r.licenseKey);
          const changed =
            !p || p.companyName !== r.companyName || p.address !== r.address || p.licenseLabel !== r.licenseLabel;
          const listFields = {
            authority: r.authority,
            licenseLabel: r.licenseLabel,
            companyName: r.companyName,
            address: r.address,
            listed: true,
            seenCycle: cycle,
          };
          return prisma.mlitAgent.upsert({
            where: { licenseKey: r.licenseKey },
            create: { licenseKey: r.licenseKey, ...listFields, needsDetail: true },
            update: changed ? { ...listFields, needsDetail: true } : listFields,
          });
        }),
      );
      return rows.length;
    },

    async nextNeedingDetail(cycle: string, limit: number) {
      const rows = await prisma.mlitAgent.findMany({
        where: { needsDetail: true, listed: true, seenCycle: cycle },
        orderBy: { licenseKey: "asc" },
        take: limit,
        select: { licenseKey: true },
      });
      return rows.map((r) => r.licenseKey);
    },

    async saveDetail(d: Detail, at: Date) {
      const digits = d.phone?.replace(/\D/g, "") ?? "";
      await prisma.mlitAgent.updateMany({
        where: { licenseKey: d.licenseKey },
        data: {
          companyKana: d.companyKana,
          phone: d.phone,
          phoneDigits: digits || null,
          validUntil: d.validUntil,
          needsDetail: false,
          detailAt: at,
        },
      });
      if (d.address) {
        await prisma.mlitAgent.updateMany({
          where: { licenseKey: d.licenseKey, address: null },
          data: { address: d.address },
        });
      }
    },

    async closeCycle(cycle: string) {
      const res = await prisma.mlitAgent.updateMany({
        where: { listed: true, OR: [{ seenCycle: { not: cycle } }, { seenCycle: null }] },
        data: { listed: false },
      });
      return res.count;
    },
  };
}
