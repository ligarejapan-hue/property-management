/**
 * 既存 field-survey 写真の遡及 EXIF strip — cleanup dry-run 列挙 CLI（PR-R2c-i）。
 *
 * これは **dry-run 列挙のみ**。apply の JSONL run-log を読み、repointed 行の
 * 旧 key / 旧 thumbnail key を「削除対象候補」として分類して報告するだけで、
 * storage からは一切削除しない（実削除の配線は別承認の PR-R2c-ii）。
 *
 * 使い方（VPS では devDeps の tsx が必要。`npm ci --include=dev` 後・prune 前に実行）:
 *   npx tsx scripts/retro-exif-strip-cleanup-field-survey.ts --apply-run-log /tmp/retro-apply.jsonl
 *   npx tsx scripts/retro-exif-strip-cleanup-field-survey.ts --apply-run-log /tmp/retro-apply.jsonl --out /tmp/cleanup-dryrun.jsonl
 *   npx tsx scripts/retro-exif-strip-cleanup-field-survey.ts --help
 *
 * 設計:
 *   - 判定 / 集計 / parse ロジックは src/lib/field-survey/retro-exif-strip-cleanup.ts
 *     （純関数・テスト済）。本ファイルは I/O（run-log の逐次読み込み・prisma READ・stdout・
 *     JSONL 追記）に限定した薄い wrapper。
 *   - 入力 run-log は readline で 1 行ずつ streaming（全文一括 read でバッファしない）。
 *   - DB 再確認は prisma.fieldSurveyPinPhoto.findUnique（READ のみ）。
 *   - cleanup でも STORAGE_BACKEND の fail-closed 方針を維持する（resolveApplyStorageBackend を
 *     流用）。R2c-i は storage を読み書きしないが、R2c-ii の実削除と同じ backend 明示の規律を
 *     dry-run の時点から課し、稼働 app と異なる backend に対する誤った想定を防ぐ。
 *   - NEXT_PUBLIC_USE_MOCK=true では停止（mock は実データを反映しない）。
 *   - 出力は非 PII（key の path / 数値 / enum のみ）。
 */

import {
  createReadStream,
  existsSync,
  realpathSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { PrismaClient } from "../src/generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { getStorage } from "../src/lib/storage";
import {
  assertSafeEnvironment,
  resolveApplyStorageBackend,
} from "../src/lib/field-survey/retro-exif-strip-cli";
import {
  parseCleanupCliArgs,
  runCleanupDryRun,
  runCleanupDelete,
  cleanupDryRunExitCode,
  cleanupDeleteExitCode,
  isSameIoPath,
  type CleanupCliOptions,
  type CleanupCurrentRow,
  type CleanupDeletePorts,
} from "../src/lib/field-survey/retro-exif-strip-cleanup";

const HELP_TEXT = `
field-survey 遡及 EXIF strip — cleanup CLI（dry-run 列挙 PR-R2c-i / 実削除 PR-R2c-ii）

apply の JSONL run-log を読み、repointed 行の旧 key / 旧 thumbnail key を分類します。
既定は **dry-run（列挙のみ・storage 非削除）**。--delete --confirm の二重ゲートを指定したときだけ
deletable と判定した旧 key を storage から実削除します（DB は変更しません＝repoint 済の行はそのまま）。

使い方:
  # dry-run（列挙のみ・削除しない）
  npx tsx scripts/retro-exif-strip-cleanup-field-survey.ts --apply-run-log <path> [--out <path>]
  # 実削除（二重ゲート + delete log 必須）
  npx tsx scripts/retro-exif-strip-cleanup-field-survey.ts --apply-run-log <path> --delete --confirm --out <delete-log>

必須:
  --apply-run-log <path>   削除対象の権威ソース = apply 時に保存した JSONL run-log。

options:
  --out <path>             JSONL 出力（dry-run は任意 / 実削除では必須＝不可逆操作の証跡）。
  --delete                 実削除ゲート 1（--confirm と併用必須）。
  --confirm                実削除ゲート 2（--delete と併用必須）。
  --help, -h               このヘルプ。

分類（outcome）:
  deletable                  （dry-run）現 DB は new key を指す → 実削除対象になる候補。
  deleted                    （実削除）storage から削除した（throw なしで完了）。
  delete_failed              （実削除）storage 削除が失敗した（orphan 残存・errorName のみ記録）。
  skipped_still_referenced   現 DB がまだ旧 key を参照（手動 rollback / 未 repoint）→ 削除しない。
  skipped_unmappable         現 URL から key を復元できない → 非参照を証明できず削除しない。
  skipped_row_missing        該当行が現 DB に無い（cascade 削除）。
  skipped_invalid_key        候補 key が非 canonical（traversal / ? / # 等）。
  skipped_not_repointed      run-log 行が repointed 以外（新 key 孤児等・別スコープ）。
  malformed_line             run-log 行が壊れている（fail-closed skip）。

exit code（dry-run）: 0 clean / 1 malformed_line>0 / 2 skipped_still_referenced>0
exit code（実削除）:  0 clean / 1 malformed_line>0 / 3 delete_failed>0 / 2 skipped_still_referenced>0

注意:
  - dry-run は READ のみ。実削除は storage 実体のみ削除（DB は変更しません）。
  - 実削除の前に dry-run を実行し exit 0（malformed / still_referenced なし）を確認してください。
  - STORAGE_BACKEND は稼働 app と一致させて明示してください（未設定では停止）。
  - NEXT_PUBLIC_USE_MOCK=true では停止します（mock は実データを反映しないため）。
  - VPS では devDeps の tsx が必要です（npm ci --include=dev 後・prune 前）。
`.trim();

function log(message: string): void {
  // 非 PII のみ。写真内容 / EXIF / 座標 / 所有者情報は出力しない。
  process.stdout.write(`${message}\n`);
}

// cleanup の JSONL sink（指定時のみ）。最初に空で作成し、以後 1 行ずつ追記する（非 PII）。
// dry-run / delete 両方の出力行（いずれも非 PII の whitelist 形）に共通利用する。
function makeJsonlSink<T>(outPath: string | null): (line: T) => void {
  if (outPath) {
    writeFileSync(outPath, "");
  }
  return (line) => {
    if (outPath) {
      appendFileSync(outPath, `${JSON.stringify(line)}\n`);
    }
  };
}

// 入力（--apply-run-log）と出力（--out）が同一ファイルかを判定する（P2-1）。
// lib の字句的判定（isSameIoPath）に加え、両方が存在する場合は realpath で symlink / hardlink
// 由来の実体一致も検出する。同一なら出力 sink の truncate が入力を破壊するため拒否に使う。
function isSameInputOutput(applyRunLogPath: string, outPath: string): boolean {
  if (isSameIoPath(applyRunLogPath, outPath)) return true;
  try {
    if (existsSync(applyRunLogPath) && existsSync(outPath)) {
      return realpathSync.native(applyRunLogPath) === realpathSync.native(outPath);
    }
  } catch {
    // realpath 失敗時は字句的判定（既に false）に委ねる。
  }
  return false;
}

async function main(): Promise<number> {
  const parsed = parseCleanupCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`エラー: ${parsed.error}\n\n${HELP_TEXT}\n`);
    return 1;
  }
  const options = parsed.options;
  if (options.help) {
    log(HELP_TEXT);
    return 0;
  }

  // P2-1: 出力 sink（writeFileSync で truncate）を開く前に、入力 = 削除の権威ソースである
  // apply run-log を上書きしないことを保証する。同一ファイルなら即停止（truncate より前）。
  if (
    options.outPath !== null &&
    isSameInputOutput(options.applyRunLogPath, options.outPath)
  ) {
    process.stderr.write(
      "停止: --out は入力 run-log（--apply-run-log）と同一ファイルにできません" +
        "（入力 = 削除対象の権威ソースの破壊を防ぐため）。\n",
    );
    return 1;
  }

  // 安全ガード（DB へ接続する前に判定する）。
  const guard = assertSafeEnvironment(process.env);
  if (!guard.ok) {
    process.stderr.write(`停止: ${guard.reason}\n`);
    return 1;
  }

  // cleanup でも STORAGE_BACKEND 明示の fail-closed を維持する（R2c-i は storage 非アクセスだが、
  // R2c-ii の実削除と同じ backend 規律を dry-run から課す）。
  const backendCheck = resolveApplyStorageBackend(process.env);
  if (!backendCheck.ok) {
    process.stderr.write(`停止: ${backendCheck.reason}\n`);
    return 1;
  }

  if (!existsSync(options.applyRunLogPath)) {
    process.stderr.write(
      `停止: 入力 run-log が見つかりません: ${options.applyRunLogPath}\n`,
    );
    return 1;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    process.stderr.write("停止: DATABASE_URL が設定されていません。\n");
    return 1;
  }
  const adapter = new PrismaPg(connectionString);
  const prisma = new PrismaClient({ adapter });

  try {
    // 二重ゲート: --delete && --confirm の両方がそろったときだけ実削除経路へ。
    // それ以外（フラグ無し）は dry-run 列挙（R2c-i・storage 非取得）。
    if (options.delete && options.confirm) {
      return await runDelete(prisma, options, backendCheck.backend);
    }
    return await runCleanup(prisma, options, backendCheck.backend);
  } finally {
    await prisma.$disconnect();
  }
}

async function runCleanup(
  prisma: PrismaClient,
  options: CleanupCliOptions,
  backend: string,
): Promise<number> {
  log("=== field-survey 遡及 EXIF strip cleanup dry-run（列挙のみ・削除しません）===");
  log(`storage backend（明示確認済み）: ${backend}`);
  log(`入力 run-log（apply の JSONL）: ${options.applyRunLogPath}`);
  if (options.outPath) {
    log(`cleanup dry-run 出力（JSONL・非 PII）: ${options.outPath}`);
  } else {
    log("注: --out 未指定のため per-candidate 詳細は出力されません（集計のみ）。");
  }

  // DB 再確認 port（READ のみ）。現 fileUrl / thumbnailUrl が候補 key をまだ参照しているか判定する。
  const lookupRow = async (
    photoId: string,
  ): Promise<CleanupCurrentRow | null> =>
    prisma.fieldSurveyPinPhoto.findUnique({
      where: { id: photoId },
      select: { fileUrl: true, thumbnailUrl: true },
    });

  // 入力 run-log を 1 行ずつ streaming（全文一括 read でバッファしない）。
  const rl = createInterface({
    input: createReadStream(options.applyRunLogPath, "utf8"),
    crlfDelay: Infinity,
  });

  const onLine = makeJsonlSink(options.outPath);
  const result = await runCleanupDryRun(rl, { lookupRow }, onLine);

  log("");
  log("--- cleanup dry-run 結果（削除はしていません）---");
  log(`処理行数（非空）: ${result.lines}`);
  for (const [outcome, count] of Object.entries(result.summary)) {
    log(`  ${outcome}: ${count}`);
  }

  const code = cleanupDryRunExitCode(result.summary);
  log("");
  if (code === 0) {
    log("結果: clean。deletable は R2c-ii の実削除候補です（実削除は別承認・runbook 参照）。");
  } else if (code === 1) {
    log("結果: malformed_line > 0。入力 run-log が破損しています。要調査（実削除へ進まないこと）。");
  } else {
    log(
      "結果: skipped_still_referenced > 0。現 DB がまだ旧 key を参照しています（手動 rollback / 未 repoint の疑い）。実削除前に要調査。",
    );
  }
  log("注: 本コマンドは何も削除していません（cleanup の実削除は --delete --confirm・PR-R2c-ii）。");
  return code;
}

/**
 * 実削除（PR-R2c-ii）。二重ゲート（--delete && --confirm）通過後にのみ呼ばれる。
 * deletable と判定した候補のみ storage 実体を削除する（DB は変更しない＝repoint 済の行はそのまま）。
 * 実 storage（getStorage）の取得は、resolveApplyStorageBackend による backend 明示検証の後・
 * かつ本関数（delete ゲートの内側）でのみ行う。lib は getStorage / storage 実体を import しない。
 */
async function runDelete(
  prisma: PrismaClient,
  options: CleanupCliOptions,
  backend: string,
): Promise<number> {
  log("=== field-survey 遡及 EXIF strip cleanup 実削除（--delete --confirm）===");
  log("⚠⚠ 実削除モード: deletable と判定した旧 key / 旧 thumbnail key を storage から削除します（不可逆）。");
  log(`storage backend（明示確認済み）: ${backend}`);
  log(`入力 run-log（apply の JSONL）: ${options.applyRunLogPath}`);
  // --out は実削除モードで必須（parse で保証）。不可逆操作ゆえ delete log を必ず残す。
  log(`delete log（JSONL・非 PII）: ${options.outPath}`);

  // DB 再確認 port（READ のみ）。delete 直前にも現 fileUrl / thumbnailUrl を再確認する。
  const lookupRow = async (
    photoId: string,
  ): Promise<CleanupCurrentRow | null> =>
    prisma.fieldSurveyPinPhoto.findUnique({
      where: { id: photoId },
      select: { fileUrl: true, thumbnailUrl: true },
    });

  // 実 storage の取得は二重ゲート通過後・backend 明示検証後・本関数の内側でのみ。
  const storage = getStorage();
  const ports: CleanupDeletePorts = {
    lookupRow,
    deleteObject: (key) => storage.delete(key),
  };

  const rl = createInterface({
    input: createReadStream(options.applyRunLogPath, "utf8"),
    crlfDelay: Infinity,
  });

  const onLine = makeJsonlSink(options.outPath);
  const result = await runCleanupDelete(rl, ports, onLine);

  log("");
  log("--- cleanup 実削除 結果（storage 実体のみ削除・DB 非変更）---");
  log(`処理行数（非空）: ${result.lines}`);
  for (const [outcome, count] of Object.entries(result.summary)) {
    log(`  ${outcome}: ${count}`);
  }

  const code = cleanupDeleteExitCode(result.summary);
  log("");
  if (code === 0) {
    log("結果: clean（deleted / 期待 skip のみ・delete_failed なし）。");
  } else if (code === 1) {
    log("結果: malformed_line > 0。入力 run-log が破損しています。要調査。");
  } else if (code === 3) {
    log("結果: delete_failed > 0。一部の storage 削除に失敗しました（orphan 残存）。delete log を確認し手動対応してください。");
  } else {
    log("結果: skipped_still_referenced > 0。現 DB がまだ旧 key を参照（手動 rollback / 未 repoint の疑い）。要調査。");
  }
  log("注: DB は変更していません（repoint 済の行はそのまま・本コマンドは storage 実体のみ削除）。");
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
