import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireAgentInquiry } from "@/lib/agent-inquiry/guard";
import { loadMailSendConfig } from "@/lib/mail/mail-config";
import { MATERIAL_SEND_LIMITS, REGISTRY_WARNING, selectableForMaterialSend } from "@/lib/agent-inquiry/material-send";
import { initialMaterialText, loadMaterialInquiry, loadPropertyAttachments } from "@/lib/agent-inquiry/material-send-service";

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
    const files = rows
      .filter((r) => selectableForMaterialSend(r, q.propertyId, perms))
      .map((r) => ({
        id: r.id, fileName: r.fileName, fileSize: r.fileSize, type: r.type, createdAt: r.createdAt,
        warning: r.type === "registry" ? REGISTRY_WARNING : null,
      }));
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
