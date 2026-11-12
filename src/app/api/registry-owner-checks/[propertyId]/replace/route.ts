/**
 * 謄本の名義の確認:「謄本の名義に直す」(管理者だけ・2026-11-08 発注者決定)。
 * 謄本にない人を物件から外し、システムにいない謄本の人を足す(1つのトランザクション)。
 * restoreDm=true のときだけ DM を「送付可」に戻す(画面では最初はチェックなし=保留のまま)。
 * ⚠確認画面で見せた謄本・つながっていた所有者・外れる人と今が違えば 409(何も変えない)。
 */
import { NextRequest } from "next/server";
import { z } from "zod";

import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { findMissingRegistryOwnerReviewPerm } from "@/lib/registry-owner-check/permissions";
import { replaceRegistryOwnersOnProperty } from "@/lib/registry-owner-apply/apply";
import { recordCheckAfterReplace, restoreDmSendIfHold } from "@/lib/registry-owner-check/service";

/**
 * 送られてくる所有者の ID の数の上限。所有者が何百人もつながった物件(共有の私道・一棟など)でも
 * 直せるように、200 から上げた(2026-11-09 発注者決定)。中身は確認画面で見せたものと同じかを
 * サーバーがロックの中で確かめるので、ここは入力の大きさの歯止めだけ。
 * ⚠route.ts からは export しない(Next の route は決まった名前しか export できない)。
 */
const REPLACE_MAX_IDS = 5000;

const bodySchema = z.object({
  attachmentId: z.string().uuid(),
  linkedOwnerIds: z.array(z.string().uuid()).max(REPLACE_MAX_IDS),
  removeOwnerIds: z.array(z.string().uuid()).max(REPLACE_MAX_IDS),
  restoreDm: z.boolean(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ propertyId: string }> },
) {
  try {
    const { propertyId } = await context.params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    const missing = findMissingRegistryOwnerReviewPerm(perms, "replace");
    if (missing) throw new ApiError(403, missing, "FORBIDDEN");

    const body = bodySchema.parse(await request.json().catch(() => null));
    let dmRestored = false;
    let resultAfter: string | null = null;
    const outcome = await replaceRegistryOwnersOnProperty({
      session,
      perms,
      propertyId,
      expectedAttachmentId: body.attachmentId,
      expectedLinkedOwnerIds: body.linkedOwnerIds,
      expectedRemoveOwnerIds: body.removeOwnerIds,
      // 外す・足すと同じトランザクションで、比べ直した結果と DM を残す
      beforeCommit: async (tx, registryNames, registryRows) => {
        resultAfter = await recordCheckAfterReplace(
          tx,
          propertyId,
          body.attachmentId,
          registryNames,
          registryRows,
        );
        if (body.restoreDm) dmRestored = await restoreDmSendIfHold(tx, propertyId, session.id);
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "registry_owner_replace",
      targetTable: "properties",
      targetId: propertyId,
      detail: { removed: outcome.removed, added: outcome.added, dmRestored, resultAfter },
    });
    return apiResponse({ removed: outcome.removed, added: outcome.added, dmRestored, resultAfter });
  } catch (error) {
    return handleApiError(error);
  }
}
