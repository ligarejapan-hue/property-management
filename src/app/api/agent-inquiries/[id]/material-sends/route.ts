import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireAgentInquiry } from "@/lib/agent-inquiry/guard";
import { loadMailSendConfig } from "@/lib/mail/mail-config";
import { sendMailWithAttachments, type MailAttachment } from "@/lib/mail/transport";
import { getStorage } from "@/lib/storage";
import {
  MATERIAL_SEND_LIMITS,
  checkMaterialSelection,
  isSingleAddress,
  sendStateLabel,
} from "@/lib/agent-inquiry/material-send";
import { loadMaterialInquiry, loadPropertyAttachments } from "@/lib/agent-inquiry/material-send-service";

const NO_STORE = { "Cache-Control": "no-store" };
type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx) => z.string().uuid().parse((await ctx.params).id);

const sendSchema = z.object({
  to: z.string().trim().max(254),
  subject: z.string().trim().min(1).max(MATERIAL_SEND_LIMITS.subject).refine((v) => !/[\r\n]/.test(v)),
  body: z.string().min(1).max(MATERIAL_SEND_LIMITS.body),
  attachmentIds: z.array(z.string().uuid()).max(MATERIAL_SEND_LIMITS.maxFiles)
    .refine((a) => new Set(a).size === a.length),
  clientToken: z.string().uuid(),
});

/** 送った記録(新しい順)。 */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireAgentInquiry("read");
    const id = await idOf(ctx);
    await loadMaterialInquiry(id, session, perms);
    const rows = await prisma.agentInquiryMaterialSend.findMany({
      where: { inquiryId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true, createdAt: true, result: true, toAddress: true, subject: true, body: true,
        attachments: true, totalSize: true, errorCode: true, sentBy: { select: { name: true } },
      },
    });
    const now = new Date();
    return NextResponse.json({ items: rows.map((r) => ({ ...r, state: sendStateLabel(r, now) })) }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}

/** 資料を送る(spec §6)。 */
export async function POST(request: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireAgentInquiry("write");
    const id = await idOf(ctx);
    const input = sendSchema.parse(await parseJsonBody(request));
    const replay = () =>
      prisma.agentInquiryMaterialSend.findFirst({
        where: { sentById: session.id, clientToken: input.clientToken },
        select: { id: true, result: true },
      });
    const prev = await replay();
    if (prev) return NextResponse.json({ ...prev, replayed: true }, { headers: NO_STORE });

    const q = await loadMaterialInquiry(id, session, perms);
    if (!isSingleAddress(input.to)) throw new ApiError(400, "宛先のメールアドレスを1件、正しい形で入れてください", "INVALID_ADDRESS");
    const config = await loadMailSendConfig();
    if (!config) throw new ApiError(409, "管理画面のメール設定が必要です", "MAIL_NOT_CONFIGURED");

    // 送る直前に DB から読み直して確かめ直す(画面の古い一覧・手で作った要求を通さない)。
    const rows = await loadPropertyAttachments(q.propertyId, input.attachmentIds);
    const sel = checkMaterialSelection(rows, input.attachmentIds, q.propertyId, perms);
    if (!sel.ok) {
      const msg = {
        NOT_SELECTABLE: "送れないファイルが含まれています。画面を開き直してください",
        TOO_LARGE: "ファイルの合計が 20MB を超えています",
        NO_FILES: "送るファイルを選んでください",
        TOO_MANY: "一度に送れるのは 20 ファイルまでです",
      }[sel.code];
      throw new ApiError(400, msg, sel.code);
    }

    const storage = getStorage();
    const files: MailAttachment[] = [];
    for (const r of sel.rows) {
      const key = storage.keyFromUrl(r.fileUrl);
      const got = key ? await storage.read(key) : null;
      if (!got) throw new ApiError(409, `「${r.fileName}」を読み出せませんでした`, "FILE_UNAVAILABLE");
      files.push({ filename: r.fileName, content: got.body, contentType: r.mimeType || got.contentType });
    }

    // 予約の行(一意制約で二重送信を防ぐ)。
    let claim: { id: string };
    try {
      claim = await prisma.agentInquiryMaterialSend.create({
        data: {
          inquiryId: id,
          sentById: session.id,
          toAddress: input.to,
          subject: input.subject,
          body: input.body,
          attachments: sel.rows.map((r) => ({ attachmentId: r.id, fileName: r.fileName, fileSize: r.fileSize, type: r.type })),
          totalSize: sel.totalSize,
          result: "sending",
          clientToken: input.clientToken,
        },
        select: { id: true },
      });
    } catch (e) {
      if ((e as { code?: string } | null)?.code === "P2002") {
        const again = await replay();
        if (again) return NextResponse.json({ ...again, replayed: true }, { headers: NO_STORE });
      }
      throw e;
    }

    const result = await sendMailWithAttachments(config, { to: input.to, subject: input.subject, text: input.body, attachments: files });
    if (!result.ok) {
      await prisma.agentInquiryMaterialSend.update({
        where: { id: claim.id },
        data: { result: "failed", errorCode: result.code, finishedAt: new Date() },
      });
      return NextResponse.json(
        { id: claim.id, error: { code: "SEND_FAILED", message: "送れませんでした。時間をおいてもう一度押してください" } },
        { status: 502, headers: NO_STORE },
      );
    }

    // 送信は済んだ=記録は必ず残す。反響の更新は version を見ない(他の人の更新とぶつかっても done にする)。
    const changeEmail = (q.contactEmail ?? "") !== input.to;
    const version = await prisma.$transaction(async (tx) => {
      await tx.agentInquiryMaterialSend.update({ where: { id: claim.id }, data: { result: "sent", finishedAt: new Date() } });
      if (q.status === "done" && !changeEmail) return q.version;
      const u = await tx.agentInquiry.update({
        where: { id },
        data: { status: "done", ...(changeEmail ? { contactEmail: input.to } : {}), version: { increment: 1 } },
        select: { version: true },
      });
      return u.version;
    });

    await writeAuditLog({
      userId: session.id,
      action: "agent_inquiry_material_send",
      targetTable: "agent_inquiries",
      targetId: id,
      detail: { files: sel.rows.length, totalSize: sel.totalSize, statusChanged: q.status !== "done" },
    });
    for (const r of sel.rows.filter((x) => x.type === "registry")) {
      // 謄本の取り扱いの記録。宛先は書かない(送った記録の表で見る)。
      await writeAuditLog({
        userId: session.id,
        action: "registry_pdf_mail_send",
        targetTable: "attachments",
        targetId: r.id,
        detail: { inquiryId: id, sendId: claim.id },
      });
    }
    return NextResponse.json({ id: claim.id, result: "sent", version }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
