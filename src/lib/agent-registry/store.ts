import prisma from "@/lib/prisma";
import type { CrawlPhase, CrawlState, CrawlStore } from "./crawl";
import type { Detail, ListRow } from "./parse";

/** 詳細を取ってからこれだけたった会社は取り直す(電話番号だけの変更は一覧に出ないため)。 */
export const DETAIL_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
/** 詳細がこの回数読めなかった会社は、その一巡では諦める。 */
export const DETAIL_FAIL_LIMIT = 3;

/**
 * 進め方(crawl.ts)が使う保存の prisma 版。
 * - 一覧の行は免許の鍵で upsert。新しい会社・商号/本店の所在地/免許の表示が変わった会社・
 *   詳細を取ってから1年たった会社だけ詳細を取り直す。
 * - 所在地は**本店の行**の値だけで書く(大きな会社は事務所の行がページをまたぐ=支店の行だけの
 *   ページで本店の所在地を上書きしない・それを「変わった」と数えて毎月取り直さない)。
 * - 所在地は一覧の値を正にする(詳細の書き方の違いで毎月「変わった」と判定しないため)。
 *   一覧に所在地が無いときだけ詳細の値で埋める。
 */
export function createPrismaCrawlStore(now: () => Date = () => new Date()): CrawlStore {
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
        select: { licenseKey: true, companyName: true, address: true, licenseLabel: true, seenCycle: true, detailAt: true },
      });
      const prev = new Map(existing.map((e) => [e.licenseKey, e]));
      const staleBefore = now().getTime() - DETAIL_MAX_AGE_MS;
      await prisma.$transaction(
        rows.map((r) => {
          const p = prev.get(r.licenseKey);
          const changed =
            !p ||
            p.companyName !== r.companyName ||
            p.licenseLabel !== r.licenseLabel ||
            (r.isMain && p.address !== r.address);
          const stale = !!p?.detailAt && p.detailAt.getTime() < staleBefore;
          const update: Record<string, unknown> = {
            authority: r.authority,
            licenseLabel: r.licenseLabel,
            companyName: r.companyName,
            listed: true,
            seenCycle: cycle,
          };
          if (r.isMain) update.address = r.address;
          if (changed || stale) update.needsDetail = true;
          // この一巡で初めて見た=前の一巡で詳細を諦めた会社も、もう一度試す。
          if (p && p.seenCycle !== cycle) update.detailFailCount = 0;
          return prisma.mlitAgent.upsert({
            where: { licenseKey: r.licenseKey },
            create: {
              licenseKey: r.licenseKey,
              authority: r.authority,
              licenseLabel: r.licenseLabel,
              companyName: r.companyName,
              // 初めて見た会社は、支店の行でも所在地を入れておく(本店の行が来たら上書きされる)。
              address: r.address,
              listed: true,
              seenCycle: cycle,
              needsDetail: true,
            },
            update,
          });
        }),
      );
      return rows.length;
    },

    async nextNeedingDetail(cycle: string, limit: number) {
      const rows = await prisma.mlitAgent.findMany({
        where: { needsDetail: true, listed: true, seenCycle: cycle, detailFailCount: { lt: DETAIL_FAIL_LIMIT } },
        orderBy: [{ detailFailCount: "asc" }, { licenseKey: "asc" }],
        take: limit,
        select: { licenseKey: true },
      });
      return rows.map((r) => r.licenseKey);
    },

    async markDetailFailed(licenseKey: string) {
      await prisma.mlitAgent.updateMany({
        where: { licenseKey },
        data: { detailFailCount: { increment: 1 } },
      });
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
          detailFailCount: 0,
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
