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
 *   - 書込は**都道府県単位の1tx**(県 advisory lock+市区町村ごとの全置換+prune を原子化)。
 *     同じデータの再実行は冪等。⚠改称・合併で新版から消えた旧市区町村名の行は
 *     置換対象にならず残存する→取込後に残存を警告し、都道府県一括の取込なら
 *     --prune-stale で同一 tx 内で掃除できる。
 *   - --dry-run は DB に書かず件数レポートのみ。
 *   - ⚠個人情報は扱わない(公開データの地点座標のみ)。
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "../src/generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { parseIsjCsv, type IsjBlockRow } from "../src/lib/address-blocks/parse-isj";
import { parseImportArgs } from "../src/lib/address-blocks/import-cli";

/**
 * 指定パス(ファイル or フォルダ)から .csv を列挙する(フォルダは1階層下まで)。
 * 重複指定(フォルダとその中のファイルを両方渡す・同じファイルを2回渡す・symlink 経由等)は
 * **物理パス**(realpath)で dedupe する(Codex R4/R8 P2: 重複すると同じ点が二重挿入される)。
 */
function collectCsvFiles(paths: string[]): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  const push = (p: string) => {
    const canonical = realpathSync(p);
    if (seen.has(canonical)) return;
    seen.add(canonical);
    files.push(canonical);
  };
  for (const p of paths) {
    const st = statSync(p);
    if (st.isFile()) {
      push(p);
      continue;
    }
    for (const name of readdirSync(p)) {
      const child = join(p, name);
      if (statSync(child).isDirectory()) {
        for (const inner of readdirSync(child)) {
          if (inner.toLowerCase().endsWith(".csv")) push(join(child, inner));
        }
      } else if (name.toLowerCase().endsWith(".csv")) {
        push(child);
      }
    }
  }
  return files;
}

const CHUNK = 1000;

interface CityGroup {
  prefecture: string;
  city: string;
  rows: IsjBlockRow[];
}

/**
 * 都道府県単位の1トランザクションで、配下の市区町村を順に全置換し、--prune-stale
 * なら旧版の残存も同じ tx 内で削除する(原子化)。
 *
 * 直列化(Codex R3/R4 P2): 同時実行の競合(全置換の二重挿入・prune が他プロセスの
 * 取込済み市区町村を消す)は、**都道府県単位の advisory lock を1本**に統一して防ぐ。
 * 市区町村ごとの細粒度ロックだと prune(県全体の削除)と鍵が噛み合わず、
 * ロックの意味が無くなるため。tx スコープの lock は commit/rollback で自動解放。
 * 戻り値は旧版の残存数(prune した場合は削除数)。
 */
async function importPrefecture(
  prisma: PrismaClient,
  prefecture: string,
  cityGroups: CityGroup[],
  version: string,
  pruneStale: boolean,
  allowShrink: boolean,
): Promise<number> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('address_block_import'), hashtext(${prefecture}))`;
      for (const g of cityGroups) {
        // 行として正常なまま**途中で切れた** CSV は不正行率では検知できない
        // (Codex R7 P2)。既存スナップショットの半分未満へ縮む置換は、データ欠損の
        // 疑いとして停止する(throw で県 tx ごと rollback)。強行は --allow-shrink。
        const existing = await tx.addressBlockPoint.count({
          where: { prefecture: g.prefecture, city: g.city },
        });
        if (existing > 0 && g.rows.length * 2 < existing && !allowShrink) {
          throw new Error(
            `${g.prefecture}${g.city}: 新データ ${g.rows.length} 点が既存 ${existing} 点の半分未満です。` +
              "CSV が途中で切れている可能性があります。再ダウンロードして再実行してください" +
              "(意図した縮小なら --allow-shrink を付けてください)",
          );
        }
        await tx.addressBlockPoint.deleteMany({
          where: { prefecture: g.prefecture, city: g.city },
        });
        for (let i = 0; i < g.rows.length; i += CHUNK) {
          await tx.addressBlockPoint.createMany({
            data: g.rows.slice(i, i + CHUNK).map((r) => ({
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
        console.log(`  取込: ${g.prefecture}${g.city} ${g.rows.length} 点`);
      }
      // 改称・合併で新版に現れない旧市区町村名の残存(取込と同じ tx 内=原子)。
      const staleWhere = { prefecture, sourceVersion: { not: version } };
      const stale = await tx.addressBlockPoint.count({ where: staleWhere });
      if (stale > 0 && pruneStale) {
        await tx.addressBlockPoint.deleteMany({ where: staleWhere });
      }
      return stale;
    },
    // 都道府県一括(東京都≒15万点)でも1txで置換できる余裕を持つ。
    { timeout: 600_000 },
  );
}

async function main(): Promise<number> {
  const opts = parseImportArgs(process.argv.slice(2));
  if (!opts) {
    console.log(
      "usage: npx tsx scripts/import-address-blocks.ts --version <例 24.0a> [--dry-run] [--prune-stale] [--allow-skipped] [--allow-shrink] <CSVファイル or フォルダ>...",
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
  // 壊れた CSV での全置換を防ぐ(Codex R5/R6 P2): 不正行率は**ファイル単位**で判定する。
  // 全体集計だと大きな市区町村の正常行が小さな市区町村の重大な破損を 1% 未満に
  // 薄めてしまい、破損ファイルの市区町村が欠けたまま置換(+--prune-stale なら
  // 旧データ削除)が通ってしまうため。
  const corrupt: Array<{ file: string; skipped: number; parsed: number }> = [];
  // ヘッダのみ(現行行ゼロ)の CSV は不正行率でも縮小ガードでも検知できない
  // (Codex R8 P2: グループが作られないため --prune-stale がその市区町村の旧データ
  // だけを「残存」として消す)。行ゼロのファイルは破損疑いとして停止対象にする。
  const empty: string[] = [];
  for (const file of files) {
    const text = new TextDecoder("shift_jis").decode(readFileSync(file));
    const { rows, skipped, history } = parseIsjCsv(text);
    totalSkipped += skipped;
    totalHistory += history;
    if (rows.length === 0) {
      empty.push(file);
      continue;
    }
    const parsed = rows.length + skipped;
    if (skipped > 0 && parsed > 0 && skipped / parsed > 0.01) {
      corrupt.push({ file, skipped, parsed });
    }
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

  if ((corrupt.length > 0 || empty.length > 0) && !opts.allowSkipped) {
    for (const c of corrupt) {
      console.error(`  破損疑い: ${c.file} (不正 ${c.skipped}/${c.parsed} 件・1%超)`);
    }
    for (const f of empty) {
      console.error(`  破損疑い: ${f} (現行の行が 0 件=ヘッダのみ?)`);
    }
    console.error(
      "停止: 上記の CSV が壊れている可能性があります。再ダウンロードして再実行してください。" +
        "この内容で強行する場合のみ --allow-skipped を付けてください",
    );
    return 1;
  }

  if (!opts.dryRun) {
    const adapter = new PrismaPg(connectionString as string);
    const prisma = new PrismaClient({ adapter });
    try {
      // 都道府県ごとに1つの tx(県 lock+置換+prune を原子化)。
      const byPrefecture = new Map<string, CityGroup[]>();
      for (const g of [...groups.values()].sort((a, b) =>
        `${a.prefecture}${a.city}`.localeCompare(`${b.prefecture}${b.city}`, "ja"),
      )) {
        const list = byPrefecture.get(g.prefecture) ?? [];
        list.push(g);
        byPrefecture.set(g.prefecture, list);
      }
      for (const [prefecture, cityGroups] of byPrefecture) {
        const stale = await importPrefecture(
          prisma,
          prefecture,
          cityGroups,
          opts.version,
          opts.pruneStale,
          opts.allowShrink,
        );
        if (stale > 0) {
          if (opts.pruneStale) {
            console.log(`  ${prefecture}: 旧版の残存 ${stale} 点を削除しました(--prune-stale)`);
          } else {
            console.warn(
              `⚠${prefecture}に今回の版(${opts.version})以外の点が ${stale} 点残っています。` +
                "市区町村の改称・合併があった場合、旧名の住所が提案され得ます。" +
                "都道府県一括で取り込み直す場合は --prune-stale で掃除できます" +
                "(一部市区町村だけの取込では使わないこと)",
            );
          }
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
