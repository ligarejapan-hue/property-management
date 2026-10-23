import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireDeal } from "@/lib/deals/guard";
import { loadDealSettings } from "@/lib/deals/settings-store";
import { resolveCompanyProfile } from "@/lib/sales-sheet/company-profile-store";

/** 取引の画面で使う選択肢(物件種別)と、当事者に「自社を入れる」ための会社情報。 */
export async function GET() {
  try {
    await requireDeal("read");
    const [settings, companyRow] = await Promise.all([
      loadDealSettings(),
      prisma.companyProfile.findUnique({ where: { id: "singleton" } }),
    ]);
    const company = resolveCompanyProfile(companyRow);
    const representative = [settings.representativeTitle, settings.representativeName].filter(Boolean).join(" ") || null;
    return NextResponse.json(
      {
        propertyKinds: settings.propertyKinds,
        selfParty: { name: company.nameJa, representative, address: company.address || null, phone: company.tel || null },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
