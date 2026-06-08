/**
 * 既存 field-survey 写真の遡及 EXIF/GPS strip — inventory / dry-run CLI（PR-R2a）。
 *
 * ⚠ このスクリプトは **dry-run / inventory 専用** です。
 *   - DB 更新・storage への upload/delete・DB repoint・旧 key cleanup は一切行いません。
 *   - `--apply` は未実装（指定するとエラー終了）。実 strip は別 PR・別承認（PR-R2b 以降）。
 *
 * 実行（VPS では devDeps の tsx が必要。`npm ci --include=dev` 後・prune 前に実行）:
 *   npx tsx scripts/retro-exif-strip-field-survey.ts --inventory
 *   npx tsx scripts/retro-exif-strip-field-survey.ts --dry-run --jsonl /tmp/retro-dryrun.jsonl
 *   npx tsx scripts/retro-exif-strip-field-survey.ts --help
 *
 * 詳細は docs/field-survey-retro-exif-strip-runbook.md を参照。
 *
 * 設計:
 *   - 判定/集計ロジックは src/lib/field-survey/retro-exif-strip-cli.ts（純関数・テスト済）。
 *   - 本ファイルは I/O（prisma READ・storage read・JSONL 追記・stdout）に限定した薄い wrapper。
 *   - prisma は READ のみ（findMany）。storage は read のみ。upload/delete/repoint は
 *     dry-run ports の throw スタブで多層防御（dry-run では到達しない）。
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "../src/generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { getStorage } from "../src/lib/storage";
import {
  parseRetroStripCliArgs,
  assertSafeEnvironment,
  emptyInventorySummary,
  accumulateInventoryRow,
  runRetroStripDryRun,
  makeDryRunPorts,
  type InventoryRowInput,
  type RetroStripCliOptions,
  type RetroStripRunLogLine,
} from "../src/lib/field-survey/retro-exif-strip-cli";
import type { RetroStripRowInput } from "../src/lib/field-survey/retro-exif-strip";

const HELP_TEXT = `
field-survey 遡及 EXIF/GPS strip — inventory / dry-run CLI（dry-run 専用）

使い方:
  npx tsx scripts/retro-exif-strip-field-survey.ts <mode> [options]

mode（いずれか必須）:
  --inventory          DB のみを集計（storage は読まない）。件数 / mimeType 分布 /
                       mappable / unmappable / legacy absolute / 非対応 MIME /
                       thumbnail 有無 を表示。
  --dry-run            storage read + strip を in-memory で実施し、outcome を集計。
                       **書き込みは一切しない**（upload/delete/repoint なし）。

options:
  --jsonl <path>       dry-run の run-log を JSONL で出力（非 PII）。
  --batch-size <n>     1 バッチの取得件数（既定 500）。
  --limit <n>          処理対象の上限（部分確認用）。
  --help, -h           このヘルプ。

禁止/未実装:
  --apply              実装されていません（指定するとエラー）。実 strip は別承認。

注意:
  - 本番 DB / storage は変更しません（READ のみ）。
  - NEXT_PUBLIC_USE_MOCK=true では停止します（mock は実データを反映しないため）。
  - VPS では devDeps の tsx が必要です（npm ci --include=dev 後・prune 前）。
`.trim();

const SELECT_ROW = {
  id: true,
  pinId: true,
  fileUrl: true,
  thumbnailUrl: true,
  fileName: true,
  mimeType: true,
} as const;

function log(message: string): void {
  // 非 PII のみ。写真内容 / EXIF / 座標 / 所有者情報は出力しない。
  process.stdout.write(`${message}\n`);
}

async function main(): Promise<number> {
  const parsed = parseRetroStripCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`エラー: ${parsed.error}\n\n${HELP_TEXT}\n`);
    return 1;
  }
  const options = parsed.options;
  if (options.help) {
    log(HELP_TEXT);
    return 0;
  }

  // 安全ガード（DB へ接続する前に判定する）。
  const guard = assertSafeEnvironment(process.env);
  if (!guard.ok) {
    process.stderr.write(`停止: ${guard.reason}\n`);
    return 1;
  }

  log("=== field-survey 遡及 EXIF strip CLI ===");
  log(`モード: ${options.mode}`);
  log(
    "⚠ DRY-RUN/INVENTORY 専用です。DB 更新・storage 書き込み・repoint・cleanup は行いません。",
  );

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    process.stderr.write("停止: DATABASE_URL が設定されていません。\n");
    return 1;
  }
  const adapter = new PrismaPg(connectionString);
  const prisma = new PrismaClient({ adapter });

  try {
    if (options.mode === "inventory") {
      return await runInventory(prisma, options);
    }
    return await runDryRun(prisma, options);
  } finally {
    await prisma.$disconnect();
  }
}

async function runInventory(
  prisma: PrismaClient,
  options: RetroStripCliOptions,
): Promise<number> {
  // 全行をメモリに保持せず、ページングしながら逐次畳み込む（dry-run と同じ streaming 規律）。
  const summary = emptyInventorySummary();
  let cursor: string | null = null;
  let fetched = 0;
  for (;;) {
    const batch: InventoryRowInput[] = await prisma.fieldSurveyPinPhoto.findMany({
      select: { id: true, fileUrl: true, thumbnailUrl: true, mimeType: true },
      orderBy: { id: "asc" },
      take: options.batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (batch.length === 0) break;
    let stop = false;
    for (const r of batch) {
      accumulateInventoryRow(summary, r);
      fetched += 1;
      if (options.limit !== null && fetched >= options.limit) {
        stop = true;
        break;
      }
    }
    if (stop) break;
    cursor = batch[batch.length - 1].id;
  }
  log("");
  log("--- inventory 結果（storage 未読・DB のみ）---");
  log(`対象件数: ${summary.total}`);
  log(`mimeType 分布:`);
  for (const [mime, count] of Object.entries(summary.byMimeType).sort()) {
    log(`  ${mime}: ${count}`);
  }
  log(`fileUrl から key 抽出可能（処理候補）: ${summary.mappable}`);
  log(`  うち legacy absolute URL: ${summary.absoluteLegacy}`);
  log(`fileUrl 抽出不可（skip 予定）: ${summary.unmappable}`);
  log(`strip 対象 MIME かつ mappable（実処理候補の上限）: ${summary.supportedAndMappable}`);
  log(`非対応 MIME（HEIC/HEIF 等・skip 予定・GPS 残存候補）: ${summary.unsupportedMime}`);
  log(`thumbnail あり: ${summary.withThumbnail}（うち key 抽出可: ${summary.thumbnailMappable}）`);
  log("");
  log("注: 非対応 MIME / unmappable は遡及 strip の対象外として残ります（別承認の領域）。");
  return 0;
}

async function runDryRun(
  prisma: PrismaClient,
  options: RetroStripCliOptions,
): Promise<number> {
  const storage = getStorage();
  const ports = makeDryRunPorts((key) => storage.read(key));

  // JSONL run-log（指定時のみ）。最初に空で作成し、以後追記する。
  if (options.jsonlPath) {
    writeFileSync(options.jsonlPath, "");
    log(`run-log（JSONL・非 PII）: ${options.jsonlPath}`);
  } else {
    log("注: --jsonl 未指定のため per-row 詳細（photoId 別 outcome）は出力されません（集計のみ）。");
  }
  const onLine = (line: RetroStripRunLogLine): void => {
    if (options.jsonlPath) {
      appendFileSync(options.jsonlPath, `${JSON.stringify(line)}\n`);
    }
  };

  // prisma ページングを AsyncIterable に変換して lib の dry-run runner へ渡す。
  async function* rowSource(): AsyncGenerator<RetroStripRowInput> {
    let cursor: string | null = null;
    let yielded = 0;
    for (;;) {
      const batch: RetroStripRowInput[] = await prisma.fieldSurveyPinPhoto.findMany({
        select: SELECT_ROW,
        orderBy: { id: "asc" },
        take: options.batchSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (batch.length === 0) break;
      for (const r of batch) {
        yield r;
        yielded += 1;
        if (options.limit !== null && yielded >= options.limit) return;
      }
      cursor = batch[batch.length - 1].id;
    }
  }

  const result = await runRetroStripDryRun(rowSource(), ports, onLine);

  log("");
  log("--- dry-run 結果（storage read + strip in-memory・書き込みなし）---");
  log(`処理件数: ${result.processed}`);
  for (const [outcome, count] of Object.entries(result.summary)) {
    log(`  ${outcome}: ${count}`);
  }
  log("");
  log(
    "注: would_strip = 実 strip で変更される見込みの件数。実際の更新（新 key + repoint）は未実装（別承認）。",
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const name = error instanceof Error ? error.name : typeof error;
    // メッセージ本文は出さない（path / PII 混入の可能性）。name のみ。
    process.stderr.write(`予期しないエラーで停止しました: ${name}\n`);
    process.exitCode = 1;
  });
