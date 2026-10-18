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
  isPlainMailText,
  isSingleAddress,
  sendStateLabel,
} from "@/lib/agent-inquiry/material-send";
import {
  guardMaterialFile,
  loadMaterialInquiry,
  loadPropertyAttachments,
} from "@/lib/agent-inquiry/material-send-service";

const NO_STORE = { "Cache-Control": "no-store" };
type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx) => z.string().uuid().parse((await ctx.params).id);

const sendSchema = z.object({
  to: z.string().trim().max(254),
  subject: z.string().trim().min(1).max(MATERIAL_SEND_LIMITS.subject).refine((v) => !/[\r\n]/.test(v) && isPlainMailText(v)),
  // 本文はメール設定のひな形と同じ決まり(改行・タブ以外の制御文字を受けない)。
  body: z.string().min(1).max(MATERIAL_SEND_LIMITS.body).refine(isPlainMailText),
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
    const q = await loadMaterialInquiry(id, session, perms);
    // 同じ人が同じ鍵で押し直した=送らずに前の結果を返す。鍵は反響ごと(別の反響の結果は返さない)。
    const replay = async () => {
      const prev = await prisma.agentInquiryMaterialSend.findFirst({
        where: { sentById: session.id, clientToken: input.clientToken },
        select: { id: true, result: true, inquiryId: true, createdAt: true },
      });
      if (!prev) return null;
      if (prev.inquiryId !== id) {
        throw new ApiError(409, "画面を開き直してから送ってください", "CLIENT_TOKEN_MISMATCH");
      }
      return NextResponse.json(
        { id: prev.id, result: prev.result, state: sendStateLabel(prev, new Date()), replayed: true },
        { headers: NO_STORE },
      );
    };
    const prev = await replay();
    if (prev) return prev;

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

    // ファイルごとに /uploads と同じ守りを通す(記録は手で書ける=種類と物件だけでは足りない・最終レビュー C1)。
    const guarded: { row: (typeof sel.rows)[number]; key: string; effectiveType: "general" | "registry" }[] = [];
    for (const r of sel.rows) {
      const g = await guardMaterialFile(r, session, perms);
      if (!g.ok) throw new ApiError(400, "送れないファイルが含まれています。画面を開き直してください", "NOT_SELECTABLE");
      guarded.push({ row: r, key: g.key, effectiveType: g.effectiveType });
    }

    const storage = getStorage();
    const files: MailAttachment[] = [];
    let readBytes = 0;
    for (const { row: r, key } of guarded) {
      const got = await storage.read(key);
      if (!got) throw new ApiError(409, `「${r.fileName}」を読み出せませんでした`, "FILE_UNAVAILABLE");
      // 上限は記録の大きさ(手で書ける)ではなく、実際に読んだ大きさで確かめる。
      readBytes += got.body.length;
      if (readBytes > MATERIAL_SEND_LIMITS.maxTotalBytes) {
        throw new ApiError(400, "ファイルの合計が 20MB を超えています", "TOO_LARGE");
      }
      // ファイルの種類もストレージの値を使う(記録の mimeType は手で書ける)。
      files.push({ filename: r.fileName, content: got.body, contentType: got.contentType });
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
          attachments: guarded.map(({ row: r, effectiveType }, i) => ({
            attachmentId: r.id,
            fileName: r.fileName,
            fileSize: files[i].content.length,
            type: effectiveType,
          })),
          totalSize: readBytes,
          result: "sending",
          clientToken: input.clientToken,
        },
        select: { id: true },
      });
    } catch (e) {
      if ((e as { code?: string } | null)?.code === "P2002") {
        const again = await replay();
        if (again) return again;
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

    // 送信は済んだ=まず記録を送信済みにする(後の更新が落ちても「送信中」のまま残さない・最終レビュー I2)。
    await prisma.agentInquiryMaterialSend.update({ where: { id: claim.id }, data: { result: "sent", finishedAt: new Date() } });
    // 反響の更新は version を見ない(他の人の更新とぶつかっても done にする)。落ちても送信は成功として返す。
    const changeEmail = (q.contactEmail ?? "") !== input.to;
    let version = q.version;
    let statusUpdated = true;
    if (q.status !== "done" || changeEmail) {
      try {
        const u = await prisma.agentInquiry.update({
          where: { id },
          data: { status: "done", ...(changeEmail ? { contactEmail: input.to } : {}), version: { increment: 1 } },
          select: { version: true },
        });
        version = u.version;
      } catch (e) {
        statusUpdated = false;
        console.error("[material-send] inquiry update failed after send", { name: e instanceof Error ? e.name : "Unknown" });
      }
    }

    await writeAuditLog({
      userId: session.id,
      action: "agent_inquiry_material_send",
      targetTable: "agent_inquiries",
      targetId: id,
      detail: { files: guarded.length, totalSize: readBytes, statusChanged: statusUpdated && q.status !== "done" },
    });
    for (const { row: r } of guarded.filter((x) => x.effectiveType === "registry")) {
      // 謄本の取り扱いの記録。宛先は書かない(送った記録の表で見る)。
      await writeAuditLog({
        userId: session.id,
        action: "registry_pdf_mail_send",
        targetTable: "attachments",
        targetId: r.id,
        detail: { inquiryId: id, sendId: claim.id },
      });
    }
    return NextResponse.json({ id: claim.id, result: "sent", version, statusUpdated }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
