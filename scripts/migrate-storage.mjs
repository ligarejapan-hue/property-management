/**
 * Storage Migration Script
 *
 * Migrates files from local storage (public/uploads/) to the server storage backend.
 * Updates database URLs for property_photos and attachments.
 *
 * Usage:
 *   # Dry run (shows what would be migrated)
 *   node scripts/migrate-storage.mjs --dry-run
 *
 *   # Actual migration
 *   node scripts/migrate-storage.mjs
 *
 * Prerequisites:
 *   - STORAGE_SERVER_URL and STORAGE_SERVER_API_KEY must be set in .env
 *   - The storage server must be running and accessible
 *   - The local files must exist in public/uploads/
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const UPLOAD_DIR = path.join(ROOT, "public", "uploads");

// Load .env
const envPath = path.join(ROOT, ".env");
try {
  const envText = await fs.readFile(envPath, "utf8");
  for (const line of envText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  // .env not found, rely on system env
}

const SERVER_URL = (process.env.STORAGE_SERVER_URL ?? "").replace(/\/+$/, "");
const API_KEY = process.env.STORAGE_SERVER_API_KEY ?? "";
const BUCKET = process.env.STORAGE_SERVER_BUCKET ?? "property-management";
const DRY_RUN = process.argv.includes("--dry-run");

if (!SERVER_URL || !API_KEY) {
  console.error("Error: STORAGE_SERVER_URL and STORAGE_SERVER_API_KEY must be set.");
  console.error("Set them in .env or as environment variables.");
  process.exit(1);
}

// Dynamic import pg for direct DB access (no Prisma needed)
let pg;
try {
  pg = await import("pg");
} catch {
  console.error("Error: pg package not found. Run: npm install pg");
  process.exit(1);
}

const DB_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/property_management";
const pool = new pg.default.Pool({ connectionString: DB_URL });

async function uploadToServer(filePath, key, mimeType) {
  const fileBuffer = await fs.readFile(filePath);
  const blob = new Blob([fileBuffer], { type: mimeType });
  const formData = new FormData();
  formData.append("file", blob, path.basename(filePath));
  formData.append("key", key);
  formData.append("bucket", BUCKET);

  const res = await fetch(`${SERVER_URL}/upload`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${API_KEY}` },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Upload failed (${res.status}): ${err}`);
  }

  return await res.json();
}

function guessMimeType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const map = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".webp": "image/webp",
    ".heic": "image/heic", ".heif": "image/heif",
    ".pdf": "application/pdf",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".csv": "text/csv",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  return map[ext] ?? "application/octet-stream";
}

async function collectLocalFiles(dir, prefix = "") {
  const entries = [];
  try {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        entries.push(...await collectLocalFiles(path.join(dir, item.name), rel));
      } else {
        entries.push({ path: path.join(dir, item.name), key: rel });
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return entries;
}

async function main() {
  console.log("=== Storage Migration ===");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`Server: ${SERVER_URL}`);
  console.log(`Bucket: ${BUCKET}`);
  console.log("");

  // 1. Collect all local files
  const localFiles = await collectLocalFiles(UPLOAD_DIR);
  console.log(`Found ${localFiles.length} local files to migrate.\n`);

  if (localFiles.length === 0) {
    console.log("No files to migrate. Exiting.");
    await pool.end();
    return;
  }

  // 2. Upload files to server
  let uploadOk = 0;
  let uploadFail = 0;
  const urlMap = new Map(); // old local path -> new server URL

  for (const file of localFiles) {
    const localUrl = `/uploads/${file.key.replace(/\\/g, "/")}`;
    const mimeType = guessMimeType(file.path);

    if (DRY_RUN) {
      console.log(`  [DRY] Would upload: ${file.key} (${mimeType})`);
      urlMap.set(localUrl, `${SERVER_URL}/${BUCKET}/${file.key}`);
      uploadOk++;
      continue;
    }

    try {
      const result = await uploadToServer(file.path, file.key, mimeType);
      urlMap.set(localUrl, result.url);
      console.log(`  OK: ${file.key} -> ${result.url}`);
      uploadOk++;
    } catch (err) {
      console.error(`  FAIL: ${file.key}: ${err.message}`);
      uploadFail++;
    }
  }

  console.log(`\nUpload results: ${uploadOk} ok, ${uploadFail} failed\n`);

  // 3. Update database URLs
  // property_photos: file_url, thumbnail_url columns
  // attachments: file_url column
  let dbUpdated = 0;

  const photoRows = await pool.query(
    "SELECT id, file_url, thumbnail_url FROM property_photos WHERE file_url LIKE '/uploads/%'"
  );
  for (const row of photoRows.rows) {
    const newUrl = urlMap.get(row.file_url);
    const newThumb = row.thumbnail_url ? urlMap.get(row.thumbnail_url) : null;
    if (newUrl) {
      if (DRY_RUN) {
        console.log(`  [DRY] Would update photo ${row.id}: ${row.file_url} -> ${newUrl}`);
      } else {
        await pool.query(
          "UPDATE property_photos SET file_url = $1, thumbnail_url = $2 WHERE id = $3",
          [newUrl, newThumb ?? row.thumbnail_url, row.id]
        );
        console.log(`  Updated photo ${row.id}`);
      }
      dbUpdated++;
    }
  }

  const attachRows = await pool.query(
    "SELECT id, file_url FROM attachments WHERE file_url LIKE '/uploads/%'"
  );
  for (const row of attachRows.rows) {
    const newUrl = urlMap.get(row.file_url);
    if (newUrl) {
      if (DRY_RUN) {
        console.log(`  [DRY] Would update attachment ${row.id}: ${row.file_url} -> ${newUrl}`);
      } else {
        await pool.query(
          "UPDATE attachments SET file_url = $1 WHERE id = $2",
          [newUrl, row.id]
        );
        console.log(`  Updated attachment ${row.id}`);
      }
      dbUpdated++;
    }
  }

  console.log(`\nDB updates: ${dbUpdated} rows ${DRY_RUN ? "would be " : ""}updated`);
  console.log("\n=== Migration complete ===");

  if (!DRY_RUN && uploadFail === 0 && localFiles.length > 0) {
    console.log("\nAll files migrated successfully.");
    console.log("You can now:");
    console.log("  1. Set STORAGE_BACKEND=server in .env");
    console.log("  2. Restart the application");
    console.log("  3. Verify uploads work in the UI");
    console.log("  4. Optionally remove public/uploads/ after confirming");
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
