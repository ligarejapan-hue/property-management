/**
 * 前に受領したお客様の書類を、取引の物件の「添付」へまとめて入れる — one-shot CLI(冪等・何度流しても同じ)。
 * 実体は src/lib/deals/doc-links/receive-attach.ts(テスト済)。受領のときと同じ決まりで写す(2026-11-21 発注者)。
 *
 * 既定は **dry-run**(入れる予定の件数だけ・書き込みなし)。`--apply` で入れる。
 *
 * 実行(VPS・root で app.env を通してから。サービスは止めなくてよい):
 *   cd /opt/property-management && set -a && source /etc/property-management/app.env && set +a
 *   sudo -E -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm npx tsx scripts/attach-received-deal-docs.ts
 *   sudo -E -u www-data env HOME=/var/www npm_config_cache=/var/www/.npm npx tsx scripts/attach-received-deal-docs.ts --apply
 *
 * ⚠出すのは件数だけ(取引・物件・お客様のことは出さない)。
 */
import { backfillReceivedDocAttachments } from "../src/lib/deals/doc-links/receive-attach";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  if (!process.env.DATABASE_URL) {
    process.stderr.write("停止: DATABASE_URL が設定されていません(app.env を source してください)。\n");
    process.exit(1);
  }
  const { default: prisma } = await import("../src/lib/prisma");
  const { getStorage } = await import("../src/lib/storage");
  const r = await backfillReceivedDocAttachments({ db: prisma as never, storage: getStorage(), apply });
  const head = apply ? "apply 完了" : "dry-run";
  const verb = apply ? "入れた" : "入れる予定";
  process.stdout.write(
    `${head}: 受領済みの書類 ${r.requests} 件 / ${verb}ファイル ${r.attached} 件 / すでに入っている ${r.existing} 件 / ` +
      `入れられなかった ${r.failed} 件 / 物件につながっていない取引の書類 ${r.noProperty} 件 / しまってある物件の書類 ${r.archived} 件\n`,
  );
  if (!apply) process.stdout.write("--apply を付けると入れます。\n");
  await prisma.$disconnect();
}

main().catch((e) => {
  process.stderr.write(`失敗: ${(e as { code?: unknown })?.code ?? (e as Error)?.name ?? "error"}\n`);
  process.exit(1);
});
