import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { getStorage } from "@/lib/storage";
import { safeRandomId } from "@/lib/random-id";
import { isChromiumAvailable, renderHtmlToPdfDocument } from "@/lib/sales-sheet/output";
import { loadCompanyProfile } from "@/lib/sales-sheet/company-profile-store";
import { DEAL_VERSION_CONFLICT_MESSAGE, requireDeal } from "@/lib/deals/guard";
import { DEAL_DETAIL_SELECT, toDealView } from "@/lib/deals/view";
import { loadDealSettings } from "@/lib/deals/settings-store";
import { loadDealBranding } from "@/lib/deals/branding-store";
import { jstDateString } from "@/lib/deals/datetime";
import { buildFundingPlan } from "@/lib/deals/documents/funding-plan";
import { buildFundingPlanXlsx } from "@/lib/deals/documents/funding-plan-xlsx";
import { buildBusinessPlan } from "@/lib/deals/documents/business-plan";
import { buildBusinessPlanXlsx } from "@/lib/deals/documents/business-plan-xlsx";
import { businessDocOf } from "@/lib/deals/documents/registry";
import { DocOptionError } from "@/lib/deals/documents/business/receipts";
import { buildValuesXlsx } from "@/lib/deals/documents/business/values-xlsx";
import { pdfPageCount } from "@/lib/deals/documents/business/pdf-pages";
import type { BusinessDocContext } from "@/lib/deals/documents/business/common";
import { computeDealCalc } from "@/lib/deals/calc/deal-calc";
import { loadDealStaffNames } from "@/lib/deals/staff-names";
import { loadRegistryDocInfo, registryPropertyFor } from "@/lib/deals/registry-doc-info";
import {
  DEAL_DOC_MIME, DEAL_DOC_TYPE_KEYS, dealDocumentBaseName, dealDocumentKey, dealDocumentTitle, type DealDocFormat,
} from "@/lib/deals/documents/issue";

type Ctx = { params: Promise<{ id: string }> };
const NO_STORE = { "Cache-Control": "no-store" };
/** version = 画面が保存した直後の取引の版。違えば、そのあとにほかの人が保存している(その入力では発行しない)。 */
const bodySchema = z.object({
  docType: z.enum(DEAL_DOC_TYPE_KEYS),
  version: z.number().int().min(0),
  /** 業務書類で、発行のときに選ぶもの(領収書の発行者など・段5の読み替え 2)。形は書類ごとに一覧表で確かめる。 */
  options: z.record(z.string(), z.unknown()).optional(),
}).strict();
/** 同時に発行して版の番号がぶつかったときのやり直しの回数。 */
const VERSION_ATTEMPTS = 3;
const isUniqueViolation = (e: unknown) => (e as { code?: string } | null)?.code === "P2002";

/** 発行履歴(新しい順)。保存場所の鍵は返さない(開くのは専用の道から)。 */
export async function GET(_request: Request, ctx: Ctx) {
  try {
    await requireDeal("read");
    const id = z.string().uuid().parse((await ctx.params).id);
    const deal = await prisma.deal.findUnique({ where: { id }, select: { id: true } });
    if (!deal) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
    const rows = await prisma.dealDocument.findMany({
      where: { dealId: id },
      orderBy: [{ issuedAt: "desc" }, { version: "desc" }],
      select: {
        id: true, docType: true, variant: true, version: true, issuedAt: true, fileBaseName: true,
        pdfKey: true, xlsxKey: true, issuedBy: { select: { name: true } },
      },
    });
    const documents = rows.map((r) => ({
      id: r.id, docType: r.docType, variant: r.variant, version: r.version, title: dealDocumentTitle(r.docType, r.variant),
      issuedAt: r.issuedAt.toISOString(), issuedByName: r.issuedBy.name, fileBaseName: r.fileBaseName,
      hasPdf: r.pdfKey !== null, hasXlsx: r.xlsxKey !== null,
    }));
    return NextResponse.json({ documents }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * 書類を発行する(設計 §4.7〜4.9)。入力は**保存済みの**ものを使う(送られた入力は使わない)。
 * 画面が保存した版と今の版が同じときだけ発行する。PDF と Excel を作って `deals/<取引ID>/` に置き、発行履歴に1行足す。記録に失敗したらファイルを消す。
 */
export async function POST(request: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireDeal("write");
    const id = z.string().uuid().parse((await ctx.params).id);
    const { docType, version, options } = bodySchema.parse(await parseJsonBody(request));
    const row = await prisma.deal.findUnique({ where: { id }, select: DEAL_DETAIL_SELECT });
    if (!row) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
    // 保存してから発行するまでの間に、ほかの人が別の入力を保存していたら、その入力を自分の名前で発行しない(最終レビュー)。
    if (row.version !== version) throw new ApiError(409, DEAL_VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
    if (docType === "business_plan" && row.businessType !== "resale") {
      throw new ApiError(422, "事業計画書は買取再販の取引だけで使えます", "NOT_RESALE");
    }

    const deal = toDealView(row);
    const today = jstDateString(new Date());
    const [rateRows, settings, company, branding] = await Promise.all([
      prisma.dealRateTable.findMany(), loadDealSettings(), loadCompanyProfile(), loadDealBranding(),
    ]);
    const businessDoc = businessDocOf(docType);
    // 担当者の名前は業務書類(書類確認書の頭)にだけ使う。
    // 書類の種類ごとに、保存済みの入力 → 計算と HTML → Excel を作る(保存・版・後片付けは共通)。
    let built: { variant: string; inputs: object; calc: object; html: string; compactHtml?: string; xlsx: () => Promise<Buffer> };
    if (businessDoc) {
      const bctx: BusinessDocContext = {
        deal, calc: computeDealCalc(deal, rateRows, settings.propertyKinds, today), settings, company, rateRows, today,
        logo: branding.logo, seal: branding.seal, staff: await loadDealStaffNames(deal),
        // 謄本は書類確認書と、謄本の状況を使う書類(売主属性調査書)のときだけ読む(計画 段5c-2 の読み替え 5・第2段階 段B)。
        registry: businessDoc.group === "checklist" || businessDoc.usesRegistry ? await loadRegistryDocInfo(await registryPropertyFor(session, perms, deal.propertyId)) : undefined,
      };
      if (!businessDoc.applies(bctx)) throw new ApiError(422, `この取引では${businessDoc.label}を出せません`, "DOC_NOT_APPLICABLE");
      // 止める項目(賃借人がいない・金額が無いなど)は画面だけでなくサーバーでも止める(空の書類を作らない)。
      const blocking = businessDoc.blocking(bctx);
      if (blocking.length) throw new ApiError(422, `${blocking.join("・")}が無いと${businessDoc.label}を出せません`, "DOC_BLOCKED");
      const parsed = businessDoc.options.parse(options ?? {});
      let out: ReturnType<typeof businessDoc.build>;
      try {
        out = businessDoc.build(bctx, parsed);
      } catch (e) {
        if (e instanceof DocOptionError) throw new ApiError(422, e.message, e.code);
        throw e;
      }
      built = {
        variant: businessDoc.variantOf ? businessDoc.variantOf(parsed) : "default", inputs: { options: parsed }, calc: { settlement: bctx.calc.settlement }, html: out.html, compactHtml: out.compactHtml,
        xlsx: () => buildValuesXlsx({ title: businessDoc.label, dealNo: deal.dealNo, issuedOn: today, rows: out.rows, issuerName: out.issuerName ?? company.nameJa }),
      };
    } else if (docType === "business_plan") {
      const inputs = deal.businessPlan;
      const kinds = settings.propertyKinds;
      const plan = buildBusinessPlan({ deal, rateRows, kinds, matrix: settings.sectionMatrix, inputs, company, today, logo: branding.logo });
      const kindLabel = kinds.find((k) => k.key === deal.propertyKind)?.label ?? null;
      built = {
        variant: inputs.variant, inputs, calc: plan.calc, html: plan.html,
        xlsx: () => buildBusinessPlanXlsx({ deal, inputs, calc: plan.calc, sections: plan.sections, company, issuedOn: today, kindLabel }),
      };
    } else {
      const inputs = deal.fundingPlan;
      const text = settings.texts.funding_plan;
      const { calc, html } = buildFundingPlan({ deal, rateRows, kinds: settings.propertyKinds, inputs, company, today, logo: branding.logo, text });
      built = { variant: inputs.mode, inputs, calc, html, xlsx: () => buildFundingPlanXlsx({ deal, inputs, calc, company, issuedOn: today, text }) };
    }
    if (!isChromiumAvailable()) {
      throw new ApiError(503, "PDF を作る仕組みが使えません(サーバーの設定)", "PDF_UNAVAILABLE");
    }
    let pdf = await renderHtmlToPdfDocument(built.html);
    // 精算書: 1枚に収まらなければ、計算の過程を2枚目に回した形で作り直す(段5の読み替え 6)。
    if (built.compactHtml && pdfPageCount(pdf) > 1) pdf = await renderHtmlToPdfDocument(built.compactHtml);
    const xlsx = await built.xlsx();
    const { variant, inputs, calc } = built;
    const fileBaseName = dealDocumentBaseName(deal.dealNo, docType, variant, today);
    const storage = getStorage();
    const fileId = safeRandomId();
    const stored: string[] = [];
    const put = async (body: Buffer, format: DealDocFormat) => {
      const res = await storage.upload(body, {
        key: dealDocumentKey(id, fileId, format), mimeType: DEAL_DOC_MIME[format], fileName: `${fileBaseName}.${format}`,
      });
      stored.push(res.key);
      return res.key;
    };

    let created: { id: string; version: number };
    try {
      const pdfKey = await put(pdf, "pdf");
      const xlsxKey = await put(xlsx, "xlsx");
      for (let attempt = 1; ; attempt++) {
        const latest = await prisma.dealDocument.findFirst({
          where: { dealId: id, docType, variant }, orderBy: { version: "desc" }, select: { version: true },
        });
        try {
          created = await prisma.dealDocument.create({
            data: {
              dealId: id, docType, variant, version: (latest?.version ?? 0) + 1, issuedById: session.id,
              inputSnapshot: inputs as object, calcSnapshot: calc as object, pdfKey, xlsxKey, fileBaseName,
            },
            select: { id: true, version: true },
          });
          break;
        } catch (e) {
          if (isUniqueViolation(e) && attempt < VERSION_ATTEMPTS) continue;
          if (isUniqueViolation(e)) throw new ApiError(409, "ほかの人が同時に発行しました。もう一度「発行」を押してください。", "DOC_VERSION_BUSY");
          throw e;
        }
      }
    } catch (e) {
      // 記録の無いファイルは誰も開けない(開く道は記録から引く)が、置きっぱなしにしない。
      await Promise.all(stored.map((k) => storage.delete(k).catch(() => undefined)));
      throw e;
    }

    // 監査には書類の種類・版だけ(お客様名・住所・金額は残さない)。
    await writeAuditLog({
      userId: session.id, action: "deal_document_issue", targetTable: "deals", targetId: id,
      detail: { docType, variant, version: created.version, formats: ["pdf", "xlsx"] },
    });
    return NextResponse.json(
      { id: created.id, version: created.version, title: dealDocumentTitle(docType, variant), fileBaseName },
      { status: 201, headers: NO_STORE },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
