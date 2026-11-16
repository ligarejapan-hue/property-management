import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireDeal } from "@/lib/deals/guard";
import { hasPermission } from "@/lib/permissions";
import { EMPTY_BANK_ACCOUNT } from "@/lib/deals/schemas";
import { loadDealSettings } from "@/lib/deals/settings-store";
import { resolveCompanyProfile } from "@/lib/sales-sheet/company-profile-store";

/**
 * 取引の画面で使う選択肢(物件種別)と、当事者に「自社を入れる」ための会社情報。
 * selfBankAccount = 取引の設定の自社の口座(お金の受け渡しで、自社が受け取るお金の振込先の初期値・2026-11-16)。
 *   取引を編集できる人だけに返す(見るだけの人は保存できないので要らない=空の口座・セキュリティ点検の指摘)。
 */
export async function GET() {
  try {
    const { perms } = await requireDeal("read");
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
        selfBankAccount: hasPermission(perms, "deal", "write") ? settings.bankAccount : EMPTY_BANK_ACCOUNT,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
