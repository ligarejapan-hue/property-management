#!/usr/bin/env node
// @ts-check
/**
 * scripts/migrate-local-to-s3.mjs
 *
 * LOCAL_UPLOAD_ROOT 配下のファイルを S3 互換 backend (AWS S3 / R2 / MinIO) に
 * 同一 key でアップロードする one-shot migration script。
 *
 * 安全のためデフォルトは **dry-run**。`--apply` を明示指定したときだけ実 PUT する。
 * 既存 key は S3 側に存在すれば skip（冪等）。CI 等の自動実行は想定しない。
 *
 * 使い方:
 *   # dry-run (デフォルト)
 *   node scripts/migrate-local-to-s3.mjs
 *
 *   # 実コピー
 *   node scripts/migrate-local-to-s3.mjs --apply
 *
 *   # 任意オプション
 *   node scripts/migrate-local-to-s3.mjs --apply --concurrency=4
 *
 * 必須 env (.env で設定):
 *   STORAGE_S3_BUCKET
 *   STORAGE_S3_REGION
 *   STORAGE_S3_ACCESS_KEY_ID
 *   STORAGE_S3_SECRET_ACCESS_KEY
 *   (任意) STORAGE_S3_ENDPOINT / STORAGE_S3_FORCE_PATH_STYLE
 *   (任意) LOCAL_UPLOAD_ROOT (デフォルト: <cwd>/public/uploads)
 *
 * 注意:
 *   - DB は触らない。`fileUrl` の値は変えない。
 *   - 既存ファイルは local にも残る（cutover 後の手動削除を想定）。
 *   - 1 ファイル失敗で中断せず、最後に集計してから非 0 終了する。
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

const EXT_MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
};

function parseArgs(argv) {
  const args = { apply: false, concurrency: 2 };
  for (const a of argv) {
    if (a === "--apply") args.apply = true;
    else if (a === "--dry-run") args.apply = false;
    else if (a.startsWith("--concurrency=")) {
      const n = Number(a.split("=")[1]);
      if (Number.isFinite(n) && n >= 1 && n <= 32) args.concurrency = n;
    }
  }
  return args;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`${name} is not configured. Set it in .env.`);
  }
  return v;
}

function localUploadRoot() {
  const fromEnv = process.env.LOCAL_UPLOAD_ROOT;
  if (fromEnv && fromEnv.trim() !== "") return path.resolve(fromEnv.trim());
  return path.join(process.cwd(), "public", "uploads");
}

async function* walkFiles(root) {
  // 再帰的にファイルを yield。シンボリックリンクは辿らない。
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      console.warn(`[warn] cannot read dir ${dir}: ${err?.message ?? err}`);
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue; // 安全側で skip
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) yield full;
    }
  }
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_MIME[ext] ?? "application/octet-stream";
}

function toKey(root, absPath) {
  return path.relative(root, absPath).split(path.sep).join("/");
}

async function existsInS3(client, bucket, key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    const code = err?.$metadata?.httpStatusCode;
    if (code === 404 || err?.name === "NotFound" || err?.name === "NoSuchKey") {
      return false;
    }
    throw err;
  }
}

async function uploadOne(client, bucket, key, absPath) {
  const body = await fs.readFile(absPath);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: mimeFor(absPath),
    }),
  );
}

async function runConcurrently(items, concurrency, worker) {
  const queue = items.slice();
  const errors = [];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) return;
      try {
        await worker(item);
      } catch (err) {
        errors.push({ item, err });
      }
    }
  });
  await Promise.all(workers);
  return errors;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = localUploadRoot();
  const bucket = requireEnv("STORAGE_S3_BUCKET");
  const region = requireEnv("STORAGE_S3_REGION");
  const accessKeyId = requireEnv("STORAGE_S3_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("STORAGE_S3_SECRET_ACCESS_KEY");
  const endpoint = process.env.STORAGE_S3_ENDPOINT?.trim() || undefined;
  const forcePathStyle =
    (process.env.STORAGE_S3_FORCE_PATH_STYLE ?? "false")
      .trim()
      .toLowerCase() === "true";

  console.log("[migrate-local-to-s3]");
  console.log(`  mode        : ${args.apply ? "APPLY (will write)" : "DRY-RUN (read-only)"}`);
  console.log(`  source root : ${root}`);
  console.log(`  bucket      : ${bucket}`);
  console.log(`  region      : ${region}`);
  console.log(`  endpoint    : ${endpoint ?? "(default AWS)"}`);
  console.log(`  forcePath   : ${forcePathStyle}`);
  console.log(`  concurrency : ${args.concurrency}`);

  let rootStat;
  try {
    rootStat = await fs.stat(root);
  } catch {
    console.error(`[error] source root does not exist: ${root}`);
    process.exit(1);
  }
  if (!rootStat.isDirectory()) {
    console.error(`[error] source root is not a directory: ${root}`);
    process.exit(1);
  }

  const client = new S3Client({
    region,
    endpoint,
    forcePathStyle,
    credentials: { accessKeyId, secretAccessKey },
  });

  // 1. ファイル一覧収集
  const files = [];
  for await (const f of walkFiles(root)) files.push(f);
  console.log(`[info] discovered ${files.length} files`);

  // 2. plan: 既存 skip 判定
  let toUpload = 0;
  let toSkip = 0;
  const planErrors = [];
  const planned = [];
  await runConcurrently(files, args.concurrency, async (abs) => {
    const key = toKey(root, abs);
    let exists;
    try {
      exists = await existsInS3(client, bucket, key);
    } catch (err) {
      planErrors.push({ key, err });
      return;
    }
    if (exists) {
      toSkip++;
    } else {
      toUpload++;
      planned.push({ abs, key });
    }
  });

  console.log(`[plan ] to upload : ${toUpload}`);
  console.log(`[plan ] to skip   : ${toSkip} (already in S3)`);
  if (planErrors.length > 0) {
    console.error(`[plan ] head errors: ${planErrors.length}`);
    for (const e of planErrors.slice(0, 10)) {
      console.error(`        - ${e.key}: ${e.err?.message ?? e.err}`);
    }
  }

  if (!args.apply) {
    console.log("[dry-run] no writes performed. pass --apply to upload.");
    process.exit(planErrors.length > 0 ? 2 : 0);
  }

  // 3. apply: 実 PUT
  console.log(`[apply] uploading ${planned.length} files...`);
  const uploadErrors = await runConcurrently(
    planned,
    args.concurrency,
    async ({ abs, key }) => {
      await uploadOne(client, bucket, key, abs);
      console.log(`  ok  ${key}`);
    },
  );

  console.log("");
  console.log(`[done] uploaded : ${planned.length - uploadErrors.length}`);
  console.log(`[done] skipped  : ${toSkip}`);
  console.log(`[done] failed   : ${uploadErrors.length + planErrors.length}`);
  if (uploadErrors.length > 0) {
    for (const e of uploadErrors.slice(0, 10)) {
      console.error(`  err ${e.item.key}: ${e.err?.message ?? e.err}`);
    }
    process.exit(2);
  }
  if (planErrors.length > 0) process.exit(2);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[fatal] ${err?.message ?? err}`);
  process.exit(1);
});
