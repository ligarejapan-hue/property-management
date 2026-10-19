import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireAgentInquiry } from "@/lib/agent-inquiry/guard";
import { loadMailSendConfig } from "@/lib/mail/mail-config";
import { MATERIAL_SEND_LIMITS, REGISTRY_WARNING, selectableForMaterialSend } from "@/lib/agent-inquiry/material-send";
import {
  initialMaterialText,
  loadMaterialInquiry,
  loadPropertyAttachments,
  screenMaterialFiles,
} from "@/lib/agent-inquiry/material-send-service";

const NO_STORE = { "Cache-Control": "no-store" };
type Ctx = { params: Promise<{ id: string }> };

/** 送ってよい添付と、差し込み済みの最初の文面(spec §7)。 */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireAgentInquiry("read");
    const id = z.string().uuid().parse((await ctx.params).id);
    const q = await loadMaterialInquiry(id, session, perms);
    const me = await prisma.user.findUnique({ where: { id: session.id }, select: { name: true } });
    const [rows, text, config] = await Promise.all([
      loadPropertyAttachments(q.propertyId),
      initialMaterialText(q, me?.name ?? ""),
      loadMailSendConfig(),
    ]);
    // 送信と同じ記録の判定を通ったものだけ出す(まとめて引く=ファイルの数によらず決まった回数・@codex 4巡目 P2)。
    const selectable = rows.filter((x) => selectableForMaterialSend(x, q.propertyId, perms));
    const screened = await screenMaterialFiles(selectable, perms);
    const files = [];
    for (const r of selectable) {
      const g = screened.get(r.id)!;
      if (!g.ok) continue;
      files.push({
        id: r.id, fileName: r.fileName, fileSize: r.fileSize, type: g.effectiveType, createdAt: r.createdAt,
        warning: g.effectiveType === "registry" ? REGISTRY_WARNING : null,
      });
    }
    return NextResponse.json(
      {
        mailConfigured: config != null,
        to: q.contactEmail ?? "",
        ...text,
        files,
        maxTotalBytes: MATERIAL_SEND_LIMITS.maxTotalBytes,
        maxFiles: MATERIAL_SEND_LIMITS.maxFiles,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
