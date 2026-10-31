import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { requireDeal } from "@/lib/deals/guard";
import { DEAL_DETAIL_SELECT, toDealView } from "@/lib/deals/view";
import { loadDealSettings } from "@/lib/deals/settings-store";
import { jstDateString } from "@/lib/deals/datetime";
import { computeDealCalc } from "@/lib/deals/calc/deal-calc";
import { BUSINESS_DOCS } from "@/lib/deals/documents/registry";
import { rememberedStart } from "@/lib/deals/documents/remember";
import { loadCompanyProfile } from "@/lib/sales-sheet/company-profile-store";
import { loadDealStaffNames } from "@/lib/deals/staff-names";
import { kindBaseOf } from "@/lib/deals/constants";
import { loadRegistryDocInfo, registryPropertyFor } from "@/lib/deals/registry-doc-info";

type Ctx = { params: Promise<{ id: string }> };

/**
 * その取引で出せる業務書類と、出す前の確認(空欄の項目・発行のときに選ぶものの初期値と選べる値)。
 * 判定は一覧表(registry.ts)の1か所だけ。画像は使わないので読まない。
 */
export async function GET(_request: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireDeal("read");
    const id = z.string().uuid().parse((await ctx.params).id);
    const row = await prisma.deal.findUnique({ where: { id }, select: DEAL_DETAIL_SELECT });
    if (!row) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
    const deal = toDealView(row);
    const today = jstDateString(new Date());
    const [rateRows, settings, company, staff] = await Promise.all([
      prisma.dealRateTable.findMany(), loadDealSettings(), loadCompanyProfile(), loadDealStaffNames(deal),
    ]);
    // 書類確認書の抹消の項目のため、謄本を1回だけ読む(物件の無い取引は読まない)。
    const registry = await loadRegistryDocInfo(await registryPropertyFor(session, perms, deal.propertyId), kindBaseOf(settings, deal.propertyKind));
    const bctx = {
      deal, calc: computeDealCalc(deal, rateRows, settings.propertyKinds, today), settings, company, rateRows, today, logo: null, seal: null, staff, registry,
    };
    // 前回の入力を初めの値にする書類だけ、発行の履歴を新しい版から読む(設計 第2段階 §3.2)。
    const rememberKeys = BUSINESS_DOCS.filter((d) => d.remember).map((d) => d.key);
    const history = rememberKeys.length ? await prisma.dealDocument.findMany({
      // 版の番号は書き分け(売却・購入など)ごとに数え直すので、発行した日時の新しい順で探す。
      where: { dealId: id, docType: { in: rememberKeys } }, orderBy: [{ issuedAt: "desc" }, { version: "desc" }], select: { docType: true, inputSnapshot: true },
    }) : [];
    const documents = BUSINESS_DOCS.filter((d) => d.applies(bctx)).map((d) => {
      const def = d.defaults(bctx);
      // 取引の初めの値に合う分(両手の取引なら売主様用)の、いちばん新しい入力を使う。
      const by = d.rememberBy;
      const startOf = (base: Record<string, unknown>) => rememberedStart(history, d.key, d.options, base, by?.key, d.form);
      const values = d.remember ? startOf(def.values) : def.values;
      // 小窓で依頼の内容・宛先を切り替えたときの初めの値(その値で出した前回の入力・無ければ初めの値。発注者決定 2026-10-29)
      const starts = d.remember && by ? Object.fromEntries(by.values.map((v) => [v, startOf({ ...def.values, [by.key]: v })])) : null;
      return {
        docType: d.key, label: d.label, group: d.group, missing: d.missing(bctx, values), blocking: d.blocking(bctx),
        defaults: values, issuers: def.issuers ?? null, choices: def.choices ?? null,
        form: d.form ?? null,
        rememberBy: d.rememberBy?.key ?? null, starts,
      };
    });
    return NextResponse.json({ documents, version: deal.version }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
