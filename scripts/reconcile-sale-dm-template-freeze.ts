/**
 * 既存の型へ凍結印を入れる照合 — one-shot CLI（PR-D2・冪等・再実行可）。
 *
 * 何をするか（実体は src/lib/sale-dm-letter/reconcile-freeze.ts・テスト済）:
 *   - `template_frozen_at` がまだ null で、配下に確定/送付済みの宛先がある型に、
 *     その型で最初に確定/送付した時刻を印として入れる（手がかりが無ければ実行時刻）。
 *
 * ⚠**migration では埋めない**。`migrate deploy → restart` の窓では凍結を知らない旧ルートが
 * 動いており、印を先に立てると凍結済みの型を書き換え・削除できてしまう（復元不能）。
 * **restart のあとに1回**流す。⚠このスクリプトは tsx(devDependencies)で動くので、
 * **`npm prune --omit=dev` より前**に実行すること（prune を最後へ回す・@codex #376）。
 *
 * 安全のためデフォルトは **dry-run**（件数レポートのみ）。`--apply` で実書込。
 *
 * 実行（VPS では devDeps の tsx が必要。`npm ci --include=dev` 後・prune 前に実行。
 * root で app.env を source して DATABASE_URL を通しておく）:
 *   npx tsx scripts/reconcile-sale-dm-template-freeze.ts           # dry-run
 *   npx tsx scripts/reconcile-sale-dm-template-freeze.ts --apply   # 実書込（反映後に1回）
 */

import { PrismaClient } from "../src/generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { reconcileTemplateFreeze } from "../src/lib/sale-dm-letter/reconcile-freeze";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL が未設定です");
    process.exit(1);
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
  try {
    const r = await reconcileTemplateFreeze(
      prisma as unknown as Parameters<typeof reconcileTemplateFreeze>[0],
      { apply },
    );
    console.log(
      apply
        ? `[apply] 対象 ${r.candidates} 件 / 印を入れた ${r.updated} 件`
        : `[dry-run] 対象 ${r.candidates} 件（--apply で書き込みます）`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
