// GET /api/admin/owners/text-hygiene-candidates
//
// DQ-04: 既存 Owner の自由テキスト（name / nameKana / address / note）から
// 制御文字・文字化け（C0/C1/DEL・ゼロ幅・BOM・bidi・U+FFFD・mojibake）を含む値を
// dry-run で検出して返す。DB は一切変更しない。
//
// 既存 name-quality-candidates / contact-quality-candidates と同型。DQ-04 固有の差分:
// - **複数フィールド**を走査するため、row は owner 単位で per-field の reports 配列
//   （fields[]）を持つ。issue コードがフィールド非依存（control_chars 等）ゆえ、contact の
//   ような field 接頭辞では区別できないため、フィールドを明示する構造にする。
// - 不可視制御文字の sanitize は **情報無損失**（設計 §6.3: 「DQ-04 の不可視制御文字のみ
//   自動書換許容」）ゆえ、name/contact のような取込元 provenance / changelog safeguard は
//   持たない。recommendedAction は **review / sanitize_candidate の 2 値**（hold なし）。
// - **note は audit-only**（絵文字 ZWJ 保護・設計 §DQ-04 §4）＝sanitize_candidate にせず
//   常に review。fix（text-fix route）の対象フィールドにも含めない。
// - 権限: user_management:read AND owner:read。各フィールドは **生値可視（full/edit/read）
//   のときのみ分類**（不可視フィールドは隠し PII の品質を type= の件数差から推測させない
//   ＝DQ-01/02 P1 と同方針）。
// - PII は maskValue 経由。AuditLog detail は type / 件数 / summary のみ（生値非出力）。

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission, maskValue } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import {
  classifyTextHygiene,
  decideTextHygieneFix,
  emptyTextHygieneSummary,
  tallyTextHygiene,
  type TextHygieneIssueCode,
  type TextHygieneSeverity,
} from "@/lib/owner-text-hygiene";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MAX_SCAN = 10_000;

type RecommendedAction = "review" | "sanitize_candidate";

// 走査対象の自由テキストフィールド。値キー・displayConfig キーと同名で揃える。
type TextHygieneField =
  | "name"
  | "nameKana"
  | "address"
  | "currentAddress"
  | "note";

const SCANNED_FIELDS: TextHygieneField[] = [
  "name",
  "nameKana",
  "address",
  // ⚠現住所も走査する。ここに足さないと「現住所だけ文字化けが直せない」欄が残る。
  "currentAddress",
  "note",
];

/**
 * 表示レベルを引くときのキー。現住所は登記上の住所と同じ表示レベルで扱う
 * （専用の表示レベルは設けない＝設計 §5）。
 */
const DISPLAY_CONFIG_KEY: Record<
  TextHygieneField,
  "name" | "nameKana" | "address" | "note"
> = {
  name: "name",
  nameKana: "nameKana",
  address: "address",
  currentAddress: "address",
  note: "note",
};

// sanitize_candidate（自動除去推奨）にできるフィールド。note は除外（ZWJ 絵文字保護＝
// 設計 §DQ-04 §4: note は inspectText 監査のみに留める）。
const FIXABLE_FIELDS = new Set<TextHygieneField>([
  "name",
  "nameKana",
  "address",
  "currentAddress",
]);

type FilterType = "all" | TextHygieneIssueCode;

const ALL_TYPES: FilterType[] = [
  "all",
  "control_chars",
  "zero_width",
  "bidi",
  "replacement_char",
  "mojibake",
];

interface FieldHygieneReport {
  field: TextHygieneField;
  valueMasked: string | null;
  issues: TextHygieneIssueCode[];
  severity: TextHygieneSeverity | null;
  removable: boolean;
  auditOnly: boolean;
  recommendedAction: RecommendedAction;
}

interface TextHygieneRow {
  ownerId: string;
  version: number;
  fields: FieldHygieneReport[];
  detailUrl: string;
}

function parseType(input: string | null): FilterType {
  if (input && (ALL_TYPES as string[]).includes(input)) {
    return input as FilterType;
  }
  return "all";
}

function parseLimit(input: string | null): number {
  if (!input) return DEFAULT_LIMIT;
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/**
 * display-level がそのフィールドの「生値」を見せるレベルか。
 * full / edit / read のみ生値可視。partial / masked / hidden は生値非可視。
 * maskValue の挙動（read 以上は生値、それ未満はマスク/null）と一致させる。
 *
 * 不可視フィールドは classifyTextHygiene をスキップし issue/summary を一切出さない
 * （隠し PII の品質・性質を type= の件数差から推測させない＝DQ-01/02 P1 と同方針）。
 */
function isRawVisible(level: string): boolean {
  return level === "full" || level === "edit" || level === "read";
}

/**
 * owner の fieldReports を選択 type に絞る。
 * - "all": issue を持つ全フィールドを返す（DQ-04 の issue はすべて warning/error・info なし）。
 * - 個別 type: **その issue を含むフィールドだけ**を返す。owner 単位で「どれか一致」させて全
 *   フィールドを返すと、page が fields[] を行へ展開する際に選択 type と無関係なフィールド行
 *   （例: type=control_chars なのに replacement_char だけの address 行）が偽陽性として表示
 *   される（Codex P2）。per-field で絞ることで監査タブの行が必ず選択 type に一致する。
 */
function filterFieldsByType(
  fields: FieldHygieneReport[],
  filter: FilterType,
): FieldHygieneReport[] {
  if (filter === "all") return fields;
  return fields.filter((f) => f.issues.includes(filter));
}

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "user_management", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "所有者閲覧の権限がありません", "FORBIDDEN");
    }

    const displayConfig = await getOwnerDisplayConfig(session.id, perms);

    const { searchParams } = new URL(request.url);
    const type = parseType(searchParams.get("type"));
    const limit = parseLimit(searchParams.get("limit"));
    const cursor = searchParams.get("cursor");

    // active Owner を id 昇順で取得（cursor 安定性のため）。cursor は DB の
    // where:{id:{gt}} に渡し、MAX_SCAN を「1 リクエストのスキャン窓サイズ」とする
    // （name-quality-candidates と同じ DB カーソル設計＝10k 超も窓単位で到達可能）。
    const owners = await prisma.owner.findMany({
      where: {
        isArchived: false,
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: {
        id: true,
        name: true,
        nameKana: true,
        address: true,
        currentAddress: true,
        note: true,
        version: true,
      },
      orderBy: { id: "asc" },
      take: MAX_SCAN + 1,
    });

    const truncated = owners.length > MAX_SCAN;
    const scanned = truncated ? owners.slice(0, MAX_SCAN) : owners;

    const summary = emptyTextHygieneSummary();
    const matchedRows: TextHygieneRow[] = [];

    for (const owner of scanned) {
      const fieldValues: Record<TextHygieneField, string | null> = {
        name: owner.name,
        nameKana: owner.nameKana,
        address: owner.address,
        currentAddress: owner.currentAddress,
        note: owner.note,
      };

      const fieldReports: FieldHygieneReport[] = [];
      for (const field of SCANNED_FIELDS) {
        const level = displayConfig[DISPLAY_CONFIG_KEY[field]];
        if (!isRawVisible(level)) continue; // 不可視フィールドは分類しない（オラクル防止）

        const value = fieldValues[field];
        const result = classifyTextHygiene(value);
        tallyTextHygiene(summary, result); // summary はスキャン窓全体（フィルタ非依存）
        if (result.issues.length === 0) continue;

        // recommendedAction: 除去可（removable のみ・sanitize で値が変わる）かつ
        // fixable フィールドなら sanitize_candidate。U+FFFD/mojibake/would_be_empty や
        // note は review（人手確認＝監査のみ）。情報無損失ゆえ provenance gate は持たない。
        const recommendedAction: RecommendedAction =
          FIXABLE_FIELDS.has(field) &&
          decideTextHygieneFix(value).action === "sanitize"
            ? "sanitize_candidate"
            : "review";

        fieldReports.push({
          field,
          valueMasked: maskValue(value, level),
          issues: result.issues,
          severity: result.severity,
          removable: result.removable,
          auditOnly: result.auditOnly,
          recommendedAction,
        });
      }

      // type フィルタは per-field で適用する（選択 type を含むフィールド行のみ表示）。
      const displayFields = filterFieldsByType(fieldReports, type);
      if (displayFields.length === 0) continue;

      matchedRows.push({
        ownerId: owner.id,
        version: owner.version,
        fields: displayFields,
        detailUrl: `/admin/owners/${owner.id}`,
      });
    }

    // ページング（cursor は DB の where:{id:{gt}} で適用済み。matchedRows は
    // このスキャン窓内の id 昇順マッチ）。name-quality-candidates と同じ前進ロジック。
    const page = matchedRows.slice(0, limit);
    const hasMoreInWindow = matchedRows.length > page.length;
    const hasNextPage = hasMoreInWindow || truncated;

    let nextCursor: string | null = null;
    if (hasMoreInWindow && page.length > 0) {
      nextCursor = page[page.length - 1].ownerId;
    } else if (hasNextPage && scanned.length > 0) {
      // 窓内マッチを使い切ったが窓が truncated → 窓末尾まで前進（取りこぼし防止）。
      nextCursor = scanned[scanned.length - 1].id;
    }

    await writeAuditLog({
      userId: session.id,
      action: "owner_text_hygiene_candidates_list",
      detail: {
        type,
        resultCount: page.length,
        summary,
        hasNextPage,
        truncated,
      },
    });

    return apiResponse({
      type,
      candidates: page,
      summary,
      hasNextPage,
      nextCursor,
      truncated,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
