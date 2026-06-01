import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import type { Prisma } from "@/generated/prisma";

interface QualityIssue {
  propertyId: string;
  address: string;
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
}

// ---------- GET /api/properties/quality-check ----------
//
// 物件一覧ロード時に毎回呼ばれる。全非アーカイブ物件を無制限に取得して JS で全件判定する
// のではなく（物件総数が多くても使えるように）、各品質ルールを Prisma の where 条件へ
// 落とし込んで「その問題を持つ物件だけ」を DB 側で扱う。
//
// summary と data の意味を分離する:
//  - summary.errors / warnings / info / total: 各ルールの「全体実件数(count)」を severity ごとに
//    合算した値。表示用 issues の truncate には影響されない（operator が実件数を誤認しない）。
//  - data(issues): 表示用サンプル。各ルール最大 QUALITY_CHECK_ISSUE_LIMIT 件まで（id/address のみ）。
//  - summary.issuesReturned: data に実際に含まれる issue 行数（サンプル件数）。
//  - summary.issuesLimited: いずれかのルールで全体件数 > issueLimit となり data を丸めたか（非PII）。
//    hard fail / 不完全スキャンではなく「表示が一部」を示すだけ。常に 200。
//  - summary.propertiesChecked: 全非アーカイブ物件数(count)。
//
// 取得列は id / address のみ。所有者は relation filter のみで Owner PII 列は取得しない。

// 1ルールあたりに data へ列挙する問題物件数の上限（表示用サンプルの上限。スキャン上限ではない）。
const QUALITY_CHECK_ISSUE_LIMIT = 1000;

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
    // 旧: p.propertyOwners.length === 0 → relation filter（所有者データ自体は取得しない）
    where: { propertyOwners: { none: {} } },
  },
  {
    code: "REGISTRY_DM_MISMATCH",
    severity: "error",
    message: "登記未取得なのにDM送付可になっています",
    // 旧: registryStatus === "unconfirmed" && dmStatus === "send"
    where: { registryStatus: "unconfirmed", dmStatus: "send" },
  },
  {
    code: "NO_LOT_NUMBER",
    severity: "info",
    message: "地番が未入力です",
    // 旧: !p.lotNumber（null または空文字）
    where: { OR: [{ lotNumber: null }, { lotNumber: "" }] },
  },
  {
    code: "NO_REAL_ESTATE_NUMBER",
    severity: "info",
    message: "不動産番号が未入力です",
    // 旧: !p.realEstateNumber（null または空文字）
    where: { OR: [{ realEstateNumber: null }, { realEstateNumber: "" }] },
  },
  {
    code: "INVESTIGATION_NOT_CONFIRMED",
    severity: "warning",
    message: "調査情報が未確認です",
    // 旧: !p.investigationConfirmedAt（DateTime のため null のみ）
    where: { investigationConfirmedAt: null },
  },
  {
    code: "NO_ASSIGNEE",
    severity: "warning",
    message: "担当者が未設定です",
    // 旧: !p.assignedTo（uuid 列のため null のみ）
    where: { assignedTo: null },
  },
];

export async function GET() {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    // 全非アーカイブ件数(count) と、各ルールの「全体件数(count)」＋「表示用サンプル(findMany)」を
    // 並列取得する。count は全体実件数、findMany は最大 QUALITY_CHECK_ISSUE_LIMIT 件の表示用。
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
              take: QUALITY_CHECK_ISSUE_LIMIT,
            }),
          ]);
          return { rule, count, sample };
        }),
      ),
    ]);

    // summary は「全体実件数(count)」を severity ごとに合算する（truncate 後 issues からは数えない）。
    // 旧仕様どおり 1 物件が複数ルールに該当すれば issue 件数も複数として数える。
    const severityTotals: Record<QualityIssue["severity"], number> = {
      error: 0,
      warning: 0,
      info: 0,
    };
    let issuesLimited = false;

    // data(表示用) は propertyId 単位でマージ（同一物件が複数ルールに該当しても取りこぼさない）。
    const byProperty = new Map<string, QualityIssue[]>();

    for (const { rule, count, sample } of ruleResults) {
      severityTotals[rule.severity] += count;
      if (count > QUALITY_CHECK_ISSUE_LIMIT) {
        // 全体件数が表示上限超。data は丸めるが hard fail はしない（常に 200）。
        issuesLimited = true;
      }
      for (const p of sample) {
        const issue: QualityIssue = {
          propertyId: p.id,
          address: p.address,
          severity: rule.severity,
          code: rule.code,
          message: rule.message,
        };
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
        // 全体実件数（count ベース）。表示用 issues の truncate には影響されない。
        total,
        errors: severityTotals.error,
        warnings: severityTotals.warning,
        info: severityTotals.info,
        // 全非アーカイブ物件数（問題のない物件も含む「チェック対象」総数）。
        propertiesChecked,
        // data に実際に含まれる issue 行数（サンプル件数）。truncate 時は total > issuesReturned。
        issuesReturned: issues.length,
        // いずれかのルールで全体件数 > issueLimit となり data を丸めたか（非PII・常に 200）。
        issuesLimited,
        // 1ルールあたりの表示上限（非PII）。UI が「表示は一部」を出す判断材料。
        issueLimit: QUALITY_CHECK_ISSUE_LIMIT,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
