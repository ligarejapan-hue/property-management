import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { assertImportJobVisible } from "@/lib/import-job-guard";
import { writeAuditLog } from "@/lib/audit";
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
// 権限は取込の `import:write` に加えて `csv_export:read` と、**この CSV 専用の
// `import_error_csv:read`**（または既に広い `csv_export_personal:read`）を要求し、
// 出力を監査に残す。
//
// ⚠この CSV は rawData をそのまま列に展開するため、**所有者の氏名・住所・電話が
// 生で入る**。他の CSV 出力（物件 CSV / DM 差込 / 所有者 CSV）はすべてこの2つを
// 要求し誰が出したかを監査に残しているのに、ここだけ import:write で通り監査も
// 無かった＝**個人情報 CSV の関門を唯一すり抜けていた**（認可・PII 横断監査 2026-07-30）。
// 以前ここに書いていた「詳細画面を見られる人は内容に到達できている」という理由は、
// **画面上の閲覧と、手元に残る CSV ファイルを同一視していた**点で誤りだった。
//
// ⚠発注者判断（2026-07-30）「事務担当にも個人情報CSV権限を付ける」: ゲートを足す
// だけだと**事務担当がダウンロードできなくなる**（import は持つが個人情報CSVの権限が
// 無い）ため、事務担当用テンプレートに付与する（seed + 本番向けデータ migration）。
// この2つはセットで反映すること。
// ⚠ただし付与するのは共有の `csv_export_personal` ではなく**専用の
// `import_error_csv`**。共有権限を配ると全物件・全所有者の一括CSVまで解禁され、
// ご依頼（取込エラー行を落とせるようにする）より広くなるため。全件CSVも事務担当に
// 許可したい場合は、コード変更なしで権限画面から付与できる。

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
    if (!hasPermission(perms, "csv_export", "read")) {
      throw new ApiError(403, "CSV出力の権限がありません", "FORBIDDEN");
    }
    // 個人情報を含む出力のゲート。**専用権限 `import_error_csv:read` で通す**のが要点で、
    // 共有の `csv_export_personal` を事務担当に配ると、この CSV だけでなく
    // 全物件CSV(所有者名入り)・DM差込CSV・物件宛DM CSV まで一度に解禁されてしまう
    // （事務担当は property:read / owner:read / csv_export:read を既に持つため）。
    // 既に広い権限を持つ人（管理者）は従来どおり通す＝この PR で失う権限は無い。
    const canExportErrorCsv =
      hasPermission(perms, "import_error_csv", "read") ||
      hasPermission(perms, "csv_export_personal", "read");
    if (!canExportErrorCsv) {
      throw new ApiError(
        403,
        "個人情報を含むCSV出力の権限がありません",
        "FORBIDDEN",
      );
    }

    // ジョブ存在確認のみ。fileName 等は今のところ使わないが将来のヘッダ拡張用。
    const job = await prisma.importJob.findUnique({
      where: { id: jobId },
      select: { id: true, executedBy: true },
    });

    if (!job) {
      throw new ApiError(404, "ジョブが見つかりません", "NOT_FOUND");
    }
    // 他の担当者が実行した取込は見せない(2026-08-02 監査)。
    assertImportJobVisible(job, session.id, perms);

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

    // ⚠**誰が個人情報 CSV を出したかを残す**（他の CSV 出力3経路と同じ）。
    // detail は非PIIのメタデータのみ（行数・列数）。rawData の中身や
    // 列名（所有者名の見出しになり得る）は載せない。
    await writeAuditLog({
      userId: session.id,
      action: "import_error_csv_export",
      targetTable: "import_jobs",
      targetId: jobId,
      detail: {
        rowCount: csvRows.length,
        columnCount: headers.length,
        exportedAt: new Date().toISOString(),
      },
    });

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
