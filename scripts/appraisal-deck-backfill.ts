/**
 * 反映前に添付した査定報告書から「査定のご報告」の下書きを一括で作る — one-shot CLI(冪等・再実行可)。
 * 実体は src/lib/appraisal-deck/backfill.ts(テスト済)。添付時と同じ読み取りで、1本ずつ順に読む。
 *
 * 既定は **dry-run**(対象の件数だけ・書き込みなし)。`--apply` で下書きを作る。
 * 作るのは「確認待ち」の下書きだけ(お客様には出ない。担当者が物件ページで確かめて確認済みにする)。
 *
 * 実行(VPS・root で app.env を通してから。サービスは止めなくてよい):
 *   cd /opt/property-management && set -a && source /etc/property-management/app.env && set +a
 *   sudo -E -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm npx tsx scripts/appraisal-deck-backfill.ts
 *   sudo -E -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm npx tsx scripts/appraisal-deck-backfill.ts --apply
 *
 * ⚠出すのは件数と、作れなかった添付の id だけ(所在地・数字は出さない)。
 */
import { backfillAppraisalDrafts, prismaBackfillDeps } from "../src/lib/appraisal-deck/backfill";

const REASON: Record<string, string> = {
  attachment_not_found: "添付が見つからない",
  file_not_found: "ファイルが見つからない",
  not_pdf: "PDF ではない",
  read_failed: "文字を読み取れない・時間切れ",
  not_sre: "SRE の査定報告書の書式ではない",
  already_confirmed: "確認済み",
  busy: "混雑",
};

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  if (!process.env.DATABASE_URL) {
    process.stderr.write("停止: DATABASE_URL が設定されていません(app.env を source してください)。\n");
    process.exit(1);
  }
  const deps = await prismaBackfillDeps();
  const r = await backfillAppraisalDrafts(deps, { apply });
  if (!apply) {
    process.stdout.write(`dry-run: 下書きの無い査定報告書 ${r.targets} 件(--apply で下書きを作ります)\n`);
  } else {
    const failed = Object.entries(r.failed);
    process.stdout.write(
      `apply 完了: 対象 ${r.targets} 件 / 作った ${r.created} 件 / 既にあった ${r.existing} 件 / 作れなかった ${failed.reduce((a, [, ids]) => a + ids.length, 0)} 件\n`,
    );
    for (const [reason, ids] of failed) {
      process.stdout.write(`  作れなかった(${REASON[reason] ?? reason}): ${ids.length} 件 ${ids.join(" ")}\n`);
    }
  }
  const { default: prisma } = await import("../src/lib/prisma");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("停止:", e instanceof Error ? e.message : "不明なエラー");
  process.exit(1);
});
