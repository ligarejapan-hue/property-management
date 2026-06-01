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
// 落とし込んで「その問題を持つ物件だけ」を DB 側で絞り込んで取得する。
//  - 全非アーカイブ件数は count で取得し summary.propertiesChecked に返す。
//  - 1ルールあたりの列挙件数は QUALITY_CHECK_ISSUE_LIMIT を上限とし、超過時は当該ルールの
//    リストを丸めて summary.issuesLimited=true を立てる（hard fail / 409 はしない・常に 200）。
//  - 取得列は id / address のみ。所有者は relation filter のみで Owner PII 列は取得しない。

// 1ルールあたりに列挙する問題物件数の上限（issue リスト肥大化の防止。スキャン上限ではない）。
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

    // 全非アーカイブ件数（count）と、各ルールに該当する問題物件（id/address のみ）を並列取得。
    const [propertiesChecked, ruleMatches] = await Promise.all([
      prisma.property.count({ where: NOT_ARCHIVED }),
      Promise.all(
        QUALITY_RULES.map((rule) =>
          prisma.property.findMany({
            where: { ...NOT_ARCHIVED, ...rule.where },
            select: { id: true, address: true },
            take: QUALITY_CHECK_ISSUE_LIMIT + 1,
          }),
        ),
      ),
    ]);

    // propertyId 単位で issue をマージ（同一物件が複数ルールに該当しても取りこぼさない）。
    const byProperty = new Map<string, QualityIssue[]>();
    let issuesLimited = false;

    QUALITY_RULES.forEach((rule, i) => {
      const matched = ruleMatches[i];
      if (matched.length > QUALITY_CHECK_ISSUE_LIMIT) {
        // 当該ルールの該当件数が上限超。リストは丸めるが hard fail はしない（常に 200）。
        issuesLimited = true;
      }
      const rows = matched.slice(0, QUALITY_CHECK_ISSUE_LIMIT);
      for (const p of rows) {
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
    });

    // フラットな issue 配列に展開し、error > warning > info の順に並べる（従来レスポンス互換）。
    const severityOrder = { error: 0, warning: 1, info: 2 };
    const issues: QualityIssue[] = [];
    for (const list of byProperty.values()) {
      for (const issue of list) issues.push(issue);
    }
    issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    return apiResponse({
      data: issues,
      summary: {
        total: issues.length,
        errors: issues.filter((i) => i.severity === "error").length,
        warnings: issues.filter((i) => i.severity === "warning").length,
        info: issues.filter((i) => i.severity === "info").length,
        // 全非アーカイブ物件数（count）。問題のない物件も含む「チェック対象」総数。
        propertiesChecked,
        // いずれかのルールの issue リストが上限で丸められたか（非PII）。
        // スキャン不完全 / hard fail ではなく、列挙件数の上限到達のみを示す。常に 200。
        issuesLimited,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
