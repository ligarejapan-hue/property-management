/**
 * 既存 field-survey 写真の遡及 EXIF/GPS strip — inventory / dry-run / apply CLI。
 *
 * モード:
 *   --inventory   DB のみ集計（READ のみ・storage 未読）。
 *   --dry-run     storage read + strip を in-memory で実施（書き込みなし）。
 *   --apply       実 strip（新 key 再アップロード + 楽観ガード付き DB repoint）。
 *                 旧 key / 旧 thumbnail key は削除しない（rollback 窓・cleanup は別承認 PR-R2c）。
 *
 * ⚠ --apply は本番データを変更します。実行は docs/field-survey-retro-exif-strip-runbook.md の
 *    手順（DB backup・inventory/dry-run レビュー・低トラフィック窓・別承認）に従ってください。
 *
 * 実行（VPS では devDeps の tsx が必要。`npm ci --include=dev` 後・prune 前に実行）:
 *   npx tsx scripts/retro-exif-strip-field-survey.ts --inventory
 *   npx tsx scripts/retro-exif-strip-field-survey.ts --dry-run --jsonl /tmp/retro-dryrun.jsonl
 *   npx tsx scripts/retro-exif-strip-field-survey.ts --apply   --jsonl /tmp/retro-apply.jsonl
 *   npx tsx scripts/retro-exif-strip-field-survey.ts --help
 *
 * 設計:
 *   - 判定/集計/配線ロジックは src/lib/field-survey/retro-exif-strip-cli.ts（純関数・テスト済）。
 *   - 本ファイルは I/O（prisma READ/repoint・storage read/upload/delete・JSONL 追記・stdout）に
 *     限定した薄い wrapper。repoint の updateMany 形は makeUpdateManyRepointPhoto（lib・型固定・
 *     テスト済）に集約し、ここでは更新 data を手書きしない。
 *   - exit code（apply）: 0=clean / 1=failed>0 / 2=skipped_row_changed>0（再実行推奨）。
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
  runRetroStripApply,
  makeDryRunPorts,
  makeApplyPorts,
  makeUpdateManyRepointPhoto,
  applyExitCode,
  type InventoryRowInput,
  type RetroStripCliOptions,
  type RetroStripRunLogLine,
} from "../src/lib/field-survey/retro-exif-strip-cli";
import type { RetroStripRowInput } from "../src/lib/field-survey/retro-exif-strip";

const HELP_TEXT = `
field-survey 遡及 EXIF/GPS strip — inventory / dry-run / apply CLI

使い方:
  npx tsx scripts/retro-exif-strip-field-survey.ts <mode> [options]

mode（いずれか必須・排他）:
  --inventory          DB のみを集計（storage は読まない）。件数 / mimeType 分布 /
                       mappable / unmappable / legacy absolute / 非対応 MIME /
                       thumbnail 有無 を表示。
  --dry-run            storage read + strip を in-memory で実施し、outcome を集計。
                       **書き込みは一切しない**（upload/delete/repoint なし）。
  --apply              実 strip。新 key で再アップロードし、楽観ガード付きで DB を repoint。
                       旧 key / 旧 thumbnail key は削除しない（rollback 窓・cleanup は別承認）。
                       ⚠ 本番データを変更します（runbook の手順・別承認に従うこと）。

options:
  --jsonl <path>       run-log を JSONL で出力（非 PII）。apply では保存を推奨。
  --batch-size <n>     1 バッチの取得件数（既定 500）。
  --limit <n>          処理対象の上限（部分確認用）。
  --help, -h           このヘルプ。

apply の exit code:
  0  clean（failed なし・並行変更なし）
  1  failed > 0（要調査）
  2  failed なし・skipped_row_changed > 0（並行変更＝再実行で収束を推奨）

注意:
  - inventory / dry-run は本番 DB / storage を変更しません（READ のみ）。
  - apply は新 key の upload と DB repoint を行います（旧 key は保持）。
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
  if (options.mode === "apply") {
    log("⚠⚠ APPLY モード: 実 strip を実行します（新 key 再アップロード + DB repoint）。");
    log("   旧 key / 旧 thumbnail key は削除しません（rollback 窓として保持。cleanup は別承認の PR-R2c）。");
    log("   事前に inventory / dry-run のレビューと DB backup を完了していること（runbook 参照）。");
  } else {
    log("⚠ INVENTORY/DRY-RUN: DB 更新・storage 書き込み・repoint・cleanup は行いません（READ のみ）。");
  }

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
    if (options.mode === "dry-run") {
      return await runDryRun(prisma, options);
    }
    return await runApply(prisma, options);
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

// prisma ページングを AsyncIterable に変換する（dry-run / apply 共用）。
// 全行をメモリに保持せず cursor ページングで逐次 yield する。
function makeRowSource(
  prisma: PrismaClient,
  options: RetroStripCliOptions,
): AsyncGenerator<RetroStripRowInput> {
  async function* gen(): AsyncGenerator<RetroStripRowInput> {
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
  return gen();
}

// JSONL run-log の sink を作る（指定時のみ）。最初に空で作成し、以後 1 行ずつ追記する（非 PII）。
function makeJsonlSink(
  jsonlPath: string | null,
): (line: RetroStripRunLogLine) => void {
  if (jsonlPath) {
    writeFileSync(jsonlPath, "");
  }
  return (line) => {
    if (jsonlPath) {
      appendFileSync(jsonlPath, `${JSON.stringify(line)}\n`);
    }
  };
}

async function runDryRun(
  prisma: PrismaClient,
  options: RetroStripCliOptions,
): Promise<number> {
  const storage = getStorage();
  const ports = makeDryRunPorts((key) => storage.read(key));

  if (options.jsonlPath) {
    log(`run-log（JSONL・非 PII）: ${options.jsonlPath}`);
  } else {
    log("注: --jsonl 未指定のため per-row 詳細（photoId 別 outcome）は出力されません（集計のみ）。");
  }
  const onLine = makeJsonlSink(options.jsonlPath);

  const result = await runRetroStripDryRun(makeRowSource(prisma, options), ports, onLine);

  log("");
  log("--- dry-run 結果（storage read + strip in-memory・書き込みなし）---");
  log(`処理件数: ${result.processed}`);
  for (const [outcome, count] of Object.entries(result.summary)) {
    log(`  ${outcome}: ${count}`);
  }
  log("");
  log(
    "注: would_strip = 実 strip で変更される見込みの件数。実反映は --apply（別承認・runbook 参照）。",
  );
  return 0;
}

async function runApply(
  prisma: PrismaClient,
  options: RetroStripCliOptions,
): Promise<number> {
  const storage = getStorage();
  // storage 実体（read/upload/delete）と楽観ガード付き repoint（updateMany）を注入する。
  // repoint の更新 data の形（where=id+fileUrl / data=新 URL・新サムネ URL・新バイト長／
  // mimeType は含めない）は makeUpdateManyRepointPhoto（lib・型固定・テスト済）に集約する。
  const ports = makeApplyPorts({
    storage: {
      read: (key) => storage.read(key),
      upload: (buffer, opts) => storage.upload(buffer, opts),
      delete: (key) => storage.delete(key),
    },
    repointPhoto: makeUpdateManyRepointPhoto((args) =>
      prisma.fieldSurveyPinPhoto.updateMany(args),
    ),
  });

  if (options.jsonlPath) {
    log(`run-log（JSONL・非 PII）: ${options.jsonlPath}`);
  } else {
    log("注: --jsonl 未指定のため per-row 詳細（photoId 別 outcome / 新 key）は出力されません（集計のみ）。");
    log("    apply では run-log の保存を推奨します（rollback / cleanup 判断の根拠になります）。");
  }
  const onLine = makeJsonlSink(options.jsonlPath);

  const result = await runRetroStripApply(makeRowSource(prisma, options), ports, onLine);

  log("");
  log("--- apply 結果（新 key 再アップロード + DB repoint・旧 key は保持）---");
  log(`処理件数: ${result.processed}`);
  for (const [outcome, count] of Object.entries(result.summary)) {
    log(`  ${outcome}: ${count}`);
  }
  const code = applyExitCode(result.summary);
  log("");
  if (code === 0) {
    log("結果: clean（failed なし・並行変更なし）。検証は runbook（再 dry-run で changed=0 確認）参照。");
  } else if (code === 1) {
    log("結果: failed > 0。要調査（read/upload/repoint 例外・非 canonical key 等）。run-log を確認してください。");
  } else {
    log("結果: 並行変更（skipped_row_changed）あり・failed なし。低トラフィック窓で再実行すると収束します。");
  }
  log("注: 旧 key / 旧 thumbnail key は削除していません（cleanup は別承認の PR-R2c）。");
  return code;
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
