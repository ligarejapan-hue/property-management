/**
 * 名前に「査定書」「査定報告」が入っているのに種類が「その他」の添付を、種類「査定書・査定報告書」に
 * まとめて直す — one-shot CLI(冪等・再実行可)。実体は src/lib/doc-classify/appraisal-kind-backfill.ts(テスト済)。
 *
 * 既定は **dry-run**(件数だけ・書き込みなし)。`--apply` で直す。直し方は画面で種類を選んだときと同じ。
 * 直したあと、PDF の査定報告書から下書きを作るには scripts/appraisal-deck-backfill.ts を続けて流す。
 *
 * 実行(VPS・root で app.env を通してから。サービスは止めなくてよい):
 *   cd /opt/property-management && set -a && source /etc/property-management/app.env && set +a
 *   sudo -E -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm npx tsx scripts/attachments-appraisal-kind-backfill.ts
 *   sudo -E -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm npx tsx scripts/attachments-appraisal-kind-backfill.ts --apply
 *
 * ⚠出すのは件数と、直せなかった添付の id だけ(ファイル名・所在地は出さない)。
 */
import { backfillAppraisalKind, prismaKindBackfillDeps } from "../src/lib/doc-classify/appraisal-kind-backfill";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  if (!process.env.DATABASE_URL) {
    process.stderr.write("停止: DATABASE_URL が設定されていません(app.env を source してください)。\n");
    process.exit(1);
  }
  const r = await backfillAppraisalKind(await prismaKindBackfillDeps(), { apply });
  if (!apply) {
    process.stdout.write(`dry-run: 名前に「査定書・査定報告」が入っていて種類が「その他」の添付 ${r.targets} 件(--apply で種類を「査定書・査定報告書」にします)\n`);
  } else {
    process.stdout.write(
      `apply 完了: 対象 ${r.targets} 件 / 直した ${r.changed} 件 / 先に直されていた ${r.skipped} 件 / 直せなかった ${r.failed.length} 件\n`,
    );
    if (r.failed.length) process.stdout.write(`  直せなかった: ${r.failed.join(" ")}\n`);
    if (r.changed) process.stdout.write("続けて scripts/appraisal-deck-backfill.ts を流すと、PDF の査定報告書から下書きを作れます。\n");
  }
  const { default: prisma } = await import("../src/lib/prisma");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("停止:", e instanceof Error ? e.message : "不明なエラー");
  process.exit(1);
});
