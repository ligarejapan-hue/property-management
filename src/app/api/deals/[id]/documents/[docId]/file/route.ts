import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { getStorage } from "@/lib/storage";
import { requireDeal } from "@/lib/deals/guard";
import { DEAL_DOC_MIME, dealDocumentContentDisposition, type DealDocFormat } from "@/lib/deals/documents/issue";

type Ctx = { params: Promise<{ id: string; docId: string }> };
const formatSchema = z.enum(["pdf", "xlsx"]);
const notFound = () => new ApiError(404, "書類が見つかりません", "NOT_FOUND");

/**
 * 発行した書類のファイルを配る(設計 §4.9)。取引を見る権限のある人だけ。
 * 権限が無い・別の取引の書類・記録やファイルが無い、はすべて 404(あるかどうかを推測させない)。
 * 控えを残さない(no-store)。
 */
export async function GET(request: Request, ctx: Ctx) {
  try {
    try {
      await requireDeal("read");
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) throw notFound();
      throw e;
    }
    const params = await ctx.params;
    const ids = z.object({ id: z.string().uuid(), docId: z.string().uuid() }).safeParse(params);
    const format = formatSchema.safeParse(new URL(request.url).searchParams.get("format") ?? "pdf");
    if (!ids.success || !format.success) throw notFound();
    const doc = await prisma.dealDocument.findFirst({
      where: { id: ids.data.docId, dealId: ids.data.id },
      select: { pdfKey: true, xlsxKey: true, fileBaseName: true },
    });
    const f: DealDocFormat = format.data;
    const key = f === "pdf" ? doc?.pdfKey : doc?.xlsxKey;
    if (!doc || !key) throw notFound();
    const file = await getStorage().read(key);
    if (!file) throw notFound();
    return new Response(new Uint8Array(file.body), {
      status: 200,
      headers: {
        "Content-Type": DEAL_DOC_MIME[f],
        "Content-Length": String(file.body.length),
        "Content-Disposition": dealDocumentContentDisposition(doc.fileBaseName, f),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
