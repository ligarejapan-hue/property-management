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
  isOwnerAddressEffectivelyEmpty,
} from "@/lib/owner-correction";
import { maskCorporateNumber } from "@/lib/display-level";
import { pickSinglePropertyId } from "@/lib/owner-property-link";
import { propertyVisibilityScopeWhere } from "@/lib/property-list-query";

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
  /**
   * 紐づき物件がちょうど1件のときの物件ID。0件・2件以上は null。
   * 画面はこの値をリンク先の判定(resolveOwnerPropertyLink)に渡すだけで、
   * 物件の住所などの中身はここでは一切返さない。
   * Codex P1: セッションが property:read を持たない場合は常に null
   * (#139 finding)。property:read があっても、field_staff は
   * propertyVisibilityScopeWhere で担当外の物件を除外した後の値。
   */
  singlePropertyId: string | null;
  /**
   * P2 (#139 二次回帰): このビューアが実際にこの所有者の紐づき物件を
   * 1件以上見られるか(スコープ済み propertyOwners 配列が非空かどうか)。
   * propertyOwnerCount(_count)は可視範囲スコープ対象外のため、
   * 「件数は正だがスコープ内の紐づきが0件」というケース(field_staff が
   * 担当外の物件だけを持つ owner を見たとき)がありうる。このケースでは
   * resolveOwnerPropertyLink がリンク先を作れず、件数だけリンクになっている
   * 死んだリンク(/properties?ownerId=... が必ず空リストになる)を出していた
   * ([#139] fallout の再発)。boolean のみで物件ID/件数などの中身は含まない。
   */
  hasReachableProperty: boolean;
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
  /**
   * Phase 2-B: address が DB 上 null ではないが trim 後に空（半角/全角空白・タブ等のみ）
   * の場合に true。既存 types/address_null は維持しつつ「実質空欄」を区別したい
   * UI 用フラグ。PII は含まない (boolean のみ)。
   */
  addressIsWhitespaceOnly: boolean;
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
//   singlePropertyId は上記2つとは別に property:read も必要（#139 finding）。
//   無ければ endpoint 自体は 403 にせず、その項目だけ null にする。

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
    const displayConfig = await getOwnerDisplayConfig(session.id, perms);

    // Codex P1: singlePropertyId は物件の存在(UUID)と1件確定であることを外に出す。
    // property:read を持たないセッションには渡さない(#139 finding)。
    // property list / detail API と同じ可視範囲スコープを nested selection にも
    // 適用し、field_staff が担当外の物件IDを受け取らないようにする。
    const hasPropertyRead = hasPermission(perms, "property", "read");
    const propertyVisibilityScope = propertyVisibilityScopeWhere(session);

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
        // propertyOwnerCount(_count)は既存の孤児/重複判定が依存するため
        // 可視範囲スコープを適用しない(変更しない・スコープ対象は下の
        // propertyOwners selection のみ)。
        _count: { select: { propertyOwners: true } },
        // 紐づきがちょうど1件のときだけ物件IDを返すため、2件だけ読む。
        // (1件か2件以上かの判別にはこれで足りる。全件読むと重い)
        // where は property list/detail API と同じ propertyVisibilityScopeWhere。
        // field_staff は担当外の物件を持つ行を読まない(=そもそも候補に出せない)。
        propertyOwners: {
          select: { propertyId: true },
          take: 2,
          ...(propertyVisibilityScope
            ? { where: { property: propertyVisibilityScope } }
            : {}),
        },
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
      // property:read が無いセッションには渡さない(#139 finding)。
      // propertyOwnerCount(_count)は上記の通りスコープ対象外・変更しない。
      const singlePropertyId = hasPropertyRead
        ? pickSinglePropertyId(owner.propertyOwners)
        : null;
      // P2 (#139 二次回帰): スコープ済み配列(owner.propertyOwners)が
      // 非空かどうかだけを見る。propertyOwnerCount(_count)は使わない
      // ——不一致(件数は正だがスコープ内は0件)こそがこの flag で拾いたい
      // ケースそのもの。
      // ⚠property:read が無いセッションには false を返す(singlePropertyId と同じゲート)。
      // これが無いと「この所有者の物件のうち少なくとも1件はあなたの担当」という
      // 1bit が、物件を読めない相手に渡る。この窓口から出す物件由来の値は全て
      // hasPropertyRead を通す。
      const hasReachableProperty = hasPropertyRead
        ? owner.propertyOwners.length > 0
        : false;
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
      // Phase 2-B: 全角空白 / タブ等のみの address も「実質空欄」として扱う。
      // 既存 address_null 判定の意図と整合（trim 後 0 文字 = 空欄）。
      const isAddressNull = isOwnerAddressEffectivelyEmpty(owner.address);
      // address は DB 上は非 null だが trim 後 0 文字、というケースのみ true。
      // UI バッジで「空白のみ」と「null」を区別するために返す。
      const addressIsWhitespaceOnly =
        owner.address !== null && owner.address.trim() === "";

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
        singlePropertyId,
        hasReachableProperty,
        changeLogCount,
        importFileName: importInfo?.fileName ?? null,
        importRowNumber: importInfo?.rowNumber ?? null,
        duplicateGroupId: null,
        duplicateGroupSize: null,
        duplicateMatchedBy: null,
        addressIsWhitespaceOnly,
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
    //    types["duplicate"] は経路に関わらず実際に group に組まれた候補へ一度だけ
    //    付与する。一方 recommendedAction="merge_candidate" への昇格は
    //    **name_address 限定**（merge-preview が name+address 検証しか持たないため、
    //    corporate_number / external_link_key 由来候補を merge_candidate にすると
    //    UI 上 merge できそうに見えて preview/execute では block されてしまう）。
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
    //
    // Codex P1: 法人番号の重複検出は、displayConfig.corporateNumber === "full"
    // のオペレーターのみに開放する。masked / hidden / partial / read / edit などの
    // 制限付きユーザーでも duplicateMatchedBy="corporate_number" や opaque
    // ID dup-cn-* / duplicateMatchedByCounts.corporate_number > 0 が見えると
    // 「同一法人番号を持つ Owner が存在する」という raw equality を推測でき、
    // 法人番号の表示権限を迂回する情報漏えいになる。安全側でグループ化自体を
    // スキップする（=候補も件数も外に出ない）。
    const corporateNumberDuplicateAvailable =
      displayConfig.corporateNumber === "full";
    const cnGroups = new Map<string, string[]>();
    if (corporateNumberDuplicateAvailable) {
      for (const o of owners) {
        const key = buildOwnerCorporateNumberDuplicateKey(o.corporateNumber);
        if (key === null) continue;
        const arr = cnGroups.get(key) ?? [];
        arr.push(o.id);
        cnGroups.set(key, arr);
      }
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

    // Codex P1: グループ割当は atomic に行う。
    //
    // 旧実装は memberIds の全件サイズを duplicateGroupSize にしていたため、
    // 低優先グループのメンバーの一部が既に高優先グループへ割り当て済みの場合、
    //   - 「未割当の 1 人だけ」に dup-cn-N / size=2 を付けてしまう
    //   - その 1 人と同じ groupId を持つ仲間が存在せず、UI 側の
    //     `arr.length >= 2` で落ちて duplicate サマリーから消える
    // という不整合（孤立 group）が発生していた。
    //
    // 修正:
    //   1. 既に割り当て済み（duplicateGroupId !== null）のメンバーは触らない
    //   2. 未割当メンバーだけで実グループを組む
    //   3. 未割当が < 2 ならグループ自体を作らない
    //      （types["duplicate"] / merge_candidate も付与しない）
    //   4. 未割当 >= 2 のときだけ opaque ID を割り当て、size は **未割当数**
    //   5. counter は実際にグループが組まれたときのみ進めて連番の飛びを防ぐ
    function assignGroup(
      memberIds: string[],
      opaqueId: string,
      matchedBy: DuplicateMatchedBy,
    ): boolean {
      const unassigned: Candidate[] = [];
      for (const id of memberIds) {
        const c = candidateById.get(id);
        if (!c) continue;
        if (c.duplicateGroupId === null) unassigned.push(c);
      }
      // 未割当が 1 人以下なら group を作らない（孤立 group 防止）。
      if (unassigned.length < 2) return false;
      const size = unassigned.length;
      // Codex P2-round-2: merge_candidate への昇格は name_address group 限定。
      // merge-preview API は buildOwnerDuplicateCandidateKey (name+address) でしか
      // ペア検証していないため、corporate_number / external_link_key 由来の候補に
      // merge_candidate を付けると UI 上 merge できそうに見えて preview/execute で
      // name_address_normalize_mismatch によりブロックされ、operator に誤解を
      // 与える機能不整合になる。
      //
      // Codex P1 (round 3): non-name 経路 (corporate_number / external_link_key)
      // で duplicate と判定された候補は **delete_candidate を維持しない**。
      // orphan + import success + safeguards なしの owner が「未解決の重複候補」
      // のまま delete_candidate として残ると、orphan タブの archive ボタンから
      // 削除されてデータ損失する。データ損失防止を優先し、non-name duplicate は
      // 少なくとも review に落として人間の確認に回す（hold はそのまま維持）。
      const promoteToMergeCandidate = matchedBy === "name_address";
      const nonNameMatchedBy =
        matchedBy === "corporate_number" ||
        matchedBy === "external_link_key";
      const nonNameReviewReason =
        matchedBy === "corporate_number"
          ? "corporate_number_duplicate_requires_review"
          : matchedBy === "external_link_key"
            ? "external_link_key_duplicate_requires_review"
            : null;
      for (const c of unassigned) {
        if (!c.types.includes("duplicate")) c.types.push("duplicate");
        if (
          promoteToMergeCandidate &&
          (c.recommendedAction === "delete_candidate" ||
            c.recommendedAction === "review")
        ) {
          c.recommendedAction = "merge_candidate";
        } else if (nonNameMatchedBy) {
          // delete_candidate を必ず review に落とす（データ損失防止）。
          // merge_candidate は本来 non-name で付かないが防御的に review へ。
          // hold / review はそのまま維持（hold は safeguards 由来で重要、
          // review は既にデフォルト確認状態）。
          if (
            c.recommendedAction === "delete_candidate" ||
            c.recommendedAction === "merge_candidate"
          ) {
            c.recommendedAction = "review";
          }
          // 非 PII の reason を blockReasons に追加（重複出さない）。
          if (
            nonNameReviewReason &&
            !c.blockReasons.includes(nonNameReviewReason)
          ) {
            c.blockReasons.push(nonNameReviewReason);
          }
        }
        c.duplicateGroupId = opaqueId;
        c.duplicateGroupSize = size;
        c.duplicateMatchedBy = matchedBy;
      }
      return true;
    }

    // 5-d. opaque ID 割当（Map 挿入順で安定した連番）
    //      counter は assignGroup 成功時のみ進める（飛び番号を作らない）。
    let naCounter = 0;
    for (const group of nameAddrGroups.values()) {
      if (group.length < 2) continue;
      if (assignGroup(group, `dup-${naCounter + 1}`, "name_address")) {
        naCounter++;
      }
    }
    let cnCounter = 0;
    for (const group of cnGroups.values()) {
      if (group.length < 2) continue;
      if (assignGroup(group, `dup-cn-${cnCounter + 1}`, "corporate_number")) {
        cnCounter++;
      }
    }
    let elkCounter = 0;
    for (const group of elkGroups.values()) {
      if (group.length < 2) continue;
      if (
        assignGroup(group, `dup-elk-${elkCounter + 1}`, "external_link_key")
      ) {
        elkCounter++;
      }
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
      // Codex P1: 法人番号重複検出が現セッション権限で利用可能かを示す。
      // false の場合、duplicateMatchedBy="corporate_number" の候補は API
      // レスポンスに含まれない（matchedByCounts.corporate_number=0 になる）。
      // 値自体は boolean のみで PII は含まない。UI は権限不足メッセージの
      // 表示判断に使う。
      corporateNumberDuplicateAvailable,
      // P2 (#139 fallout): singlePropertyId と同じく property:read が無い
      // セッションを示す capability flag。UI はこれを見て「物件」列の
      // リンクそのものを消す(count > 0 かつ singlePropertyId=null で
      // resolveOwnerPropertyLink が many 判定してしまい、property:read の
      // 無いユーザーに必ず 403 になる /properties?ownerId=... リンクを
      // 出していた回帰の修正)。corporateNumberDuplicateAvailable と同じ形:
      // 値は boolean のみで PII は含まない。
      propertyLinkAvailable: hasPropertyRead,
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
