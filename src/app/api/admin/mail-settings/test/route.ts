import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, ApiError, handleApiError } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { loadMailSendConfig } from "@/lib/mail/mail-config";
import { sendPlainMail, safeErrorCode } from "@/lib/mail/transport";

// 設定は管理者(user_management:write)のみ。SMTPパスワードを含む高リスク設定のため admin 限定。
async function requireMailAdmin() {
  const session = await getApiSession();
  const perms = await getUserPermissions(session.id);
  if (!hasPermission(perms, "user_management", "write")) {
    throw new ApiError(403, "メール送信設定を変更する権限がありません(管理者のみ)", "FORBIDDEN");
  }
  return session;
}

const noStore = { headers: { "Cache-Control": "no-store" } };

// このメールを受け取れれば、査定申込の通知メールも届く旨を伝える固定文面(宛名・要望等のPIIは含めない)。
const TEST_MAIL_TEXT = [
  "このメールは物件管理システムの「メール送信設定」からのテスト送信です。",
  "受け取れていれば、査定申込の通知メールも届きます。",
].join("\n");

// POST: テストメール送信。宛先は操作者自身の通知先(inquiryNotifyEmail ?? email)。
// 設定未完成なら送信せず 422、送信に失敗したら 502。
// ⚠失敗時は管理者が原因(パスワード誤り/接続不可等)を切り分けられるよう、許可リスト一致の
// SMTPコード(safeErrorCode 由来・/^[A-Z][A-Z0-9_]{1,40}$/・自由文なし)だけを smtpCode として
// 応答・監査に含める(発注者判断)。生メッセージ・宛先・設定値は決して含めない。
// ApiError は追加フィールドを運べないため、この失敗応答だけは直接 NextResponse.json を返す。
export async function POST() {
  try {
    const session = await requireMailAdmin();

    const config = await loadMailSendConfig();
    if (!config) {
      throw new ApiError(
        422,
        "メール送信設定が完了していません(管理画面で設定してください)",
        "MAIL_NOT_CONFIGURED",
      );
    }

    const me = await prisma.user.findUnique({
      where: { id: session.id },
      select: { email: true, inquiryNotifyEmail: true },
    });
    const to = me?.inquiryNotifyEmail ?? me?.email ?? session.email;

    const result = await sendPlainMail(config, {
      to,
      subject: "【テスト】通知メールの送信確認",
      text: TEST_MAIL_TEXT,
    });

    if (!result.ok) {
      // sendPlainMail は既に safeErrorCode() を通した code を返すが、モック等で意図せず自由文が
      // 渡ってきても取りこぼさないよう、ここでも同じ許可リストで再検査する(多層防御)。
      const smtpCode = safeErrorCode({ code: result.code });
      await writeAuditLog({
        userId: session.id,
        action: "mail_settings_test",
        targetTable: "mail_config",
        detail: { result: "failed", code: smtpCode },
      });
      return NextResponse.json(
        { error: { message: "テストメールの送信に失敗しました", code: "MAIL_SEND_FAILED", smtpCode } },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }

    await writeAuditLog({
      userId: session.id,
      action: "mail_settings_test",
      targetTable: "mail_config",
      detail: { result: "sent" },
    });

    return NextResponse.json({ data: { result: "sent" } }, noStore);
  } catch (e) {
    return handleApiError(e);
  }
}
