/**
 * 旧 sale_dm 送付記録の反響照合 — one-shot CLI(PR-B・冪等・再実行可)。
 *
 * 何をするか(実体は src/lib/dm-reaction/reconcile.ts・テスト済):
 *   - draft_id 済みのブリッジ行: draft の現在値(返戻/LP/電話)から反響を再同期
 *   - draft_id なしの旧行: propertyId+JST暦日で draft と対応付け。一意なら draft_id を
 *     永続化して同期・曖昧(同日複数)は証拠があるときだけ保守的に付与(格下げなし)
 *
 * 安全のためデフォルトは **dry-run**(件数レポートのみ)。`--apply` で実書込。
 *
 * 実行(VPS では devDeps の tsx が必要。`npm ci --include=dev` 後・prune 前に実行。
 * root で app.env を source して DATABASE_URL を通しておく):
 *   npx tsx scripts/reconcile-sale-dm-reactions.ts           # dry-run
 *   npx tsx scripts/reconcile-sale-dm-reactions.ts --apply   # 実書込(本番反映後に1回)
 */

import { PrismaClient } from "../src/generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { reconcileSaleDmReactions } from "../src/lib/dm-reaction/reconcile";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    process.stderr.write("停止: DATABASE_URL が設定されていません。\n");
    process.exit(1);
  }
  const adapter = new PrismaPg(connectionString);
  const prisma = new PrismaClient({ adapter });
  try {
    const counts = await reconcileSaleDmReactions(prisma as never, {
      dryRun: !apply,
    });
    process.stdout.write(
      `${apply ? "apply" : "dry-run"} 完了: ` +
        `対象 ${counts.scanned} 件 / ブリッジ済み同期 ${counts.matched} / ` +
        `新規対応付け ${counts.linked} / 保守的付与 ${counts.ambiguousConservative} / ` +
        `対応付けなし ${counts.skipped}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
