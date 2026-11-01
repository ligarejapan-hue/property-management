import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { getStorage } from "@/lib/storage";
import { requireDeal } from "@/lib/deals/guard";
import { docLinkAccess } from "@/lib/deals/doc-links/staff-store";

type Ctx = { params: Promise<{ id: string; fileId: string }> };
const notFound = () => new ApiError(404, "ファイルが見つかりません", "NOT_FOUND");
const EXT: Readonly<Record<string, string>> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };

/**
 * 届いたファイルを渡す。必ずダウンロードで、ブラウザの中では開かせない(お客様から来たファイルをそのまま描かない)。
 * 権限が無い・別の取引のファイル・記録やファイルが無い、はすべて 404。
 */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    let allowed = false;
    try {
      allowed = docLinkAccess((await requireDeal("write")).perms).canReview;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 403)) throw e;
    }
    if (!allowed) throw notFound();
    const ids = z.object({ id: z.string().uuid(), fileId: z.string().uuid() }).safeParse(await ctx.params);
    if (!ids.success) throw notFound();
    const row = await prisma.dealDocFile.findFirst({
      where: { id: ids.data.fileId, request: { link: { dealId: ids.data.id } } },
      select: { storageKey: true, mimeType: true, request: { select: { label: true } } },
    });
    if (!row) throw notFound();
    const file = await getStorage().read(row.storageKey);
    if (!file) throw notFound();
    const ext = EXT[row.mimeType] ?? "bin";
    return new Response(new Uint8Array(file.body), {
      status: 200,
      headers: {
        "Content-Type": EXT[row.mimeType] ? row.mimeType : "application/octet-stream",
        "Content-Length": String(file.body.length),
        "Content-Disposition": `attachment; filename="submitted-document.${ext}"; filename*=UTF-8''${encodeURIComponent(`${row.request.label}.${ext}`)}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
