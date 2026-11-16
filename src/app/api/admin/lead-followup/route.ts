import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  parseJsonBody,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { followupStepsSchema } from "@/lib/lead-followup/steps";
import {
  FollowupEnableBlockedError,
  FollowupVersionConflictError,
  loadFollowupSettings,
  saveFollowupSettings,
} from "@/lib/lead-followup/settings-store";

// 追客メール(ステップメール)の設定。受付メールの ON/OFF・文面と同じ「メール設定」の権限
// (user_management:write=管理者)。設計 docs/superpowers/specs/2026-11-16-inquiry-followup-mail-design.md §6。
async function requireMailAdmin() {
  const session = await getApiSession();
  const perms = await getUserPermissions(session.id);
  if (!hasPermission(perms, "user_management", "write")) {
    throw new ApiError(403, "追客メールの設定を変更する権限がありません(管理者のみ)", "FORBIDDEN");
  }
  return session;
}

const noStore = { headers: { "Cache-Control": "no-store" } };

const putSchema = z.object({
  version: z.number().int().min(0),
  enabled: z.boolean(),
  steps: followupStepsSchema,
});

export async function GET() {
  try {
    await requireMailAdmin();
    return NextResponse.json({ data: await loadFollowupSettings() }, noStore);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await requireMailAdmin();
    const body = putSchema.parse(await parseJsonBody(request));
    let data;
    try {
      data = await saveFollowupSettings({
        version: body.version,
        enabled: body.enabled,
        steps: body.steps,
        userId: session.id,
      });
    } catch (e) {
      if (e instanceof FollowupVersionConflictError) {
        throw new ApiError(409, "ほかの人が先に保存しました。画面を読み込み直してから、もう一度直してください", "VERSION_CONFLICT");
      }
      if (e instanceof FollowupEnableBlockedError) {
        throw new ApiError(422, e.message, "FOLLOWUP_NOT_READY");
      }
      throw e;
    }
    // 監査は ON/OFF と通の数だけ(件名・本文は残さない)。
    await writeAuditLog({
      userId: session.id,
      action: "lead_followup_settings_update",
      targetTable: "mail_config",
      detail: { enabled: body.enabled, newCount: body.steps.new.length, holdCount: body.steps.hold.length },
    });
    return NextResponse.json({ data }, noStore);
  } catch (e) {
    return handleApiError(e);
  }
}
