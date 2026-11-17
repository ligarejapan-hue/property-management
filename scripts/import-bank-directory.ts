/**
 * 金融機関・支店の名簿(bank_institutions / bank_branches)を、リポジトリの控えから全件入れ替える CLI。
 * (2026-11-17 発注者「銀行名・支店名は金融機関のデータを保管して、一文字目で検索」)
 *
 * 実行(VPS では devDeps の tsx が必要。`npm ci --include=dev` 後・prune 前に実行):
 *   npx tsx scripts/import-bank-directory.ts --dry-run   … DB に書かず件数だけ
 *   npx tsx scripts/import-bank-directory.ts             … 全件入れ替え
 *   npx tsx scripts/import-bank-directory.ts --allow-shrink  … 件数が5%を超えて減っても入れ替える(意図したときだけ)
 *   控えのファイルを替えるときは --file <path>(既定 data/bank-directory/zengin.json)
 *
 * 設計:
 *   - 控えの解釈は src/lib/bank-directory/snapshot.ts(純関数・テスト済)。本ファイルは読み込みと書き込みだけ。
 *   - 1トランザクションで全削除 → 全件入れ直し(advisory lock で同時実行を止める)。同じ控えの再実行は同じ結果。
 *   - 本番サーバーから外へは取りに行かない(控えはリポジトリにある)。
 *   - ⚠個人情報は扱わない(公開データの金融機関・支店名だけ)。取引に入れた口座はこの表を参照しないので変わらない。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "../src/generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { parseSnapshot, shrinkProblem, type BankSnapshot } from "../src/lib/bank-directory/snapshot";

const CHUNK = 2000;

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const allowShrink = process.argv.includes("--allow-shrink");
  const file = argValue("--file") ?? join(process.cwd(), "data", "bank-directory", "zengin.json");
  const data = parseSnapshot(JSON.parse(readFileSync(file, "utf8")) as BankSnapshot);
  console.log(`控え: ${file}(${data.version}・金融機関 ${data.banks.length}・支店 ${data.branches.length})`);

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("停止: DATABASE_URL が設定されていません");
  const prisma = new PrismaClient({ adapter: new PrismaPg(connectionString) });
  try {
    const existing = { banks: await prisma.bankInstitution.count(), branches: await prisma.bankBranch.count() };
    console.log(`今の表: 金融機関 ${existing.banks}・支店 ${existing.branches}`);
    const problem = shrinkProblem(existing, { banks: data.banks.length, branches: data.branches.length });
    if (problem && !allowShrink) {
      throw new Error(`${problem}。控えが途中で切れている可能性があります(意図した入れ替えなら --allow-shrink)`);
    }
    if (dryRun) {
      console.log("--dry-run のため書き込みません");
      return;
    }
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('bank_directory_import'))`;
        await tx.bankBranch.deleteMany({});
        await tx.bankInstitution.deleteMany({});
        for (let i = 0; i < data.banks.length; i += CHUNK) {
          await tx.bankInstitution.createMany({
            data: data.banks.slice(i, i + CHUNK).map((b) => ({ ...b, sourceVersion: data.version })),
          });
        }
        for (let i = 0; i < data.branches.length; i += CHUNK) {
          await tx.bankBranch.createMany({ data: data.branches.slice(i, i + CHUNK) });
        }
      },
      { timeout: 120_000 },
    );
    console.log(`入れ替えました: 金融機関 ${data.banks.length}・支店 ${data.branches.length}(${data.version})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
