import { timingSafeEqual } from "crypto";
import { createReadStream, readdirSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";
import { ApiError, handleApiError, apiResponse } from "@/lib/api-helpers";
import { loadCatalogLines } from "@/lib/mansion-catalog/load";
import { createPrismaLinkDeps, linkExistingBuildings } from "@/lib/mansion-catalog/link-existing";
import { createPrismaCatalogStore } from "@/lib/mansion-catalog/store";

/**
 * POST /api/mansion-catalog/load-run — 集めたマンション一覧(JSONL)を名簿に読み込む(設計 2026-10-18 §4)。
 * 作りは国交省の業者一覧の crawl-run と同じ:
 * - `MANSION_CATALOG_LOAD_SECRET` 未設定なら 503(休眠)・header `x-mansion-catalog-secret` 不一致は 403
 * - 読むのは `MANSION_CATALOG_DIR` の `buildings-<2桁>.jsonl` だけ(未設定なら 503)
 * - ⚠`src/proxy.ts` の `PUBLIC_EXACT_PATHS` に本パスが必要
 * - 返す・ログに出すのは件数だけ(建物名・住所を出さない)
 */
let running = false;
const FILE_RE = /^buildings-\d{2}\.jsonl$/;

async function* readLines(dir: string, files: string[]) {
  for (const f of files) {
    const rl = createInterface({ input: createReadStream(join(dir, f), { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) if (line.trim() !== "") yield line;
  }
}

export async function POST(request: Request) {
  try {
    const secret = process.env.MANSION_CATALOG_LOAD_SECRET;
    if (!secret) throw new ApiError(503, "マンション名簿の読み込みは未設定です", "NOT_CONFIGURED");
    const headerBuf = Buffer.from(request.headers.get("x-mansion-catalog-secret") ?? "");
    const secretBuf = Buffer.from(secret);
    if (secretBuf.length !== headerBuf.length || !timingSafeEqual(secretBuf, headerBuf)) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    const dir = process.env.MANSION_CATALOG_DIR;
    if (!dir) throw new ApiError(503, "マンション名簿のフォルダが未設定です", "NOT_CONFIGURED");
    if (running) throw new ApiError(409, "前の読み込みがまだ動いています", "ALREADY_RUNNING");
    running = true;
    try {
      const files = readdirSync(dir).filter((f) => FILE_RE.test(f)).sort();
      const result = await loadCatalogLines(readLines(dir, files), createPrismaCatalogStore());
      // 今ある棟のうち名簿に1件だけ一致するものをつなぐ(空いている欄だけ埋める・設計 §6.4)。
      const linked = await linkExistingBuildings(createPrismaLinkDeps());
      console.log(
        `[mansion-catalog] files=${files.length} inserted=${result.inserted} updated=${result.updated} skipped=${result.skipped} duplicates=${result.duplicates} linked=${linked}`,
      );
      return apiResponse({ files: files.length, ...result, linked });
    } finally {
      running = false;
    }
  } catch (error) {
    return handleApiError(error);
  }
}
