import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireScenarioAdmin } from "@/lib/sale-dm-letter/scenario-guard";
import { loadSaleDmPublicPageConfig } from "@/lib/sale-dm-letter/config-store";
import { buildLpRenderInput } from "@/lib/sale-dm-letter/lp-render-input";
import { renderLpPage, LP_PAGE_HEADERS } from "@/lib/sale-dm-letter/lp-page";
import { DEFAULT_PRIVACY_TEXT } from "@/lib/sale-dm-letter/privacy-text";

const DEVICE_VALUES = ["sp", "pc"] as const;
type Device = (typeof DEVICE_VALUES)[number];
const querySchema = z.object({ device: z.enum(DEVICE_VALUES).default("sp") });

// iframe に埋め込む前提で frame-ancestors 'none' → 'self' に上書きした応答ヘッダ。
// X-Frame-Options も同じ理由で SAMEORIGIN(社内の同一オリジンからの iframe だけ許す)。
const PREVIEW_HEADERS: Readonly<Record<string, string>> = {
  ...LP_PAGE_HEADERS,
  "Content-Security-Policy": LP_PAGE_HEADERS["Content-Security-Policy"].replace("frame-ancestors 'none'", "frame-ancestors 'self'"),
  "X-Frame-Options": "SAMEORIGIN",
};

function parseDevice(request: NextRequest): Device {
  const raw = new URL(request.url).searchParams.get("device");
  const parsed = querySchema.safeParse({ device: raw ?? undefined });
  if (!parsed.success) throw new ApiError(400, "device は sp か pc のいずれかです", "INVALID_DEVICE");
  return parsed.data.device;
}

/**
 * 台帳のLP社内プレビュー(設計 §2.4/§3.6)。lp-variants/[lpId]/preview と同形だが、
 * 台帳には特定の宛先が無いので所有者の実データも見本住所も差し込まず、
 * 所在・種別はどちらも null(buildLpRenderInput 側のフォールバック文言に落ちる)。
 * 中身の読み取りは管理者だけ(requireScenarioAdmin)。
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session } = await requireScenarioAdmin();
    const { id } = await params;
    const device = parseDevice(request);

    const s = await prisma.dmScenario.findFirst({
      where: { id, deletedAt: null },
      select: {
        lpHeadline: true,
        lpLead: true,
        lpBodyText: true,
        lpFaqJson: true,
        media: {
          select: { slot: true, heading: true, figureKind: true, asset: { select: { publicId: true, width: true, height: true, deletedAt: true } } },
          orderBy: { sortOrder: "asc" },
        },
      },
    });
    if (!s) throw new ApiError(404, "DMの種類が見つかりません", "SCENARIO_NOT_FOUND");
    if (!s.lpHeadline || !s.lpBodyText || s.lpBodyText.trim().length === 0) {
      throw new ApiError(404, "LPの文章がまだ登録されていません", "LP_NOT_READY");
    }

    const cfg = await loadSaleDmPublicPageConfig();
    const html = renderLpPage(buildLpRenderInput(
      {
        variant: { headline: s.lpHeadline, lead: s.lpLead, bodyText: s.lpBodyText, faqJson: s.lpFaqJson },
        media: s.media,
        property: { address: null, propertyType: null },
        company: { senderName: cfg.senderName, senderContact: cfg.senderContact },
      },
      { mode: "preview", unsubscribeUrl: null, phoneTapToken: null, form: { action: "#", privacyText: cfg.privacyText ?? DEFAULT_PRIVACY_TEXT, disabled: true } },
    ));

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_scenario_lp_preview_view",
      targetTable: "dm_scenarios",
      targetId: id,
      detail: { device, viewedAt: new Date().toISOString() },
    });

    return new NextResponse(html, { status: 200, headers: PREVIEW_HEADERS });
  } catch (error) {
    return handleApiError(error);
  }
}
