import { z } from "zod";
import prisma from "@/lib/prisma";
import { apiResponse, getApiSession, handleApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { releaseEditLock } from "@/lib/edit-lock/service";
import { hashScreenToken, readScreenTokenHash } from "@/lib/edit-lock/screen-token";

const schema = z.object({
  resourceType: z.enum(["property", "owner"]),
  resourceId: z.string().uuid(),
  lockId: z.string().uuid(),
  // beacon はヘッダを付けられないため、ヘッダが無いときだけ本文から読む(⚠生値。ハッシュ化はここで行う)。
  screenToken: z.string().optional(),
});

/**
 * `navigator.sendBeacon` から呼ばれる想定の解除窓口。
 * ⚠beacon は Content-Type を選べない(text/plain になりがち)ので、本文は
 *   content-type を見ずに text() → JSON.parse で読む。壊れた本文・欠けた項目でも
 *   例外を投げず、**常に 200 を返す**(冪等・ベストエフォート)。
 */
export async function POST(request: Request) {
  try {
    const session = await getApiSession();
    const body = await readBody(request);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return apiResponse({ ok: true });
    }
    const { resourceType, resourceId, lockId, screenToken } = parsed.data;

    // ヘッダがあれば優先。無ければ本文の生の合言葉をここでハッシュ化する
    // (生値はどこにも残さない・screen-token.ts の方針と同じ)。
    const screenTokenHash = readScreenTokenHash(request) ?? (screenToken ? hashScreenToken(screenToken) : null);
    if (!screenTokenHash) {
      return apiResponse({ ok: true });
    }

    const { deleted } = await releaseEditLock(prisma, {
      resourceType,
      resourceId,
      lockId,
      userId: session.id,
      screenTokenHash,
    });

    if (deleted > 0) {
      await writeAuditLog({
        userId: session.id,
        action: "edit_lock_release",
        targetTable: "edit_locks",
        targetId: lockId,
        detail: { resourceType, resourceId },
      });
    }
    return apiResponse({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}

async function readBody(request: Request): Promise<unknown> {
  const text = await request.text().catch(() => "");
  if (text.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed === null ? {} : parsed;
  } catch {
    return {};
  }
}
