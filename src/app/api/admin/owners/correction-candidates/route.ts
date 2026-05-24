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
  buildOwnerDuplicateCandidateKey,
  buildOwnerCorporateNumberDuplicateKey,
  buildOwnerExternalLinkKeyDuplicateKey,
} from "@/lib/owner-correction";
import { maskCorporateNumber } from "@/lib/display-level";

type RecommendedAction = "hold" | "review" | "delete_candidate" | "merge_candidate";

// Phase 2-A: 重複グループの一致経路。1 候補が複数経路で同時にヒットする場合、
// 既存挙動を優先するため name_address > corporate_number > external_link_key の順で
// 1 つだけ採用する（duplicateGroupId / duplicateGroupSize と同じグループに紐づく）。
type DuplicateMatchedBy =
  | "name_address"
  | "corporate_number"
  | "external_link_key";

type Candidate = {
  id: string;
  name: string;
  address: string | null;
  zip: string | null;
  phone: string | null;
  /**
   * Phase E: 既存 Owner.corporateNumber を display-level に従ってマスクして返す。
   * 事前確定方針:
   * - owner_corporate_number=full → 生値
   * - edit/read/masked/partial → 先頭4桁＋***
   * - hidden または列が null → null
   * 法人番号生値は AuditLog detail に絶対に入れない。
   */
  corporateNumberMasked: string | null;
  hasNote: boolean;
  hasExternalLinkKey: boolean;
  version: number;
  propertyOwnerCount: number;
  changeLogCount: number;
  importFileName: string | null;
  importRowNumber: number | null;
  blockReasons: string[];
  recommendedAction: RecommendedAction;
  types: string[];
  /**
   * duplicate グループの opaque な ID。
   *   - name_address 一致         : "dup-N"
   *   - corporate_number 一致     : "dup-cn-N"
   *   - external_link_key 一致    : "dup-elk-N"
   * グループサイズ >= 2 のグループに属する candidate のみ非 null。
   * **raw name/address/corporateNumber/externalLinkKey/normalized key を
   * 含まない**（PII / 法人番号 / 外部キー復元防止）。
   */
  duplicateGroupId: string | null;
  /**
   * duplicate グループ内の候補件数。groupId が null なら null。
   */
  duplicateGroupSize: number | null;
  /**
   * Phase 2-A: duplicate グループへ採用された経路。複数経路でヒットした
   * candidate にも 1 つだけ付与する（優先順: name_address > corporate_number
   * > external_link_key）。groupId が null なら null。
   */
  duplicateMatchedBy: DuplicateMatchedBy | null;
};

// ---------- GET /api/admin/owners/correction-candidates ----------
//
// Owner 補正候補を dry-run で返す。DB は一切変更しない。
//
// type クエリパラメータ:
//   orphan       — PropertyOwner 件数 = 0
//   address_null — address が null または空文字
//   duplicate    — normalizeName+normalizeAddress が一致する Owner が複数
//   all (default)— 上記いずれかに該当するもの全て
//
// 権限: user_management:read（管理者エリア） + owner:read（PII閲覧）の両方必須。
//   既存 /api/owners と同じ getOwnerDisplayConfig / maskValue を適用する。

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

    // PII フィールドの表示レベルを取得（/api/owners と同じ制御）
    const displayConfig = await getOwnerDisplayConfig(session.id);

    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type") ?? "all";

    // 1. 全アクティブ Owner を PropertyOwner 件数付きで取得
    // Phase E: corporateNumber も取得し、display-level に従ってマスクして返す。
    const owners = await prisma.owner.findMany({
      where: { isArchived: false },
      select: {
        id: true,
        name: true,
        address: true,
        zip: true,
        phone: true,
        note: true,
        corporateNumber: true,
        externalLinkKey: true,
        version: true,
        _count: { select: { propertyOwners: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    const ownerIds = owners.map((o) => o.id);

    // 2. ChangeLog 件数（Owner には直接リレーションなし — 別クエリで集計）
    const changeLogRows =
      ownerIds.length > 0
        ? await prisma.changeLog.findMany({
            where: { targetTable: "owners", targetId: { in: ownerIds } },
            select: { targetId: true },
          })
        : [];
    const changeLogCountMap = new Map<string, number>();
    for (const row of changeLogRows) {
      changeLogCountMap.set(
        row.targetId,
        (changeLogCountMap.get(row.targetId) ?? 0) + 1,
      );
    }

    // 3. ImportJobRow 逆引き（owner_csv のみ — createdId = Owner.id）
    const importRows =
      ownerIds.length > 0
        ? await prisma.importJobRow.findMany({
            where: {
              createdId: { in: ownerIds },
              job: { jobType: "owner_csv" },
            },
            select: {
              createdId: true,
              rowNumber: true,
              status: true,
              job: { select: { fileName: true } },
            },
            orderBy: { createdAt: "asc" },
          })
        : [];
    // 同一 Owner に複数行あれば最初の success 行を優先し、なければ最初の行を使用
    const importRowMap = new Map<
      string,
      { fileName: string; rowNumber: number; status: string }
    >();
    for (const r of importRows) {
      const existing = importRowMap.get(r.createdId!);
      if (!existing) {
        importRowMap.set(r.createdId!, {
          fileName: r.job.fileName,
          rowNumber: r.rowNumber,
          status: r.status,
        });
      } else if (existing.status !== "success" && r.status === "success") {
        // success 行があればそちらに上書き
        importRowMap.set(r.createdId!, {
          fileName: r.job.fileName,
          rowNumber: r.rowNumber,
          status: r.status,
        });
      }
    }

    // 4. 候補リスト構築
    const candidates: Candidate[] = owners.map((owner): Candidate => {
      const propertyOwnerCount = owner._count.propertyOwners;
      const changeLogCount = changeLogCountMap.get(owner.id) ?? 0;
      const importInfo = importRowMap.get(owner.id) ?? null;

      const blockReasons: string[] = [];
      if (propertyOwnerCount > 0) blockReasons.push("property_owner_exists");
      if (changeLogCount > 0) blockReasons.push("changelog_exists");
      if (owner.version > 1) blockReasons.push("version_gt_1");
      if (owner.externalLinkKey) blockReasons.push("external_link_key_exists");
      if (owner.note) blockReasons.push("note_exists");
      if (!importInfo) blockReasons.push("import_source_unknown");
      if (importInfo && importInfo.status !== "success")
        blockReasons.push("import_row_not_success");

      const isOrphan = propertyOwnerCount === 0;
      const isAddressNull =
        owner.address === null || owner.address.trim() === "";

      const types: string[] = [];
      if (isOrphan) types.push("orphan");
      if (isAddressNull) types.push("address_null");
      // duplicate は後段で付与

      const hasSafeguard = blockReasons.some((r) =>
        [
          "property_owner_exists",
          "changelog_exists",
          "version_gt_1",
          "external_link_key_exists",
          "note_exists",
        ].includes(r),
      );

      let recommendedAction: RecommendedAction;
      if (hasSafeguard) {
        recommendedAction = "hold";
      } else if (isOrphan && !isAddressNull && importInfo?.status === "success") {
        recommendedAction = "delete_candidate";
      } else {
        recommendedAction = "review";
      }

      // Phase E: corporateNumber は display-level に応じてマスクして保持。
      // 重複検出は raw name/address/zip/phone のみで行うため、ここでマスクしても影響なし。
      // 事前確定方針: full のみ生値、edit/read/masked/partial はマスク、hidden は null。
      let corporateNumberMasked: string | null = null;
      if (owner.corporateNumber != null) {
        const cnLevel = displayConfig.corporateNumber;
        if (cnLevel === "full") {
          corporateNumberMasked = owner.corporateNumber;
        } else if (cnLevel === "hidden") {
          corporateNumberMasked = null;
        } else {
          // edit / read / masked / partial → 全てマスク
          corporateNumberMasked = maskCorporateNumber(owner.corporateNumber);
        }
      }

      return {
        id: owner.id,
        name: owner.name,
        address: owner.address ?? null,
        zip: owner.zip ?? null,
        phone: owner.phone ?? null,
        corporateNumberMasked,
        hasNote: !!owner.note,
        hasExternalLinkKey: !!owner.externalLinkKey,
        version: owner.version,
        propertyOwnerCount,
        changeLogCount,
        importFileName: importInfo?.fileName ?? null,
        importRowNumber: importInfo?.rowNumber ?? null,
        duplicateGroupId: null,
        duplicateGroupSize: null,
        duplicateMatchedBy: null,
        blockReasons,
        recommendedAction,
        types,
      };
    });

    // 5. 重複検出: 3 系統で並行にグループ化する。
    //    - name_address: buildOwnerDuplicateCandidateKey（既存 / merge-preview と共有）
    //    - corporate_number: buildOwnerCorporateNumberDuplicateKey（13 桁 digits）
    //    - external_link_key: buildOwnerExternalLinkKeyDuplicateKey（trim 後非空）
    //
    //    1 owner が複数経路で同時にヒットした場合、duplicateGroupId は **1 つ**だけ
    //    保持する（型上単一フィールド）。優先順位は既存挙動を維持するため
    //    name_address > corporate_number > external_link_key。先に当たった経路で
    //    duplicateGroupId / duplicateGroupSize / duplicateMatchedBy が確定したら
    //    以降の経路では上書きしない。
    //
    //    types["duplicate"] / recommendedAction="merge_candidate" は経路に関わらず
    //    duplicate グループ（size>=2）所属で一度だけ付与する。
    const candidateById = new Map<string, Candidate>();
    for (const c of candidates) candidateById.set(c.id, c);

    // 5-a. name_address グループ
    const nameAddrGroups = new Map<string, string[]>();
    for (const c of candidates) {
      const key = buildOwnerDuplicateCandidateKey({
        name: c.name,
        address: c.address,
        zip: c.zip,
        phone: c.phone,
      });
      const arr = nameAddrGroups.get(key) ?? [];
      arr.push(c.id);
      nameAddrGroups.set(key, arr);
    }

    // 5-b. corporate_number グループ（owner の raw 値を直接参照。candidate 側の
    //      corporateNumberMasked は display-level に依存するため使わない）
    const cnGroups = new Map<string, string[]>();
    for (const o of owners) {
      const key = buildOwnerCorporateNumberDuplicateKey(o.corporateNumber);
      if (key === null) continue;
      const arr = cnGroups.get(key) ?? [];
      arr.push(o.id);
      cnGroups.set(key, arr);
    }

    // 5-c. external_link_key グループ
    const elkGroups = new Map<string, string[]>();
    for (const o of owners) {
      const key = buildOwnerExternalLinkKeyDuplicateKey(o.externalLinkKey);
      if (key === null) continue;
      const arr = elkGroups.get(key) ?? [];
      arr.push(o.id);
      elkGroups.set(key, arr);
    }

    function assignGroup(
      memberIds: string[],
      opaqueId: string,
      matchedBy: DuplicateMatchedBy,
    ) {
      const size = memberIds.length;
      for (const id of memberIds) {
        const c = candidateById.get(id);
        if (!c) continue;
        if (!c.types.includes("duplicate")) c.types.push("duplicate");
        if (
          c.recommendedAction === "delete_candidate" ||
          c.recommendedAction === "review"
        ) {
          c.recommendedAction = "merge_candidate";
        }
        // 既存挙動を優先するため、先に確定した duplicateGroupId は上書きしない。
        if (c.duplicateGroupId === null) {
          c.duplicateGroupId = opaqueId;
          c.duplicateGroupSize = size;
          c.duplicateMatchedBy = matchedBy;
        }
      }
    }

    // 5-d. opaque ID 割当（Map 挿入順で安定した連番）
    let naCounter = 0;
    for (const group of nameAddrGroups.values()) {
      if (group.length < 2) continue;
      naCounter++;
      assignGroup(group, `dup-${naCounter}`, "name_address");
    }
    let cnCounter = 0;
    for (const group of cnGroups.values()) {
      if (group.length < 2) continue;
      cnCounter++;
      assignGroup(group, `dup-cn-${cnCounter}`, "corporate_number");
    }
    let elkCounter = 0;
    for (const group of elkGroups.values()) {
      if (group.length < 2) continue;
      elkCounter++;
      assignGroup(group, `dup-elk-${elkCounter}`, "external_link_key");
    }

    // 6. type フィルタ
    let result: typeof candidates;
    if (type === "orphan") {
      result = candidates.filter((c) => c.types.includes("orphan"));
    } else if (type === "address_null") {
      result = candidates.filter((c) => c.types.includes("address_null"));
    } else if (type === "duplicate") {
      result = candidates.filter((c) => c.types.includes("duplicate"));
    } else {
      result = candidates.filter((c) => c.types.length > 0);
    }

    // 7. PII フィールドにマスキングを適用（重複検出は生値で完了済み）
    const maskedResult = result.map((c) => ({
      ...c,
      name: maskValue(c.name, displayConfig.name),
      address: maskValue(c.address, displayConfig.address),
      zip: maskValue(c.zip, displayConfig.zip),
      phone: maskValue(c.phone, displayConfig.phone),
    }));

    // Phase 2-A: duplicate 経路別件数も集計する。1 candidate は単一の
    // duplicateMatchedBy を持つので合計しても duplicateCount を超えない。
    // 件数のみで PII / 法人番号生値 / externalLinkKey 生値は一切含まない。
    const duplicateMatchedByCounts = {
      name_address: candidates.filter(
        (c) => c.duplicateMatchedBy === "name_address",
      ).length,
      corporate_number: candidates.filter(
        (c) => c.duplicateMatchedBy === "corporate_number",
      ).length,
      external_link_key: candidates.filter(
        (c) => c.duplicateMatchedBy === "external_link_key",
      ).length,
    };

    const summary = {
      orphanCount: candidates.filter((c) => c.types.includes("orphan")).length,
      addressNullCount: candidates.filter((c) =>
        c.types.includes("address_null"),
      ).length,
      duplicateCount: candidates.filter((c) => c.types.includes("duplicate"))
        .length,
      duplicateMatchedByCounts,
      allCount: candidates.filter((c) => c.types.length > 0).length,
    };

    // 8. 監査ログ（PII は含めない — type・件数・内訳のみ）
    await writeAuditLog({
      userId: session.id,
      action: "owner_correction_candidates_list",
      detail: {
        type,
        resultCount: maskedResult.length,
        summary,
      },
    });

    return apiResponse({
      total: maskedResult.length,
      type,
      candidates: maskedResult,
      summary,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
