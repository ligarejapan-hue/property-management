import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { encodeCsv } from "@/lib/csv-encode";
import { classifyImportError } from "@/lib/import-error-display";

// ---------- GET /api/import/jobs/:jobId/export-errors ----------
//
// このジョブの error / needs_review 行を CSV でダウンロードする。
//
// ヘッダ:
//   固定列: rowNumber / status / errorType / errorLabel / errorField /
//           errorHint / errorMessage
//   動的列: rawData の全キーを union（first-seen 順、`__` プレフィックスは除外）
//
// 出力は UTF-8 BOM 付き / CRLF 改行 / Excel で文字化けしないフォーマット。
// Content-Disposition で `import-errors-{jobId}.csv` をデフォルトファイル名に。
//
// 権限は他の取込 API と同じく `import:write`。すでに /import/jobs/:jobId 詳細を
// 見られるユーザーは内容に到達できているため、ダウンロード化で権限境界は広がらない。

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    // ジョブ存在確認のみ。fileName 等は今のところ使わないが将来のヘッダ拡張用。
    const job = await prisma.importJob.findUnique({
      where: { id: jobId },
      select: { id: true },
    });

    if (!job) {
      throw new ApiError(404, "ジョブが見つかりません", "NOT_FOUND");
    }

    const rows = await prisma.importJobRow.findMany({
      where: { jobId, status: { in: ["error", "needs_review"] } },
      orderBy: { rowNumber: "asc" },
    });

    // rawData のキーを first-seen 順で union。`__` プレフィックスは
    // 内部用フィールド (例: __building_candidates) なので除外する。
    const dynamicKeys: string[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const obj = (r.rawData ?? null) as Record<string, unknown> | null;
      if (!obj) continue;
      for (const key of Object.keys(obj)) {
        if (key.startsWith("__")) continue;
        if (!seen.has(key)) {
          seen.add(key);
          dynamicKeys.push(key);
        }
      }
    }

    const FIXED_HEADERS = [
      "rowNumber",
      "status",
      "errorType",
      "errorLabel",
      "errorField",
      "errorHint",
      "errorMessage",
    ] as const;

    const headers = [...FIXED_HEADERS, ...dynamicKeys];

    const csvRows = rows.map((row) => {
      const rawObj = (row.rawData ?? {}) as Record<string, unknown>;
      const classified = classifyImportError(row.errorMessage, rawObj);
      const out: Record<string, unknown> = {
        rowNumber: row.rowNumber,
        status: row.status,
        errorType: classified.type,
        errorLabel: classified.label,
        errorField: classified.field ?? "",
        errorHint: classified.hint,
        errorMessage: row.errorMessage ?? "",
      };
      for (const key of dynamicKeys) {
        out[key] = rawObj[key];
      }
      return out;
    });

    const csv = encodeCsv(headers, csvRows, { bom: true });

    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="import-errors-${jobId}.csv"`,
        // CSV はキャッシュ不要。新規エラー行が増えた直後にダウンロードしたいケースも考慮。
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
