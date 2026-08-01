/**
 * デジタル庁「アドレス・ベース・レジストリ」→ address_residence_points 取込 CLI。
 * (住所自動入力 第3弾:「号」までの精細化のデータ供給)
 *
 * データの入手(手動・年1回程度の更新):
 *   https://dataset.address-br.digital.go.jp/ (アドレス・ベース・レジストリ カタログ)から
 *   都道府県ごとに次の**2種類**を取得し、zip を展開して同じフォルダに置く:
 *     1. 町字マスター            例: https://data.address-br.digital.go.jp/mt_town/pref/mt_town_pref13.csv.zip
 *     2. 住居表示-住居マスター位置参照拡張
 *        例: https://data.address-br.digital.go.jp/mt_rsdtdsp_rsdt_pos/pref/mt_rsdtdsp_rsdt_pos_pref13.csv.zip
 *   出典表記は UI 側で「出典: デジタル庁 アドレス・ベース・レジストリ」を表示済み。
 *
 * 実行(VPS では devDeps の tsx が必要。`npm ci --include=dev` 後・prune 前に実行):
 *   npx tsx scripts/import-address-residences.ts --version 2026-08 <フォルダ>...
 *   npx tsx scripts/import-address-residences.ts --version 2026-08 --dry-run <フォルダ>...
 *   npx tsx scripts/import-address-residences.ts --version 2027-08 --prune-stale <都道府県一括のフォルダ>
 *
 * 設計(取込コマンドの防御は街区取込 import-address-blocks.ts と同一方針):
 *   - 解釈は src/lib/address-blocks/parse-abr.ts(純関数・テスト済)。本ファイルは I/O のみ。
 *   - 位置参照拡張は大きい(東京都175万行)ため streaming(strictUtf8Lines)で読む。
 *     UTF-8 の不正バイトは fatal=文字化け住所の混入防止(強行不可)。
 *   - 書込は**都道府県単位の1tx**(県 advisory lock+市区町村ごとの全置換+prune を原子化)。
 *   - 縮小置換(既存の半分未満)は停止(--allow-shrink)。町字に紐づかない行等の不正が
 *     1%を超えるファイルは停止(--allow-skipped)。行ゼロのファイルも停止。
 *   - ⚠個人情報は扱わない(公開データの地点座標のみ)。
 */

import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { PrismaClient } from "../src/generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { parseImportArgs } from "../src/lib/address-blocks/import-cli";
import { collectCsvFiles, strictUtf8Lines } from "../src/lib/address-blocks/import-files";
import {
  parseAbrTownCsv,
  parseAbrRsdtHeader,
  parseAbrRsdtLine,
  type AbrResidenceRow,
  type AbrTownEntry,
} from "../src/lib/address-blocks/parse-abr";

const CHUNK = 2000;

interface CityGroup {
  prefecture: string;
  city: string;
  rows: AbrResidenceRow[];
}

/** 都道府県単位の1tx: 県 lock → 市区町村ごとに縮小ガード+全置換 → prune(原子)。 */
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
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('address_residence_import'), hashtext(${prefecture}))`;
      for (const g of cityGroups) {
        const existing = await tx.addressResidencePoint.count({
          where: { prefecture: g.prefecture, city: g.city },
        });
        if (existing > 0 && g.rows.length * 2 < existing && !allowShrink) {
          throw new Error(
            `${g.prefecture}${g.city}: 新データ ${g.rows.length} 点が既存 ${existing} 点の半分未満です。` +
              "CSV が途中で切れている可能性があります。再ダウンロードして再実行してください" +
              "(意図した縮小なら --allow-shrink を付けてください)",
          );
        }
        // 市区町村の**途中**で切れた CSV(50%超が残る)は点数の縮小ガードを通過する
        // (Codex R3 P2)。既存の町丁目が新データに全て存在することも照合する
        // (ファイル末尾側の町丁目が黙って消えるのを防ぐ)。町名変更等の意図的な
        // 再編のみ --allow-shrink で続行。
        if (existing > 0 && !allowShrink) {
          const existingTowns = await tx.addressResidencePoint.findMany({
            where: { prefecture: g.prefecture, city: g.city },
            distinct: ["town", "chome"],
            select: { town: true, chome: true },
          });
          const incomingTowns = new Set(g.rows.map((r) => `${r.town}|${r.chome}`));
          const missingTowns = existingTowns
            .map((t) => `${t.town}|${t.chome}`)
            .filter((k) => !incomingTowns.has(k));
          if (missingTowns.length > 0) {
            const label = missingTowns
              .slice(0, 5)
              .map((k) => k.replace("|", ""))
              .join("、");
            throw new Error(
              `${g.prefecture}${g.city}: 既存の ${missingTowns.length} 町丁目(${label}${missingTowns.length > 5 ? " ほか" : ""})が新データにありません。` +
                "CSV が途中で切れているか、町名の再編の可能性があります。再ダウンロードして確認してください" +
                "(意図した再編なら --allow-shrink を付けてください)",
            );
          }
        }
        await tx.addressResidencePoint.deleteMany({
          where: { prefecture: g.prefecture, city: g.city },
        });
        for (let i = 0; i < g.rows.length; i += CHUNK) {
          await tx.addressResidencePoint.createMany({
            data: g.rows.slice(i, i + CHUNK).map((r) => ({
              prefecture: r.prefecture,
              city: r.city,
              town: r.town,
              chome: r.chome,
              block: r.block,
              rsdt: r.rsdt,
              lat: r.lat,
              lng: r.lng,
              sourceVersion: version,
            })),
          });
        }
        console.log(`  取込: ${g.prefecture}${g.city} ${g.rows.length} 点`);
      }
      const staleWhere = { prefecture, sourceVersion: { not: version } };
      const stale = await tx.addressResidencePoint.count({ where: staleWhere });
      if (stale > 0 && pruneStale) {
        // 市区町村の境目でちょうど切れた CSV は「行ゼロ」でも「縮小」でもなく、
        // 欠けた市区町村ごと cityGroups から消える(Codex R2 P2)。その状態で prune
        // すると旧データが黙って消えるため、既存の市区町村が新データに全て存在する
        // ことを確認してから消す。合併等で意図的に消えた場合のみ --allow-shrink。
        const existingCities = await tx.addressResidencePoint.findMany({
          where: { prefecture },
          distinct: ["city"],
          select: { city: true },
        });
        const incoming = new Set(cityGroups.map((g) => g.city));
        const missing = existingCities
          .map((e) => e.city)
          .filter((c) => !incoming.has(c));
        if (missing.length > 0 && !allowShrink) {
          throw new Error(
            `${prefecture}: 既存の ${missing.length} 市区町村(${missing.slice(0, 5).join("、")}${missing.length > 5 ? " ほか" : ""})が新データにありません。` +
              "CSV が途中で切れているか、市町村合併の可能性があります。再ダウンロードして確認してください" +
              "(合併等で意図した消滅なら --allow-shrink を付けてください)",
          );
        }
        await tx.addressResidencePoint.deleteMany({ where: staleWhere });
      }
      return stale;
    },
    // 都道府県一括(東京都≒175万点)でも1txで置換できる余裕を持つ。
    { timeout: 1_800_000 },
  );
}

async function main(): Promise<number> {
  const opts = parseImportArgs(process.argv.slice(2));
  if (!opts) {
    console.log(
      "usage: npx tsx scripts/import-address-residences.ts --version <例 2026-08> [--dry-run] [--prune-stale] [--allow-skipped] [--allow-shrink] <フォルダ or CSV>...",
    );
    console.log(
      "  ※町字マスター(mt_town_*)と住居マスター位置参照拡張(mt_rsdtdsp_rsdt_pos_*)の両方が必要",
    );
    return 2;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString && !opts.dryRun) {
    console.error("停止: DATABASE_URL が設定されていません");
    return 1;
  }
  const files = collectCsvFiles(opts.paths);
  const townFiles = files.filter((f) => basename(f).startsWith("mt_town"));
  const posFiles = files.filter((f) =>
    basename(f).startsWith("mt_rsdtdsp_rsdt_pos"),
  );
  if (townFiles.length === 0 || posFiles.length === 0) {
    console.error(
      `停止: 町字マスター(${townFiles.length}件)と住居マスター位置参照拡張(${posFiles.length}件)の両方が必要です`,
    );
    return 2;
  }
  console.log(
    `対象: 町字 ${townFiles.length} / 住居点 ${posFiles.length} ファイル / 版: ${opts.version}${opts.dryRun ? " (dry-run)" : ""}`,
  );

  // 町字マスター(小さい)を先に統合。文字コード破損は強行不可で停止。
  const towns = new Map<string, AbrTownEntry>();
  let townSkipped = 0;
  for (const file of townFiles) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file));
    } catch {
      console.error(`停止: ${file} の文字コードが壊れています(UTF-8 として不正)。再ダウンロードしてください`);
      return 1;
    }
    const r = parseAbrTownCsv(text);
    townSkipped += r.skipped;
    if (r.towns.size === 0) {
      console.error(`停止: ${file} に有効な町字がありません(ヘッダのみ?)。再ダウンロードしてください`);
      return 1;
    }
    for (const [k, v] of r.towns) towns.set(k, v);
  }
  console.log(`町字: ${towns.size} 件 (除外: ${townSkipped})`);

  // 住居点(大きい)は streaming で読みつつ市区町村ごとにまとめる。
  const groups = new Map<string, CityGroup>();
  let totalRows = 0;
  let totalSkipped = 0;
  const corrupt: Array<{ file: string; skipped: number; parsed: number }> = [];
  const empty: string[] = [];
  for (const file of posFiles) {
    let col: Record<string, number> | null = null;
    let fileRows = 0;
    let fileSkipped = 0;
    try {
      for await (const line of strictUtf8Lines(file)) {
        if (line.trim() === "") continue;
        if (col === null) {
          col = parseAbrRsdtHeader(line); // 列名ドリフトは throw
          continue;
        }
        const row = parseAbrRsdtLine(line, col, towns);
        if (row === null) {
          fileSkipped++;
          continue;
        }
        fileRows++;
        const key = `${row.prefecture}|${row.city}`;
        const g = groups.get(key) ?? {
          prefecture: row.prefecture,
          city: row.city,
          rows: [],
        };
        g.rows.push(row);
        groups.set(key, g);
      }
    } catch (err) {
      if (err instanceof TypeError) {
        console.error(`停止: ${file} の文字コードが壊れています(UTF-8 として不正)。再ダウンロードしてください`);
        return 1;
      }
      throw err;
    }
    totalRows += fileRows;
    totalSkipped += fileSkipped;
    if (fileRows === 0) {
      empty.push(file);
    } else if (fileSkipped > 0 && fileSkipped / (fileRows + fileSkipped) > 0.01) {
      corrupt.push({ file, skipped: fileSkipped, parsed: fileRows + fileSkipped });
    }
  }
  console.log(
    `解析結果: ${groups.size} 市区町村 / ${totalRows} 点 (除外: ${totalSkipped})`,
  );

  if ((corrupt.length > 0 || empty.length > 0) && !opts.allowSkipped) {
    for (const c of corrupt) {
      console.error(`  破損疑い: ${c.file} (不正 ${c.skipped}/${c.parsed} 件・1%超)`);
    }
    for (const f of empty) {
      console.error(`  破損疑い: ${f} (現行の行が 0 件=ヘッダのみ?)`);
    }
    console.error(
      "停止: 上記の CSV が壊れている可能性があります(町字マスターの都道府県と住居点の都道府県が食い違っても全行不正になります)。" +
        "組み合わせとダウンロードを確認してください。強行する場合のみ --allow-skipped を付けてください",
    );
    return 1;
  }

  if (!opts.dryRun) {
    const adapter = new PrismaPg(connectionString as string);
    const prisma = new PrismaClient({ adapter });
    try {
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
                "都道府県一括で取り込み直す場合は --prune-stale で掃除できます" +
                "(一部市区町村だけの取込では使わないこと)",
            );
          }
        }
      }
      const count = await prisma.addressResidencePoint.count();
      console.log(`完了: address_residence_points 総点数 = ${count}`);
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
