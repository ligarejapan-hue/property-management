import { NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireScenarioAdmin, lockScenarioForUpdate } from "@/lib/sale-dm-letter/scenario-guard";
import { saleDmScenarioPatchSchema } from "@/lib/validators-sale-dm";
import { letterIllustrationFromAsset } from "@/lib/sale-dm-letter/letter-illustration";

type Ctx = { params: Promise<{ id: string }> };

// 手紙側の設定(プロンプトに載る項目)。変わったら古い指示文・原文を消す。
// ⚠designTemplate(印刷デザイン)と extraInstruction(追加の指示)は外部AI方式のプロンプト
//   (buildExternalPrompt は tone/length/appeal/strength だけを見る)に含まれないので、
//   変えても文面は変わらない。にもかかわらずここで無効化すると、得るもの無しに
//   letterBodyTemplate/letterPromptText を消してしまう(campaign 側の variant PATCH は
//   同じ理由でこの2つを無効化の契機にしていない。@codex #376 R3/R8、設計 §2.4)。
const LETTER_KEYS = ["tone", "length", "appeal", "strength"] as const;
// LP側の設定。変わったら原文・切り分け結果・写真と図の枠を消す。
const LP_KEYS = ["lpTone", "lpLength", "lpAppeal", "lpStrength"] as const;

/** DMの種類 個別取得(管理者だけ)。削除済みは 404。 */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    await requireScenarioAdmin();
    const { id } = await params;
    const row = await prisma.dmScenario.findFirst({
      where: { id, deletedAt: null },
      include: { letterIllustrationAsset: { select: { publicId: true, width: true, height: true, deletedAt: true } } },
    });
    if (!row) throw new ApiError(404, "DMの種類が見つかりません", "SCENARIO_NOT_FOUND");
    // 写真の行そのものは返さず、描画用の形(src・寸法)にして付ける(削除済みは null)。
    const { letterIllustrationAsset, ...scenario } = row;
    return NextResponse.json(
      { scenario: { ...scenario, letterIllustration: letterIllustrationFromAsset(letterIllustrationAsset) } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * DMの種類の変更(設計 §3.3)。先に対象行を FOR UPDATE でロックし、
 * 手紙/LPそれぞれの設定(語調等)が実際に変わっていたら、古いプロンプトで作った
 * 文面・指示文(・LPは写真と図の枠も)を消す。監査には変わった列名の配列だけを残す。
 */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const { session } = await requireScenarioAdmin();
    const { id } = await params;
    const parsed = saleDmScenarioPatchSchema.parse(await parseJsonBody(request));

    const changedFields = await prisma.$transaction(async (tx) => {
      await lockScenarioForUpdate(tx, id);
      const cur = await tx.dmScenario.findUniqueOrThrow({ where: { id } });
      const changed = (Object.keys(parsed) as (keyof typeof parsed)[]).filter(
        (k) => (cur as Record<string, unknown>)[k] !== parsed[k],
      );
      if (changed.length === 0) return [] as string[];

      const data: Prisma.DmScenarioUpdateInput = { ...parsed };
      if (changed.some((k) => (LETTER_KEYS as readonly string[]).includes(k))) {
        Object.assign(data, { letterPromptText: null, letterBodyTemplate: null });
      }
      if (changed.some((k) => (LP_KEYS as readonly string[]).includes(k))) {
        Object.assign(data, {
          lpPromptText: null,
          lpRawTemplate: null,
          lpHeadline: null,
          lpLead: null,
          lpBodyText: null,
          lpFaqJson: Prisma.DbNull,
        });
        await tx.dmScenarioMedia.deleteMany({ where: { scenarioId: id } });
      }

      try {
        await tx.dmScenario.update({ where: { id }, data });
      } catch (e) {
        if ((e as { code?: string }).code === "P2002") {
          throw new ApiError(409, "同じ名前のDMの種類があります", "NAME_TAKEN");
        }
        throw e;
      }
      return changed as string[];
    });

    if (changedFields.length > 0) {
      await writeAuditLog({
        userId: session.id,
        action: "sale_dm_scenario_update",
        targetTable: "dm_scenarios",
        targetId: id,
        detail: { changedFields },
      });
    }
    return NextResponse.json({ changedFields }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * DMの種類の削除(論理削除。設計 §3.1)。参照(物件/発送の既定/型)があれば 409、
 * auto_key の行(相続・空き家)は消せない(409)。物理 DELETE は使わない
 * (RESTRICT の参照検査が物件行を読み、物件の保存と逆向きに待ち合うのを避ける)。
 */
export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { session } = await requireScenarioAdmin();
    const { id } = await params;
    await prisma.$transaction(async (tx) => {
      await lockScenarioForUpdate(tx, id);
      const cur = await tx.dmScenario.findUniqueOrThrow({ where: { id }, select: { autoKey: true } });
      if (cur.autoKey) {
        throw new ApiError(409, "相続・空き家は消せません。止めるときは「使わない」にしてください", "SCENARIO_RESERVED");
      }
      const [p, c, v, l] = await Promise.all([
        tx.property.count({ where: { dmScenarioId: id } }),
        tx.dmCampaign.count({ where: { defaultScenarioId: id } }),
        tx.dmVariant.count({ where: { scenarioId: id } }),
        tx.dmLpVariant.count({ where: { scenarioId: id } }),
      ]);
      if (p + c + v + l > 0) {
        throw new ApiError(409, "このDMの種類は物件や発送で使われています。「使わない」にしてください", "SCENARIO_IN_USE");
      }
      await tx.dmScenario.update({ where: { id }, data: { deletedAt: new Date(), active: false } });
    });
    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_scenario_delete",
      targetTable: "dm_scenarios",
      targetId: id,
      detail: { result: "deleted" },
    });
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
