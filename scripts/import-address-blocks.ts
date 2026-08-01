/**
 * 国土交通省「位置参照情報」街区レベル CSV → address_block_points 取込 CLI。
 * (住所自動入力 第2弾:「番」までの精細化のデータ供給)
 *
 * データの入手(手動・年1回程度の更新):
 *   https://nlftp.mlit.go.jp/isj/ から「街区レベル」を都道府県または市区町村単位で
 *   ダウンロードし、zip を展開して CSV を任意のフォルダに置く
 *   (例: 東京都一括 = 13000-24.0a.zip → 13000-24.0a/13101_2025.csv ...)。
 *   出典表記は UI 側で「出典: 国土交通省 位置参照情報」を表示済み。
 *
 * 実行(VPS では devDeps の tsx が必要。`npm ci --include=dev` 後・prune 前に実行):
 *   npx tsx scripts/import-address-blocks.ts --version 24.0a <CSVファイル or フォルダ>...
 *   npx tsx scripts/import-address-blocks.ts --version 24.0a --dry-run <path>...
 *   npx tsx scripts/import-address-blocks.ts --version 25.0a --prune-stale <都道府県一括のフォルダ>
 *
 * 設計:
 *   - CSV の解釈は src/lib/address-blocks/parse-isj.ts(純関数・テスト済)。本ファイルは
 *     I/O(ファイル走査・Shift_JIS decode・prisma 書込・stdout)に限定した薄い wrapper。
 *   - 書込は市区町村単位の全置換(tx: deleteMany→createMany)=同じ市区町村は再実行冪等。
 *     ⚠改称・合併で新版から消えた旧市区町村名の行は置換対象にならず残存する→取込後に
 *     残存を警告し、都道府県一括の取込なら --prune-stale で掃除できる。
 *   - --dry-run は DB に書かず件数レポートのみ。
 *   - ⚠個人情報は扱わない(公開データの地点座標のみ)。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "../src/generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { parseIsjCsv, type IsjBlockRow } from "../src/lib/address-blocks/parse-isj";
import { parseImportArgs } from "../src/lib/address-blocks/import-cli";

/** 指定パス(ファイル or フォルダ)から .csv を列挙する(フォルダは1階層下まで)。 */
function collectCsvFiles(paths: string[]): string[] {
  const files: string[] = [];
  for (const p of paths) {
    const st = statSync(p);
    if (st.isFile()) {
      files.push(p);
      continue;
    }
    for (const name of readdirSync(p)) {
      const child = join(p, name);
      if (statSync(child).isDirectory()) {
        for (const inner of readdirSync(child)) {
          if (inner.toLowerCase().endsWith(".csv")) files.push(join(child, inner));
        }
      } else if (name.toLowerCase().endsWith(".csv")) {
        files.push(child);
      }
    }
  }
  return files;
}

const CHUNK = 1000;

async function importGroup(
  prisma: PrismaClient,
  prefecture: string,
  city: string,
  rows: IsjBlockRow[],
  version: string,
): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      // 同一市区町村への同時実行を直列化する(Codex R3 P2: 2本の取込が同時に走ると
      // 両方の delete→insert が通って点が二重になる)。tx スコープの advisory lock は
      // commit/rollback で自動解放。後着は先着の完了を待ってから全置換するので、
      // どちらの順でも最終状態は「どちらか一方のスナップショット」に収束する。
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${prefecture}), hashtext(${city}))`;
      await tx.addressBlockPoint.deleteMany({ where: { prefecture, city } });
      for (let i = 0; i < rows.length; i += CHUNK) {
        await tx.addressBlockPoint.createMany({
          data: rows.slice(i, i + CHUNK).map((r) => ({
            prefecture: r.prefecture,
            city: r.city,
            town: r.town,
            block: r.block,
            lat: r.lat,
            lng: r.lng,
            isResidential: r.isResidential,
            sourceVersion: version,
          })),
        });
      }
    },
    // 大きい市区町村(数万点)でも1txで置換できる余裕を持つ。
    { timeout: 120_000 },
  );
}

async function main(): Promise<number> {
  const opts = parseImportArgs(process.argv.slice(2));
  if (!opts) {
    console.log(
      "usage: npx tsx scripts/import-address-blocks.ts --version <例 24.0a> [--dry-run] [--prune-stale] <CSVファイル or フォルダ>...",
    );
    return 2;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString && !opts.dryRun) {
    console.error("停止: DATABASE_URL が設定されていません");
    return 1;
  }
  const files = collectCsvFiles(opts.paths);
  if (files.length === 0) {
    console.error("CSV ファイルが見つかりません");
    return 2;
  }
  console.log(`対象 CSV: ${files.length} ファイル / 版: ${opts.version}${opts.dryRun ? " (dry-run)" : ""}`);

  // 市区町村単位でまとめる(同一市区町村が複数ファイルに跨っても1回の置換に統合)。
  const groups = new Map<string, { prefecture: string; city: string; rows: IsjBlockRow[] }>();
  let totalSkipped = 0;
  let totalHistory = 0;
  for (const file of files) {
    const text = new TextDecoder("shift_jis").decode(readFileSync(file));
    const { rows, skipped, history } = parseIsjCsv(text);
    totalSkipped += skipped;
    totalHistory += history;
    for (const r of rows) {
      const key = `${r.prefecture}|${r.city}`;
      const g = groups.get(key) ?? { prefecture: r.prefecture, city: r.city, rows: [] };
      g.rows.push(r);
      groups.set(key, g);
    }
  }

  let totalRows = 0;
  for (const g of groups.values()) totalRows += g.rows.length;
  console.log(
    `解析結果: ${groups.size} 市区町村 / ${totalRows} 点 (除外: 不正 ${totalSkipped} / 履歴 ${totalHistory})`,
  );

  if (!opts.dryRun) {
    const adapter = new PrismaPg(connectionString as string);
    const prisma = new PrismaClient({ adapter });
    try {
      for (const g of [...groups.values()].sort((a, b) =>
        `${a.prefecture}${a.city}`.localeCompare(`${b.prefecture}${b.city}`, "ja"),
      )) {
        await importGroup(prisma, g.prefecture, g.city, g.rows, opts.version);
        console.log(`  取込: ${g.prefecture}${g.city} ${g.rows.length} 点`);
      }

      // 市区町村の改称・合併で「新版の CSV に現れなくなった旧名」の行は上の置換では
      // 消えない(置換は新データに存在する市区町村単位のため)。残存すると廃止済みの
      // 市区町村名が最近傍照合で提案され得る(社内レビュー指摘)ので、取込対象の
      // 都道府県内で今回の版以外の残存を数えて警告し、--prune-stale なら削除する。
      const prefectures = [...new Set([...groups.values()].map((g) => g.prefecture))];
      const staleWhere = {
        prefecture: { in: prefectures },
        sourceVersion: { not: opts.version },
      };
      const stale = await prisma.addressBlockPoint.count({ where: staleWhere });
      if (stale > 0) {
        if (opts.pruneStale) {
          await prisma.addressBlockPoint.deleteMany({ where: staleWhere });
          console.log(`旧版の残存 ${stale} 点を削除しました(--prune-stale)`);
        } else {
          console.warn(
            `⚠取込対象の都道府県内に今回の版(${opts.version})以外の点が ${stale} 点残っています。` +
              "市区町村の改称・合併があった場合、旧名の住所が提案され得ます。" +
              "都道府県一括で取り込み直す場合は --prune-stale で掃除できます" +
              "(一部市区町村だけの取込では使わないこと)",
          );
        }
      }

      const count = await prisma.addressBlockPoint.count();
      console.log(`完了: address_block_points 総点数 = ${count}`);
    } finally {
      await prisma.$disconnect();
    }
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error("取込に失敗しました:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
