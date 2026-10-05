/**
 * 「DMの種類」作成と「種類を変える」が必ず通る共通手順(設計 2026-09-27-sale-dm-scenarios-design.md §3.3.0)。
 * 準備の検査・写す対応表・差し込み検査・台帳の全行ロックをここに1か所だけ持つ
 * (作成側と変更側の片方だけ守りが漏れる事故を防ぐ)。
 */
import { Prisma } from "@/generated/prisma";
import {
  expandLetterTags,
  coarsePropertyLocation,
  propertyTypeLabel,
  hasUnresolvedTag,
} from "@/lib/sale-dm-letter/tags";
import { validateLetterBody } from "@/lib/sale-dm-letter/body-validation";

type TxLike = Prisma.TransactionClient;

/** 台帳(DmScenario)の全列。手紙・LP どちらも写す前提の値をここに集める。 */
export type ScenarioFull = {
  id: string;
  name: string;
  autoKey: string | null;
  active: boolean;
  deletedAt: Date | null;
  designTemplate: string | null;
  tone: string | null;
  length: string | null;
  appeal: string | null;
  strength: string | null;
  extraInstruction: string | null;
  letterPromptText: string | null;
  letterBodyTemplate: string | null;
  letterIllustrationAssetId: string | null;
  lpTone: string | null;
  lpLength: string | null;
  lpAppeal: string | null;
  lpStrength: string | null;
  lpPromptText: string | null;
  lpRawTemplate: string | null;
  lpHeadline: string | null;
  lpLead: string | null;
  lpBodyText: string | null;
  lpFaqJson: unknown;
};

export type ReadyResult =
  | { ok: true; hasLp: boolean }
  | { ok: false; reason: "unusable" | "letter_missing" };

/** [台帳(DmScenario)の列, DmVariant の列]。 */
export const LETTER_COPY_MAP: ReadonlyArray<readonly [keyof ScenarioFull, string]> = [
  ["designTemplate", "designTemplate"],
  ["tone", "tone"],
  ["length", "length"],
  ["appeal", "appeal"],
  ["strength", "strength"],
  ["extraInstruction", "extraInstruction"],
  ["letterPromptText", "promptText"],
  ["letterBodyTemplate", "bodyTemplate"],
  // 手紙のイラスト(設計 2026-10-05 §7)。写真の ID をそのまま写す(削除済みは描画側が隠す)。
  ["letterIllustrationAssetId", "illustrationAssetId"],
] as const;

/** [台帳(DmScenario)の列, DmLpVariant の列]。 */
export const LP_COPY_MAP: ReadonlyArray<readonly [keyof ScenarioFull, string]> = [
  ["lpTone", "tone"],
  ["lpLength", "length"],
  ["lpAppeal", "appeal"],
  ["lpStrength", "strength"],
  ["lpPromptText", "promptText"],
  ["lpRawTemplate", "rawTemplate"],
  ["lpHeadline", "headline"],
  ["lpLead", "lead"],
  ["lpBodyText", "bodyText"],
  ["lpFaqJson", "faqJson"],
] as const;

/** isLetterReady の判定に要る台帳の列(選択肢の `ready` もこれだけ読んで同じ判定をする)。 */
export const LETTER_READY_SELECT = {
  letterBodyTemplate: true,
  designTemplate: true,
  tone: true,
  length: true,
  appeal: true,
  strength: true,
} as const;

export type LetterReadyFields = Pick<ScenarioFull, keyof typeof LETTER_READY_SELECT>;

/**
 * 手紙として写せる状態か。DmVariant の NOT NULL 列(designTemplate/tone/length/appeal/strength)を
 * 埋められること、かつ本文(letterBodyTemplate)が空でないことが条件。
 * 作成・種類を変える(checkScenarioReady)と選択肢の `ready` が同じこの判定を使う。
 */
export function isLetterReady(s: LetterReadyFields): boolean {
  return (
    !!s.letterBodyTemplate?.trim() &&
    !!s.designTemplate &&
    !!s.tone &&
    !!s.length &&
    !!s.appeal &&
    !!s.strength
  );
}

/**
 * LPとして写せる状態か。DmLpVariant の NOT NULL 列(tone/length/appeal/strength)を埋められること、
 * かつ本文(lpBodyText)・見出し(lpHeadline)が空でないことが条件。どれか1つでも欠ければ「LP無し」扱い。
 */
function isLpReady(s: ScenarioFull): boolean {
  return (
    !!s.lpBodyText?.trim() &&
    !!s.lpHeadline?.trim() &&
    !!s.lpTone &&
    !!s.lpLength &&
    !!s.lpAppeal &&
    !!s.lpStrength
  );
}

export function checkScenarioReady(s: ScenarioFull): ReadyResult {
  if (!s.active || s.deletedAt) return { ok: false, reason: "unusable" };
  if (!isLetterReady(s)) return { ok: false, reason: "letter_missing" };
  return { ok: true, hasLp: isLpReady(s) };
}

/** DmVariant.create 用のデータ。scenarioId/label は写した型に必ず付く。lpUrl は含めない(=NULL)。 */
export function letterVariantData(campaignId: string, s: ScenarioFull): Record<string, unknown> {
  const data: Record<string, unknown> = { campaignId, label: s.name, scenarioId: s.id };
  for (const [from, to] of LETTER_COPY_MAP) data[to] = s[from];
  return data;
}

/**
 * DmLpVariant.create 用のデータ。LPとして写せない(isLpReady=false)ときは null(=LP無しで作成しない)。
 * faqJson は素の null を渡すと「JSON の null 値」になってしまうため、DB NULL は Prisma.DbNull で表す。
 */
export function lpVariantData(campaignId: string, s: ScenarioFull): Record<string, unknown> | null {
  if (!isLpReady(s)) return null;
  const data: Record<string, unknown> = { campaignId, label: s.name, scenarioId: s.id };
  for (const [from, to] of LP_COPY_MAP) {
    const value = s[from];
    data[to] = from === "lpFaqJson" && value === null ? Prisma.DbNull : value;
  }
  return data;
}

export type ExpandResult = { body: string; blank: false } | { body: ""; blank: true };

/** その発送で種類から写した手紙の型と LP の型の組(LP の無い種類は null)+差し込み前の本文。 */
export type ScenarioPair = { letterVariantId: string; lpVariantId: string | null; template: string };

/**
 * 宛先に付けて差し込む(設計 §3.3.0-3)。作成と「種類を変える」の両方が通る共通手順。純関数。
 * 組は写した組をそのまま付け(手紙と LP を別々に選ばない)、本文は expandDraftBody で差し込む。
 * 差し込めない宛先は本文を空・blank=true(呼び出し側が件数を数える)。
 */
export function attachScenario(
  pair: ScenarioPair,
  property: { address: string | null; propertyType: string | null },
): { variantId: string; lpVariantId: string | null; body: string; blank: boolean } {
  const expanded = expandDraftBody(pair.template, property);
  return { variantId: pair.letterVariantId, lpVariantId: pair.lpVariantId, body: expanded.body, blank: expanded.blank };
}

/**
 * 下書きの本文を物件ごとに差し込む(適用時の展開と同じ手順・apply/route.ts と同じ検査)。
 * 差し込めない(未解決タグが残る/展開後の本文が不正)ときは空のまま「下書き」を返す。
 */
export function expandDraftBody(
  template: string,
  property: { address: string | null; propertyType: string | null },
): ExpandResult {
  const expanded = expandLetterTags(template, {
    location: coarsePropertyLocation(property.address),
    propertyType: propertyTypeLabel(property.propertyType),
  });
  if (hasUnresolvedTag(expanded) || validateLetterBody(expanded) !== null) {
    return { body: "", blank: true };
  }
  return { body: expanded, blank: false };
}

/**
 * 台帳(dm_scenarios)の全行を1本の問い合わせで FOR SHARE する(設計 §3.3 のロック順の最後)。
 * 候補を先に絞らない=WHERE無し。読む側どうしは待たない(FOR SHARE)。
 */
export async function lockAllScenariosForShare(tx: {
  $queryRaw: (...args: never[]) => Promise<unknown>;
}): Promise<void> {
  // 宣言上の型は呼び出し側(モック含む)を素通りさせるための最小の形(never[])。
  // タグ付きテンプレート呼び出しには TemplateStringsArray を受け取れる形が要るのでここだけ広げる。
  // ⚠Prisma の $queryRaw はメソッド(this=client/tx が要る)。取り出して素で呼ぶと本物の DB で
  //   「reading '_createPrismaPromise'」で必ず落ちる(モックでは通る)。tx に bind する。
  const run = (tx.$queryRaw as unknown as (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<unknown>).bind(tx);
  await run`SELECT id FROM dm_scenarios ORDER BY id FOR SHARE`;
}

const SCENARIO_FULL_SELECT = {
  id: true,
  name: true,
  autoKey: true,
  active: true,
  deletedAt: true,
  designTemplate: true,
  tone: true,
  length: true,
  appeal: true,
  strength: true,
  extraInstruction: true,
  letterPromptText: true,
  letterBodyTemplate: true,
  letterIllustrationAssetId: true,
  lpTone: true,
  lpLength: true,
  lpAppeal: true,
  lpStrength: true,
  lpPromptText: true,
  lpRawTemplate: true,
  lpHeadline: true,
  lpLead: true,
  lpBodyText: true,
  lpFaqJson: true,
} as const;

/** 台帳の全行(削除済み含む)を読む。ロック(lockAllScenariosForShare)の後に呼ぶこと。 */
export async function loadScenariosForCopy(tx: TxLike): Promise<ScenarioFull[]> {
  return tx.dmScenario.findMany({ select: SCENARIO_FULL_SELECT }) as unknown as Promise<ScenarioFull[]>;
}

/**
 * 種類 s をキャンペーンへ写す。既に写し(campaignId+scenarioId)があればそれを返し、
 * 二重に作らない。返す template(差し込み前の本文)は、既に写しがあれば「その写しの本文」、
 * 新しく写したときだけ台帳の本文(台帳は凍結されず後から書き換わるので、既存の写しに寄せる宛先の本文が
 * 写し・承認済み・印刷済みのどれとも食い違わないようにする)(パーシャル一意索引が最後の砦・P2002 はここで飲み込まず呼び出し側へ伝播させる)。
 * 写真の割り付け(assetId)が削除済みの写真を指していてもそのまま複製する
 * (公開時の描画側 toImage が deletedAt を見て隠す)。
 */
export async function copyScenarioIntoCampaign(
  tx: TxLike,
  campaignId: string,
  s: ScenarioFull,
): Promise<ScenarioPair> {
  const existing = await tx.dmVariant.findFirst({
    where: { campaignId, scenarioId: s.id },
    select: { id: true, bodyTemplate: true },
  });
  if (existing) {
    const lp = await tx.dmLpVariant.findFirst({
      where: { campaignId, scenarioId: s.id },
      select: { id: true },
    });
    return { letterVariantId: existing.id, lpVariantId: lp?.id ?? null, template: existing.bodyTemplate ?? "" };
  }

  const v = await tx.dmVariant.create({
    data: letterVariantData(campaignId, s) as Prisma.DmVariantUncheckedCreateInput,
    select: { id: true },
  });

  // 新しく写した=写しの本文は台帳の本文そのもの(letterVariantData が同じ値を書く)。
  const template = s.letterBodyTemplate ?? "";
  const lpData = lpVariantData(campaignId, s);
  if (!lpData) return { letterVariantId: v.id, lpVariantId: null, template };

  const lp = await tx.dmLpVariant.create({
    data: lpData as Prisma.DmLpVariantUncheckedCreateInput,
    select: { id: true },
  });

  const media = await tx.dmScenarioMedia.findMany({
    where: { scenarioId: s.id },
    orderBy: { sortOrder: "asc" },
  });
  if (media.length > 0) {
    await tx.dmLpVariantMedia.createMany({
      data: media.map((m) => ({
        lpVariantId: lp.id,
        slot: m.slot,
        heading: m.heading,
        assetId: m.assetId,
        figureKind: m.figureKind,
        sortOrder: m.sortOrder,
      })),
    });
  }

  return { letterVariantId: v.id, lpVariantId: lp.id, template };
}
