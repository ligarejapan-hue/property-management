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
  MATERIAL_SEND_LIMIT_LABEL,
  checkMaterialSelection,
  isDefiniteSmtpFailure,
  isPlainMailText,
  isSingleAddress,
  sendStateLabel,
} from "@/lib/agent-inquiry/material-send";
import {
  applySentMaterialToInquiry,
  guardMaterialFiles,
  hasUnappliedMaterialSend,
  loadMaterialInquiry,
  loadPropertyAttachments,
  reconcileMaterialSends,
} from "@/lib/agent-inquiry/material-send-service";

const NO_STORE = { "Cache-Control": "no-store" };
type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx) =>
  z
    .string()
    .uuid()
    .parse((await ctx.params).id);

const sendSchema = z.object({
  to: z.string().trim().max(254),
  subject: z
    .string()
    .trim()
    .min(1)
    .max(MATERIAL_SEND_LIMITS.subject)
    .refine((v) => !/[\r\n]/.test(v) && isPlainMailText(v)),
  // 本文はメール設定のひな形と同じ決まり(改行・タブ以外の制御文字を受けない)。
  body: z.string().min(1).max(MATERIAL_SEND_LIMITS.body).refine(isPlainMailText),
  attachmentIds: z
    .array(z.string().uuid())
    .max(MATERIAL_SEND_LIMITS.maxFiles)
    .refine((a) => new Set(a).size === a.length),
  clientToken: z.string().uuid(),
});

type AuditRow = {
  userId: string;
  action: string;
  targetTable: string;
  targetId: string;
  detail: Record<string, unknown>;
};

/**
 * 送った記録の結果と監査の行を同じ取引で書く(一時的な失敗は3回までやり直す)。書けたら true。
 * ⚠監査だけ抜ける・記録だけ進む、を作らない(@codex 6巡目 P1・10巡目 P2)。
 */
async function finishSend(
  sendId: string,
  data: { result?: "sent"; errorCode?: string; finishedAt: Date },
  audits: AuditRow[],
): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.agentInquiryMaterialSend.update({ where: { id: sendId }, data });
        await tx.auditLog.createMany({
          data: audits.map((a) => ({ ...a, detail: a.detail as object })),
        });
      });
      return true;
    } catch (e) {
      console.error("[material-send] mark sent failed", {
        attempt: i + 1,
        name: e instanceof Error ? e.name : "Unknown",
      });
      if (i < 2) await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
  }
  return false;
}

/** 送った記録(新しい順)。 */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireAgentInquiry("read");
    const id = await idOf(ctx);
    await loadMaterialInquiry(id, session, perms);
    // 読むだけ(書き換えない)。未反映があれば画面が反映し直しの口(POST apply)を呼ぶ(@codex 2巡目 P2)。
    const needsApply = await hasUnappliedMaterialSend(id);
    const rows = await prisma.agentInquiryMaterialSend.findMany({
      where: { inquiryId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        createdAt: true,
        result: true,
        toAddress: true,
        subject: true,
        body: true,
        attachments: true,
        totalSize: true,
        errorCode: true,
        sentBy: { select: { name: true } },
      },
    });
    const now = new Date();
    return NextResponse.json(
      { items: rows.map((r) => ({ ...r, state: sendStateLabel(r, now) })), needsApply },
      { headers: NO_STORE },
    );
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
        select: { id: true, result: true, inquiryId: true, createdAt: true, errorCode: true },
      });
      if (!prev) return null;
      if (prev.inquiryId !== id) {
        throw new ApiError(409, "画面を開き直してから送ってください", "CLIENT_TOKEN_MISMATCH");
      }
      if (prev.result === "sent") await reconcileMaterialSends(id, session.id);
      return NextResponse.json(
        {
          id: prev.id,
          result: prev.result,
          state: sendStateLabel(prev, new Date()),
          replayed: true,
        },
        { headers: NO_STORE },
      );
    };
    const prev = await replay();
    if (prev) return prev;

    if (!isSingleAddress(input.to))
      throw new ApiError(
        400,
        "宛先のメールアドレスを1件、正しい形で入れてください",
        "INVALID_ADDRESS",
      );
    const config = await loadMailSendConfig();
    if (!config) throw new ApiError(409, "管理画面のメール設定が必要です", "MAIL_NOT_CONFIGURED");

    // 送る直前に DB から読み直して確かめ直す(画面の古い一覧・手で作った要求を通さない)。
    const rows = await loadPropertyAttachments(q.propertyId, input.attachmentIds);
    const sel = checkMaterialSelection(rows, input.attachmentIds, q.propertyId, perms);
    if (!sel.ok) {
      const msg = {
        NOT_SELECTABLE: "送れないファイルが含まれています。画面を開き直してください",
        TOO_LARGE: `ファイルの合計が ${MATERIAL_SEND_LIMIT_LABEL} を超えています`,
        NO_FILES: "送るファイルを選んでください",
        TOO_MANY: "一度に送れるのは 20 ファイルまでです",
      }[sel.code];
      throw new ApiError(400, msg, sel.code);
    }

    // ファイルごとに /uploads と同じ守りを通す(記録は手で書ける=種類と物件だけでは足りない・最終レビュー C1)。
    const guarded: {
      row: (typeof sel.rows)[number];
      key: string;
      effectiveType: "general" | "registry";
    }[] = [];
    const checks = await guardMaterialFiles(sel.rows, session, perms);
    sel.rows.forEach((r, i) => {
      const g = checks[i];
      if (!g.ok)
        throw new ApiError(
          400,
          "送れないファイルが含まれています。画面を開き直してください",
          "NOT_SELECTABLE",
        );
      guarded.push({ row: r, key: g.key, effectiveType: g.effectiveType });
    });

    const storage = getStorage();
    const files: MailAttachment[] = [];
    let readBytes = 0;
    for (const { row: r, key } of guarded) {
      const got = await storage.read(key);
      if (!got)
        throw new ApiError(409, `「${r.fileName}」を読み出せませんでした`, "FILE_UNAVAILABLE");
      // 上限は記録の大きさ(手で書ける)ではなく、実際に読んだ大きさで確かめる。
      readBytes += got.body.length;
      if (readBytes > MATERIAL_SEND_LIMITS.maxTotalBytes) {
        throw new ApiError(
          400,
          `ファイルの合計が ${MATERIAL_SEND_LIMIT_LABEL} を超えています`,
          "TOO_LARGE",
        );
      }
      // ファイルの種類もストレージの値を使う(記録の mimeType は手で書ける)。
      files.push({ filename: r.fileName, content: got.body, contentType: got.contentType });
    }

    // 予約の行(一意制約で二重送信を防ぐ)。
    // ⚠反響を押さえて読み直し、その時点の状態と宛先を残す(読み込みから予約までの別の人の変更を
    //   「送った後の手の変更」と取り違えない・@codex 18巡目 P2)。
    // ⚠予約の時刻はアプリの時計で入れる(反映の時刻 inquiryAppliedAt と同じ時計で比べる・@codex 18巡目 P2)。
    let claim: { id: string };
    try {
      claim = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM agent_inquiries WHERE id = ${id}::uuid FOR UPDATE`;
        const now = await tx.agentInquiry.findUnique({
          where: { id },
          select: { status: true, contactEmail: true },
        });
        if (!now) throw new ApiError(404, "反響が見つかりません", "NOT_FOUND");
        return tx.agentInquiryMaterialSend.create({
          data: {
            createdAt: new Date(),
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
            // 送った時点の反響(反映し直しで、あとから手で変えた欄を上書きしない・@codex 8巡目)。
            statusAtSend: now.status,
            contactEmailAtSend: now.contactEmail,
          },
          select: { id: true },
        });
      });
    } catch (e) {
      if ((e as { code?: string } | null)?.code === "P2002") {
        const again = await replay();
        if (again) return again;
      }
      throw e;
    }

    const result = await sendMailWithAttachments(config, {
      to: input.to,
      subject: input.subject,
      text: input.body,
      attachments: files,
    });
    // 監査の行。送った記録の書き込みと同じ取引で書く(監査だけ抜けない・@codex 10巡目 P2)。
    const auditRows = (detail: Record<string, unknown>): AuditRow[] => [
      {
        userId: session.id,
        action: "agent_inquiry_material_send",
        targetTable: "agent_inquiries",
        targetId: id,
        detail: { files: guarded.length, totalSize: readBytes, ...detail },
      },
      // 謄本の取り扱いの記録。宛先は書かない(送った記録の表で見る)。
      ...guarded
        .filter((x) => x.effectiveType === "registry")
        .map(({ row: r }) => ({
          userId: session.id,
          action: "registry_pdf_mail_send",
          targetTable: "attachments",
          targetId: r.id,
          detail: { inquiryId: id, sendId: claim.id },
        })),
    ];
    // 取引で書けなかったとき(ずっと DB が落ちている)だけ、1行ずつの書き込みで残せるだけ残す。
    const auditFallback = async (detail: Record<string, unknown>) => {
      for (const row of auditRows(detail)) await writeAuditLog(row);
    };
    if (!result.ok) {
      if (isDefiniteSmtpFailure(result.code)) {
        await prisma.agentInquiryMaterialSend.update({
          where: { id: claim.id },
          data: { result: "failed", errorCode: result.code, finishedAt: new Date() },
        });
        return NextResponse.json(
          {
            id: claim.id,
            error: {
              code: "SEND_FAILED",
              message: "送れませんでした。時間をおいてもう一度押してください",
            },
          },
          { status: 502, headers: NO_STORE },
        );
      }
      // 送れたか分からない(時間切れ・切断)=送信中のまま失敗の印だけ付ける=結果不明。同じ鍵の押し直しは
      // 前の結果を返すだけ(2通目を出さない・@codex 4巡目 P1)。届いたかもしれない=監査には残す。
      const unknownDetail = { outcome: "unknown" };
      const marked = await finishSend(
        claim.id,
        { errorCode: result.code ?? "UNKNOWN", finishedAt: new Date() },
        auditRows(unknownDetail),
      );
      if (!marked) await auditFallback(unknownDetail);
      return NextResponse.json(
        {
          id: claim.id,
          error: {
            code: "SEND_UNKNOWN",
            message:
              "送れたか分かりません(メールの相手先の応答が途中で切れました)。相手に届いたか確かめてください",
          },
        },
        { status: 502, headers: NO_STORE },
      );
    }

    // 送信は済んだ=まず記録を送信済みにする(後の更新が落ちても「送信中」のまま残さない・最終レビュー I2)。
    // ⚠一時的に落ちてもやり直す。ずっと落ちても**エラーにしない**=送れたことを返す(エラーにすると押し直し→
    //   10分後に結果不明→2通目、になる・@codex 6巡目 P1)。記録は送信中のまま残る=記録には結果不明と出る。
    const recorded = await finishSend(
      claim.id,
      { result: "sent", finishedAt: new Date() },
      auditRows({}),
    );
    if (!recorded) {
      await auditFallback({ outcome: "sent_unrecorded" });
      return NextResponse.json(
        { id: claim.id, result: "sent", version: q.version, statusUpdated: false, recorded: false },
        { status: 201, headers: NO_STORE },
      );
    }
    // 反響の更新は version を見ない(他の人の更新とぶつかっても done にする)。落ちても送信は成功として返し、
    // 押し直し・反映し直しの口で反映し直す(@codex 2巡目 P2)。
    let version = q.version;
    let statusUpdated = true;
    let applied: Awaited<ReturnType<typeof applySentMaterialToInquiry>> = null;
    try {
      const a = await applySentMaterialToInquiry(id, session.id);
      if (a) {
        version = a.version;
        applied = a;
      }
    } catch (e) {
      statusUpdated = false;
      console.error("[material-send] inquiry update failed after send", {
        name: e instanceof Error ? e.name : "Unknown",
      });
    }
    // 反響を書いた監査(状態・宛先のどちらでも)は applySentMaterialToInquiry が同じ取引で書く(@codex 11・12巡目 P2)。
    return NextResponse.json(
      { id: claim.id, result: "sent", version, statusUpdated },
      { status: 201, headers: NO_STORE },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
