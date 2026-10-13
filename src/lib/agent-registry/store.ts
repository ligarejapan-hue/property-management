import { Prisma } from "@/generated/prisma";
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
            totalRows: s.totalRows,
            lastKey: s.lastKey,
            lastCompletedCycle: s.lastCompletedCycle,
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
      const keys = rows.map((r) => r.licenseKey);
      const staleBefore = now().getTime() - DETAIL_MAX_AGE_MS;
      // 読み比べ→更新を1つの取引で、行をロックしてから行う。名簿へ写す側も同じ行をロックするので、
      // 「変わった」と判定した直後の隙に古い電話を写される・取り直しの印が付く前に写される、が起きない(@codex #477)。
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM "mlit_agents" WHERE license_key IN (${Prisma.join(keys)}) FOR UPDATE`,
        );
        const existing = await tx.mlitAgent.findMany({
          where: { licenseKey: { in: keys } },
          select: {
            licenseKey: true,
            companyName: true,
            address: true,
            licenseLabel: true,
            seenCycle: true,
            detailAt: true,
            listed: true,
          },
        });
        const prev = new Map(existing.map((e) => [e.licenseKey, e]));
        for (const r of rows) {
          const p = prev.get(r.licenseKey);
          const changed =
            !p ||
            // 一覧から消えていた会社がまた出てきた=いない間に電話などが変わっていてもおかしくない(@codex #477)。
            !p.listed ||
            p.companyName !== r.companyName ||
            p.licenseLabel !== r.licenseLabel ||
            // 所在地の違い: 本店の行なら書き換えて取り直す。「本店」以外の名前の行(「本社」「大阪本店」・ページの境目の支店)は
            // 書き換えずに取り直すだけ=詳細の「主たる事務所の所在地」で正しい値にする(本店の引っ越しを拾う・@codex #509)。
            p.address !== r.address;
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
          await tx.mlitAgent.upsert({
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
        }
      });
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

    async countDetailExhausted(cycle: string) {
      return prisma.mlitAgent.count({
        where: { needsDetail: true, listed: true, seenCycle: cycle, detailFailCount: { gte: DETAIL_FAIL_LIMIT } },
      });
    },

    async markDetailFailed(licenseKey: string) {
      await prisma.mlitAgent.updateMany({
        where: { licenseKey },
        data: { detailFailCount: { increment: 1 } },
      });
    },

    async saveDetail(d: Detail, at: Date) {
      const digits = d.phone?.replace(/\D/g, "") ?? "";
      // 所在地は詳細の「主たる事務所の所在地」を正とする(一覧は1社1行=本店だが、営業所名が「本店」でない会社
      // 「本社」「大阪本店」等は一覧側で所在地を書き換えないため、本店の引っ越しをここで反映する・2026-10-13 実物で
      // 一覧と詳細の書き方が同じことを確認=月ごとの見直しで「変わった」と誤判定しない)。詳細が空なら一覧の値を残す。
      // 所在地と「取り終えた」の印は1回の書き込みでまとめて書く=間に所在地の無いまま候補に出て写されない(@codex #477)。
      await prisma.mlitAgent.updateMany({
        where: { licenseKey: d.licenseKey },
        data: {
          ...(d.address ? { address: d.address } : {}),
          companyKana: d.companyKana,
          phone: d.phone,
          phoneDigits: digits || null,
          validUntil: d.validUntil,
          needsDetail: false,
          detailAt: at,
          detailFailCount: 0,
        },
      });
    },

    async closeCycle(cycle: string, prevCycle: string) {
      const res = await prisma.mlitAgent.updateMany({
        where: { listed: true, OR: [{ seenCycle: { notIn: [cycle, prevCycle] } }, { seenCycle: null }] },
        data: { listed: false },
      });
      return res.count;
    },
  };
}
