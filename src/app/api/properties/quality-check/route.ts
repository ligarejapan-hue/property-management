import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma";

interface QualityIssue {
  propertyId: string;
  address: string;
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
}

interface RuleMeta {
  rule: string;
  severity: QualityIssue["severity"];
  totalCount: number; // そのルールに該当する全体件数（DB count）
  returnedCount: number; // 今回 data に含めた件数
  offset: number; // 今回の取得開始位置
  hasMore: boolean; // offset+returnedCount < totalCount
  nextOffset: number | null; // 続きを取得する際の offset（無ければ null）
}

// ---------- GET /api/properties/quality-check ----------
//
// 物件一覧ロード時に毎回呼ばれる。全件 findMany + JS 全件判定はせず、各品質ルールを Prisma の
// where 条件に落とし込み「その問題を持つ物件だけ」を DB 側で扱う。
//
// 3 モード:
//  (1) 既定（rule / propertyIds 未指定）: summary(全体実件数=count) + 各ルール先頭 QUALITY_CHECK_ISSUE_LIMIT 件の
//      data(表示用・propertyId 単位マージ) + rules(各ルールの totalCount/hasMore/nextOffset 等)。
//  (2) ページング（?rule=CODE&offset=&limit=）: 当該ルールのみ skip/take で DB から1ページ取得。
//      これにより上限を超えた残り issue を UI から追加取得できる（到達不能を解消）。
//  (3) scoped（?propertyIds=id1,id2,…）: 一覧バッジ用。指定物件だけを各ルールで判定し（PK IN・
//      結果は ids 件数で有界）、チップ用の warningPropertiesTotal（全体実数）を追加で返す（17-C F2）。
//
//  - summary.errors/warnings/info/total は count(全体件数) を severity 合算（truncate 後 data からは数えない）。
//  - data 取得列は id/address のみ。所有者は relation filter のみで Owner PII 列は取得しない。
//  - 全件 findMany には戻さない / 5000件超でも hard fail しない（常に 200。rule 不正のみ 400）。

// 1ルールあたりに data へ載せる issue 件数の既定値かつ最大値（表示用ページサイズ）。
const QUALITY_CHECK_ISSUE_LIMIT = 1000;

// scoped モード（?propertyIds=）で受け付ける物件IDの最大数（一覧1ページ=50 の余裕枠）。
const PROPERTY_IDS_SCOPE_MAX = 200;

// Property.id は PostgreSQL の uuid 列。不正な形式を Prisma の id:{in} に渡すと
// Postgres 側で invalid uuid syntax → 意図しない 500 になるため、クエリ前に
// UUID 形式（大文字小文字許容）を検証して 400 で弾く（Codex review対応）。
// bulk-update API の propertyIds（z.array(z.string().uuid())・validators.ts）と同じ zod 判定。
const propertyIdSchema = z.string().uuid();

const NOT_ARCHIVED: Prisma.PropertyWhereInput = { isArchived: false };

// 各品質ルール。where は NOT_ARCHIVED と AND して「その問題を持つ物件」を抽出する。
// 旧実装（全件取得して JS で判定）と同一の判定になるよう条件を表現する。
const QUALITY_RULES: ReadonlyArray<{
  code: string;
  severity: QualityIssue["severity"];
  message: string;
  where: Prisma.PropertyWhereInput;
}> = [
  {
    code: "NO_OWNER",
    severity: "warning",
    message: "所有者が紐付けられていません",
    where: { propertyOwners: { none: {} } },
  },
  {
    code: "REGISTRY_DM_MISMATCH",
    severity: "error",
    message: "登記未取得なのにDM送付可になっています",
    where: { registryStatus: "unconfirmed", dmStatus: "send" },
  },
  {
    code: "NO_LOT_NUMBER",
    severity: "info",
    message: "地番が未入力です",
    where: { OR: [{ lotNumber: null }, { lotNumber: "" }] },
  },
  {
    code: "NO_REAL_ESTATE_NUMBER",
    severity: "info",
    message: "不動産番号が未入力です",
    where: { OR: [{ realEstateNumber: null }, { realEstateNumber: "" }] },
  },
  {
    code: "INVESTIGATION_NOT_CONFIRMED",
    severity: "warning",
    message: "調査情報が未確認です",
    where: { investigationConfirmedAt: null },
  },
  {
    code: "NO_ASSIGNEE",
    severity: "warning",
    message: "担当者が未設定です",
    where: { assignedTo: null },
  },
];

type QualityRule = (typeof QUALITY_RULES)[number];

function findRule(code: string): QualityRule | undefined {
  return QUALITY_RULES.find((r) => r.code === code);
}

function buildIssue(
  rule: QualityRule,
  p: { id: string; address: string },
): QualityIssue {
  return {
    propertyId: p.id,
    address: p.address,
    severity: rule.severity,
    code: rule.code,
    message: rule.message,
  };
}

// offset は 0 以上の整数に正規化（不正・負値は 0）。
function parseOffset(raw: string | null): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// limit は [1, QUALITY_CHECK_ISSUE_LIMIT] に丸める（不正は既定値、超過は最大値）。
function parseLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return QUALITY_CHECK_ISSUE_LIMIT;
  return Math.min(Math.floor(n), QUALITY_CHECK_ISSUE_LIMIT);
}

export async function GET(request: Request) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const { searchParams } = new URL(request.url);
    const ruleParam = searchParams.get("rule");

    // ---- (2) ページングモード: 指定ルールのみ skip/take で1ページ取得 ----
    if (ruleParam !== null) {
      const rule = findRule(ruleParam);
      if (!rule) {
        throw new ApiError(400, "不明な品質チェックルールです", "INVALID_RULE");
      }
      const offset = parseOffset(searchParams.get("offset"));
      const limit = parseLimit(searchParams.get("limit"));
      const where: Prisma.PropertyWhereInput = {
        ...NOT_ARCHIVED,
        ...rule.where,
      };
      const [totalCount, page] = await Promise.all([
        prisma.property.count({ where }),
        prisma.property.findMany({
          where,
          select: { id: true, address: true },
          orderBy: { id: "asc" }, // 安定ページング（PK 昇順）
          skip: offset,
          take: limit,
        }),
      ]);
      const data = page.map((p) => buildIssue(rule, p));
      const returnedCount = data.length;
      const hasMore = offset + returnedCount < totalCount;
      const meta: RuleMeta = {
        rule: rule.code,
        severity: rule.severity,
        totalCount,
        returnedCount,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + returnedCount : null,
      };
      return apiResponse({ data, rules: [meta] });
    }

    // ---- (3) scoped モード（?propertyIds=）: 一覧バッジ用に「表示中の物件」だけ判定 ----
    // 既定モードの DB 全域取得（各ルール先頭 1000 件 + 全域 count）を発行せず、指定
    // propertyIds に AND（PK IN）で絞った各ルール findMany のみで判定する。
    // 「警告ありのみ」チップ用に warningPropertiesTotal（error/warning ルールのいずれかに
    // 該当する非アーカイブ物件の distinct 実数・truncate なし）を追加で返す。
    // ?rule= ページングモードが先に評価されるため、rule 指定時の propertyIds は無視される。
    const propertyIdsParam = searchParams.get("propertyIds");
    if (propertyIdsParam !== null) {
      const ids = Array.from(
        new Set(
          propertyIdsParam
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
        ),
      );
      if (ids.length > PROPERTY_IDS_SCOPE_MAX) {
        throw new ApiError(
          400,
          `propertyIds は最大 ${PROPERTY_IDS_SCOPE_MAX} 件までです`,
          "INVALID_PROPERTY_IDS",
        );
      }
      // 1件でも UUID 形式でない ID があれば DB へ渡さず 400（上限超過と同じエラーコード）。
      if (!ids.every((id) => propertyIdSchema.safeParse(id).success)) {
        throw new ApiError(
          400,
          "propertyIds に不正な形式のIDが含まれています",
          "INVALID_PROPERTY_IDS",
        );
      }

      // hasWarning 一覧フィルタ（property-list-query.ts）と同じ「error/warning ルールの OR」。
      // info ルール（地番・不動産番号未入力）はバッジ・チップの対象外なので含めない。
      const warningWhere: Prisma.PropertyWhereInput = {
        ...NOT_ARCHIVED,
        OR: QUALITY_RULES.filter((r) => r.severity !== "info").map(
          (r) => r.where,
        ),
      };

      const [warningPropertiesTotal, scopedResults] = await Promise.all([
        prisma.property.count({ where: warningWhere }),
        ids.length === 0
          ? Promise.resolve(
              [] as Array<{
                rule: QualityRule;
                sample: { id: string; address: string }[];
              }>,
            )
          : Promise.all(
              QUALITY_RULES.map(async (rule) => ({
                rule,
                sample: await prisma.property.findMany({
                  where: { ...NOT_ARCHIVED, ...rule.where, id: { in: ids } },
                  select: { id: true, address: true },
                  orderBy: { id: "asc" },
                }),
              })),
            ),
      ]);

      const severityTotals: Record<QualityIssue["severity"], number> = {
        error: 0,
        warning: 0,
        info: 0,
      };
      const rules: RuleMeta[] = [];
      const byProperty = new Map<string, QualityIssue[]>();
      for (const { rule, sample } of scopedResults) {
        severityTotals[rule.severity] += sample.length;
        rules.push({
          rule: rule.code,
          severity: rule.severity,
          // ids（PK IN）で有界のため count クエリ不要＝sample 全件が当該 scope の実数。
          totalCount: sample.length,
          returnedCount: sample.length,
          offset: 0,
          hasMore: false,
          nextOffset: null,
        });
        for (const p of sample) {
          const issue = buildIssue(rule, p);
          const existing = byProperty.get(p.id);
          if (existing) {
            existing.push(issue);
          } else {
            byProperty.set(p.id, [issue]);
          }
        }
      }
      const severityOrder = { error: 0, warning: 1, info: 2 };
      const issues: QualityIssue[] = [];
      for (const list of byProperty.values()) {
        for (const issue of list) issues.push(issue);
      }
      issues.sort(
        (a, b) => severityOrder[a.severity] - severityOrder[b.severity],
      );

      return apiResponse({
        data: issues,
        summary: {
          total:
            severityTotals.error + severityTotals.warning + severityTotals.info,
          errors: severityTotals.error,
          warnings: severityTotals.warning,
          info: severityTotals.info,
          // scoped モードでは「チェック対象 = 指定 propertyIds 件数」（DB 全域 count はしない）。
          propertiesChecked: ids.length,
          issuesReturned: issues.length,
          issuesLimited: false,
          issueLimit: QUALITY_CHECK_ISSUE_LIMIT,
        },
        rules,
        // additive（非PII）: scoped モード識別子と「警告あり物件の全体実数」。
        scope: { propertyIds: ids.length },
        warningPropertiesTotal,
      });
    }

    // ---- (1) 既定モード: 全非アーカイブ件数(count) と 各ルールの count + 先頭ページ ----
    const [propertiesChecked, ruleResults] = await Promise.all([
      prisma.property.count({ where: NOT_ARCHIVED }),
      Promise.all(
        QUALITY_RULES.map(async (rule) => {
          const where: Prisma.PropertyWhereInput = {
            ...NOT_ARCHIVED,
            ...rule.where,
          };
          const [count, sample] = await Promise.all([
            prisma.property.count({ where }),
            prisma.property.findMany({
              where,
              select: { id: true, address: true },
              orderBy: { id: "asc" },
              take: QUALITY_CHECK_ISSUE_LIMIT,
            }),
          ]);
          return { rule, count, sample };
        }),
      ),
    ]);

    // summary は count(全体実件数) を severity ごとに合算（truncate 後 data からは数えない）。
    const severityTotals: Record<QualityIssue["severity"], number> = {
      error: 0,
      warning: 0,
      info: 0,
    };
    let issuesLimited = false;
    const rules: RuleMeta[] = [];

    // data(表示用) は propertyId 単位でマージ（同一物件が複数ルールに該当しても取りこぼさない）。
    const byProperty = new Map<string, QualityIssue[]>();

    for (const { rule, count, sample } of ruleResults) {
      severityTotals[rule.severity] += count;
      const returnedCount = sample.length;
      const hasMore = count > returnedCount;
      if (hasMore) issuesLimited = true;
      rules.push({
        rule: rule.code,
        severity: rule.severity,
        totalCount: count,
        returnedCount,
        offset: 0,
        hasMore,
        nextOffset: hasMore ? returnedCount : null,
      });
      for (const p of sample) {
        const issue = buildIssue(rule, p);
        const existing = byProperty.get(p.id);
        if (existing) {
          existing.push(issue);
        } else {
          byProperty.set(p.id, [issue]);
        }
      }
    }

    // 表示用 issues をフラット化し、error > warning > info の順に並べる（従来レスポンス互換）。
    const severityOrder = { error: 0, warning: 1, info: 2 };
    const issues: QualityIssue[] = [];
    for (const list of byProperty.values()) {
      for (const issue of list) issues.push(issue);
    }
    issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    const total =
      severityTotals.error + severityTotals.warning + severityTotals.info;

    return apiResponse({
      data: issues,
      summary: {
        // 全体実件数（count ベース）。表示用 data の truncate には影響されない。
        total,
        errors: severityTotals.error,
        warnings: severityTotals.warning,
        info: severityTotals.info,
        propertiesChecked,
        // data に実際に含まれる issue 行数。truncate 時は total > issuesReturned。
        issuesReturned: issues.length,
        // いずれかのルールで data を丸めたか（非PII・常に 200）。詳細は rules[].hasMore 参照。
        issuesLimited,
        // 1ルールあたりの表示ページサイズ（非PII）。
        issueLimit: QUALITY_CHECK_ISSUE_LIMIT,
      },
      // 各ルールの全体件数・続き取得情報（非PII）。hasMore のルールは ?rule=CODE&offset=nextOffset で追加取得可。
      rules,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
