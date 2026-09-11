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

// Phase 2-A: 驥崎､・げ繝ｫ繝ｼ繝励・荳閾ｴ邨瑚ｷｯ縲・ 蛟呵｣懊′隍・焚邨瑚ｷｯ縺ｧ蜷梧凾縺ｫ繝偵ャ繝医☆繧句ｴ蜷医・
// 譌｢蟄俶嫌蜍輔ｒ蜆ｪ蜈医☆繧九◆繧・name_address > corporate_number > external_link_key 縺ｮ鬆・〒
// 1 縺､縺縺第治逕ｨ縺吶ｋ・・uplicateGroupId / duplicateGroupSize 縺ｨ蜷後§繧ｰ繝ｫ繝ｼ繝励↓邏舌▼縺擾ｼ峨・
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
   * Phase E: 譌｢蟄・Owner.corporateNumber 繧・display-level 縺ｫ蠕薙▲縺ｦ繝槭せ繧ｯ縺励※霑斐☆縲・
   * 莠句燕遒ｺ螳壽婿驥・
   * - owner_corporate_number=full 竊・逕溷､
   * - edit/read/masked/partial 竊・蜈磯ｭ4譯・ｼ・**
   * - hidden 縺ｾ縺溘・蛻励′ null 竊・null
   * 豕穂ｺｺ逡ｪ蜿ｷ逕溷､縺ｯ AuditLog detail 縺ｫ邨ｶ蟇ｾ縺ｫ蜈･繧後↑縺・・
   */
  corporateNumberMasked: string | null;
  hasNote: boolean;
  hasExternalLinkKey: boolean;
  version: number;
  propertyOwnerCount: number;
  /**
   * 邏舌▼縺咲黄莉ｶ縺後■繧・≧縺ｩ1莉ｶ縺ｮ縺ｨ縺阪・迚ｩ莉ｶID縲・莉ｶ繝ｻ2莉ｶ莉･荳翫・ null縲・
   * 逕ｻ髱｢縺ｯ縺薙・蛟､繧偵Μ繝ｳ繧ｯ蜈医・蛻､螳・resolveOwnerPropertyLink)縺ｫ貂｡縺吶□縺代〒縲・
   * 迚ｩ莉ｶ縺ｮ菴乗園縺ｪ縺ｩ縺ｮ荳ｭ霄ｫ縺ｯ縺薙％縺ｧ縺ｯ荳蛻・ｿ斐＆縺ｪ縺・・
   * Codex P1: 繧ｻ繝・す繝ｧ繝ｳ縺・property:read 繧呈戟縺溘↑縺・ｴ蜷医・蟶ｸ縺ｫ null
   * (#139 finding)縲Ｑroperty:read 縺後≠縺｣縺ｦ繧ゅ’ield_staff 縺ｯ
   * propertyVisibilityScopeWhere 縺ｧ諡・ｽ灘､悶・迚ｩ莉ｶ繧帝勁螟悶＠縺溷ｾ後・蛟､縲・
   */
  singlePropertyId: string | null;
  /**
   * P2 (#139 莠梧ｬ｡蝗槫ｸｰ): 縺薙・繝薙Η繝ｼ繧｢縺悟ｮ滄圀縺ｫ縺薙・謇譛芽・・邏舌▼縺咲黄莉ｶ繧・
   * 1莉ｶ莉･荳願ｦ九ｉ繧後ｋ縺・繧ｹ繧ｳ繝ｼ繝玲ｸ医∩ propertyOwners 驟榊・縺碁撼遨ｺ縺九←縺・°)縲・
   * propertyOwnerCount(_count)縺ｯ蜿ｯ隕也ｯ・峇繧ｹ繧ｳ繝ｼ繝怜ｯｾ雎｡螟悶・縺溘ａ縲・
   * 縲御ｻｶ謨ｰ縺ｯ豁｣縺縺後せ繧ｳ繝ｼ繝怜・縺ｮ邏舌▼縺阪′0莉ｶ縲阪→縺・≧繧ｱ繝ｼ繧ｹ(field_staff 縺・
   * 諡・ｽ灘､悶・迚ｩ莉ｶ縺縺代ｒ謖√▽ owner 繧定ｦ九◆縺ｨ縺・縺後≠繧翫≧繧九ゅ％縺ｮ繧ｱ繝ｼ繧ｹ縺ｧ縺ｯ
   * resolveOwnerPropertyLink 縺後Μ繝ｳ繧ｯ蜈医ｒ菴懊ｌ縺壹∽ｻｶ謨ｰ縺縺代Μ繝ｳ繧ｯ縺ｫ縺ｪ縺｣縺ｦ縺・ｋ
   * 豁ｻ繧薙□繝ｪ繝ｳ繧ｯ(/properties?ownerId=... 縺悟ｿ・★遨ｺ繝ｪ繧ｹ繝医↓縺ｪ繧・繧貞・縺励※縺・◆
   * ([#139] fallout 縺ｮ蜀咲匱)縲Ｃoolean 縺ｮ縺ｿ縺ｧ迚ｩ莉ｶID/莉ｶ謨ｰ縺ｪ縺ｩ縺ｮ荳ｭ霄ｫ縺ｯ蜷ｫ縺ｾ縺ｪ縺・・
   */
  hasReachableProperty: boolean;
  changeLogCount: number;
  importFileName: string | null;
  importRowNumber: number | null;
  blockReasons: string[];
  recommendedAction: RecommendedAction;
  types: string[];
  /**
   * duplicate 繧ｰ繝ｫ繝ｼ繝励・ opaque 縺ｪ ID縲・
   *   - name_address 荳閾ｴ         : "dup-N"
   *   - corporate_number 荳閾ｴ     : "dup-cn-N"
   *   - external_link_key 荳閾ｴ    : "dup-elk-N"
   * 繧ｰ繝ｫ繝ｼ繝励し繧､繧ｺ >= 2 縺ｮ繧ｰ繝ｫ繝ｼ繝励↓螻槭☆繧・candidate 縺ｮ縺ｿ髱・null縲・
   * **raw name/address/corporateNumber/externalLinkKey/normalized key 繧・
   * 蜷ｫ縺ｾ縺ｪ縺・*・・II / 豕穂ｺｺ逡ｪ蜿ｷ / 螟夜Κ繧ｭ繝ｼ蠕ｩ蜈・亟豁｢・峨・
   */
  duplicateGroupId: string | null;
  /**
   * duplicate 繧ｰ繝ｫ繝ｼ繝怜・縺ｮ蛟呵｣應ｻｶ謨ｰ縲ＨroupId 縺・null 縺ｪ繧・null縲・
   */
  duplicateGroupSize: number | null;
  /**
   * Phase 2-A: duplicate 繧ｰ繝ｫ繝ｼ繝励∈謗｡逕ｨ縺輔ｌ縺溽ｵ瑚ｷｯ縲り､・焚邨瑚ｷｯ縺ｧ繝偵ャ繝医＠縺・
   * candidate 縺ｫ繧・1 縺､縺縺台ｻ倅ｸ弱☆繧具ｼ亥━蜈磯・ name_address > corporate_number
   * > external_link_key・峨ＨroupId 縺・null 縺ｪ繧・null縲・
   */
  duplicateMatchedBy: DuplicateMatchedBy | null;
  /**
   * Phase 2-B: address 縺・DB 荳・null 縺ｧ縺ｯ縺ｪ縺・′ trim 蠕後↓遨ｺ・亥濠隗・蜈ｨ隗堤ｩｺ逋ｽ繝ｻ繧ｿ繝也ｭ峨・縺ｿ・・
   * 縺ｮ蝣ｴ蜷医↓ true縲よ里蟄・types/address_null 縺ｯ邯ｭ謖√＠縺､縺､縲悟ｮ溯ｳｪ遨ｺ谺・阪ｒ蛹ｺ蛻･縺励◆縺・
   * UI 逕ｨ繝輔Λ繧ｰ縲１II 縺ｯ蜷ｫ縺ｾ縺ｪ縺・(boolean 縺ｮ縺ｿ)縲・
   */
  addressIsWhitespaceOnly: boolean;
};

// ---------- GET /api/admin/owners/correction-candidates ----------
//
// Owner 陬懈ｭ｣蛟呵｣懊ｒ dry-run 縺ｧ霑斐☆縲・B 縺ｯ荳蛻・､画峩縺励↑縺・・
//
// type 繧ｯ繧ｨ繝ｪ繝代Λ繝｡繝ｼ繧ｿ:
//   orphan       窶・PropertyOwner 莉ｶ謨ｰ = 0
//   address_null 窶・address 縺・null 縺ｾ縺溘・遨ｺ譁・ｭ・
//   duplicate    窶・normalizeName+normalizeAddress 縺御ｸ閾ｴ縺吶ｋ Owner 縺瑚､・焚
//   all (default)窶・荳願ｨ倥＞縺壹ｌ縺九↓隧ｲ蠖薙☆繧九ｂ縺ｮ蜈ｨ縺ｦ
//
// 讓ｩ髯・ user_management:read・育ｮ｡逅・・お繝ｪ繧｢・・+ owner:read・・II髢ｲ隕ｧ・峨・荳｡譁ｹ蠢・医・
//   譌｢蟄・/api/owners 縺ｨ蜷後§ getOwnerDisplayConfig / maskValue 繧帝←逕ｨ縺吶ｋ縲・
//   singlePropertyId 縺ｯ荳願ｨ・縺､縺ｨ縺ｯ蛻･縺ｫ property:read 繧ょｿ・ｦ・ｼ・139 finding・峨・
//   辟｡縺代ｌ縺ｰ endpoint 閾ｪ菴薙・ 403 縺ｫ縺帙★縲√◎縺ｮ鬆・岼縺縺・null 縺ｫ縺吶ｋ縲・

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "user_management", "read")) {
      throw new ApiError(403, "讓ｩ髯舌′縺ゅｊ縺ｾ縺帙ｓ", "FORBIDDEN");
    }
    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "謇譛芽・夢隕ｧ縺ｮ讓ｩ髯舌′縺ゅｊ縺ｾ縺帙ｓ", "FORBIDDEN");
    }

    // PII 繝輔ぅ繝ｼ繝ｫ繝峨・陦ｨ遉ｺ繝ｬ繝吶Ν繧貞叙蠕暦ｼ・api/owners 縺ｨ蜷後§蛻ｶ蠕｡・・
    const displayConfig = await getOwnerDisplayConfig(session.id, perms);

    // Codex P1: singlePropertyId 縺ｯ迚ｩ莉ｶ縺ｮ蟄伜惠(UUID)縺ｨ1莉ｶ遒ｺ螳壹〒縺ゅｋ縺薙→繧貞､悶↓蜃ｺ縺吶・
    // property:read 繧呈戟縺溘↑縺・そ繝・す繝ｧ繝ｳ縺ｫ縺ｯ貂｡縺輔↑縺・#139 finding)縲・
    // property list / detail API 縺ｨ蜷後§蜿ｯ隕也ｯ・峇繧ｹ繧ｳ繝ｼ繝励ｒ nested selection 縺ｫ繧・
    // 驕ｩ逕ｨ縺励’ield_staff 縺梧球蠖灘､悶・迚ｩ莉ｶID繧貞女縺大叙繧峨↑縺・ｈ縺・↓縺吶ｋ縲・
    const hasPropertyRead = hasPermission(perms, "property", "read");
    const propertyVisibilityScope = propertyVisibilityScopeWhere(session);

    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type") ?? "all";

    // 1. 蜈ｨ繧｢繧ｯ繝・ぅ繝・Owner 繧・PropertyOwner 莉ｶ謨ｰ莉倥″縺ｧ蜿門ｾ・
    // Phase E: corporateNumber 繧ょ叙蠕励＠縲‥isplay-level 縺ｫ蠕薙▲縺ｦ繝槭せ繧ｯ縺励※霑斐☆縲・
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
        // propertyOwnerCount(_count)縺ｯ譌｢蟄倥・蟄､蜈・驥崎､・愛螳壹′萓晏ｭ倥☆繧九◆繧・
        // 蜿ｯ隕也ｯ・峇繧ｹ繧ｳ繝ｼ繝励ｒ驕ｩ逕ｨ縺励↑縺・螟画峩縺励↑縺・・繧ｹ繧ｳ繝ｼ繝怜ｯｾ雎｡縺ｯ荳九・
        // propertyOwners selection 縺ｮ縺ｿ)縲・
        _count: { select: { propertyOwners: true } },
        // 邏舌▼縺阪′縺｡繧・≧縺ｩ1莉ｶ縺ｮ縺ｨ縺阪□縺醍黄莉ｶID繧定ｿ斐☆縺溘ａ縲・莉ｶ縺縺題ｪｭ繧縲・
        // (1莉ｶ縺・莉ｶ莉･荳翫°縺ｮ蛻､蛻･縺ｫ縺ｯ縺薙ｌ縺ｧ雜ｳ繧翫ｋ縲ょ・莉ｶ隱ｭ繧縺ｨ驥阪＞)
        // where 縺ｯ property list/detail API 縺ｨ蜷後§ propertyVisibilityScopeWhere縲・
        // field_staff 縺ｯ諡・ｽ灘､悶・迚ｩ莉ｶ繧呈戟縺､陦後ｒ隱ｭ縺ｾ縺ｪ縺・=縺昴ｂ縺昴ｂ蛟呵｣懊↓蜃ｺ縺帙↑縺・縲・
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

    // 2. ChangeLog 莉ｶ謨ｰ・・wner 縺ｫ縺ｯ逶ｴ謗･繝ｪ繝ｬ繝ｼ繧ｷ繝ｧ繝ｳ縺ｪ縺・窶・蛻･繧ｯ繧ｨ繝ｪ縺ｧ髮・ｨ茨ｼ・
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

    // 3. ImportJobRow 騾・ｼ輔″・・wner_csv 縺ｮ縺ｿ 窶・createdId = Owner.id・・
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
    // 蜷御ｸ Owner 縺ｫ隍・焚陦後≠繧後・譛蛻昴・ success 陦後ｒ蜆ｪ蜈医＠縲√↑縺代ｌ縺ｰ譛蛻昴・陦後ｒ菴ｿ逕ｨ
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
        // success 陦後′縺ゅｌ縺ｰ縺昴■繧峨↓荳頑嶌縺・
        importRowMap.set(r.createdId!, {
          fileName: r.job.fileName,
          rowNumber: r.rowNumber,
          status: r.status,
        });
      }
    }

    // 4. 蛟呵｣懊Μ繧ｹ繝域ｧ狗ｯ・
    const candidates: Candidate[] = owners.map((owner): Candidate => {
      const propertyOwnerCount = owner._count.propertyOwners;
      // property:read 縺檎┌縺・そ繝・す繝ｧ繝ｳ縺ｫ縺ｯ貂｡縺輔↑縺・#139 finding)縲・
      // propertyOwnerCount(_count)縺ｯ荳願ｨ倥・騾壹ｊ繧ｹ繧ｳ繝ｼ繝怜ｯｾ雎｡螟悶・螟画峩縺励↑縺・・
      const singlePropertyId = hasPropertyRead
        ? pickSinglePropertyId(owner.propertyOwners)
        : null;
      // P2 (#139 莠梧ｬ｡蝗槫ｸｰ): 繧ｹ繧ｳ繝ｼ繝玲ｸ医∩驟榊・(owner.propertyOwners)縺・
      // 髱樒ｩｺ縺九←縺・°縺縺代ｒ隕九ｋ縲ＱropertyOwnerCount(_count)縺ｯ菴ｿ繧上↑縺・
      // 窶披比ｸ堺ｸ閾ｴ(莉ｶ謨ｰ縺ｯ豁｣縺縺後せ繧ｳ繝ｼ繝怜・縺ｯ0莉ｶ)縺薙◎縺後％縺ｮ flag 縺ｧ諡ｾ縺・◆縺・
      // 繧ｱ繝ｼ繧ｹ縺昴・繧ゅ・縲・
      // property:read 縺檎┌縺・そ繝・す繝ｧ繝ｳ縺ｯ縺薙・ flag 繧・false・・inglePropertyId 縺ｨ蜷後§繧ｲ繝ｼ繝茨ｼ峨・
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
      // Phase 2-B: 蜈ｨ隗堤ｩｺ逋ｽ / 繧ｿ繝也ｭ峨・縺ｿ縺ｮ address 繧ゅ悟ｮ溯ｳｪ遨ｺ谺・阪→縺励※謇ｱ縺・・
      // 譌｢蟄・address_null 蛻､螳壹・諢丞峙縺ｨ謨ｴ蜷茨ｼ・rim 蠕・0 譁・ｭ・= 遨ｺ谺・ｼ峨・
      const isAddressNull = isOwnerAddressEffectivelyEmpty(owner.address);
      // address 縺ｯ DB 荳翫・髱・null 縺縺・trim 蠕・0 譁・ｭ励√→縺・≧繧ｱ繝ｼ繧ｹ縺ｮ縺ｿ true縲・
      // UI 繝舌ャ繧ｸ縺ｧ縲檎ｩｺ逋ｽ縺ｮ縺ｿ縲阪→縲系ull縲阪ｒ蛹ｺ蛻･縺吶ｋ縺溘ａ縺ｫ霑斐☆縲・
      const addressIsWhitespaceOnly =
        owner.address !== null && owner.address.trim() === "";

      const types: string[] = [];
      if (isOrphan) types.push("orphan");
      if (isAddressNull) types.push("address_null");
      // duplicate 縺ｯ蠕梧ｮｵ縺ｧ莉倅ｸ・

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

      // Phase E: corporateNumber 縺ｯ display-level 縺ｫ蠢懊§縺ｦ繝槭せ繧ｯ縺励※菫晄戟縲・
      // 驥崎､・､懷・縺ｯ raw name/address/zip/phone 縺ｮ縺ｿ縺ｧ陦後≧縺溘ａ縲√％縺薙〒繝槭せ繧ｯ縺励※繧ょｽｱ髻ｿ縺ｪ縺励・
      // 莠句燕遒ｺ螳壽婿驥・ full 縺ｮ縺ｿ逕溷､縲‘dit/read/masked/partial 縺ｯ繝槭せ繧ｯ縲”idden 縺ｯ null縲・
      let corporateNumberMasked: string | null = null;
      if (owner.corporateNumber != null) {
        const cnLevel = displayConfig.corporateNumber;
        if (cnLevel === "full") {
          corporateNumberMasked = owner.corporateNumber;
        } else if (cnLevel === "hidden") {
          corporateNumberMasked = null;
        } else {
          // edit / read / masked / partial 竊・蜈ｨ縺ｦ繝槭せ繧ｯ
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

    // 5. 驥崎､・､懷・: 3 邉ｻ邨ｱ縺ｧ荳ｦ陦後↓繧ｰ繝ｫ繝ｼ繝怜喧縺吶ｋ縲・
    //    - name_address: buildOwnerDuplicateCandidateKey・域里蟄・/ merge-preview 縺ｨ蜈ｱ譛会ｼ・
    //    - corporate_number: buildOwnerCorporateNumberDuplicateKey・・3 譯・digits・・
    //    - external_link_key: buildOwnerExternalLinkKeyDuplicateKey・・rim 蠕碁撼遨ｺ・・
    //
    //    1 owner 縺瑚､・焚邨瑚ｷｯ縺ｧ蜷梧凾縺ｫ繝偵ャ繝医＠縺溷ｴ蜷医‥uplicateGroupId 縺ｯ **1 縺､**縺縺・
    //    菫晄戟縺吶ｋ・亥梛荳雁腰荳繝輔ぅ繝ｼ繝ｫ繝会ｼ峨ょ━蜈磯・ｽ阪・譌｢蟄俶嫌蜍輔ｒ邯ｭ謖√☆繧九◆繧・
    //    name_address > corporate_number > external_link_key縲ょ・縺ｫ蠖薙◆縺｣縺溽ｵ瑚ｷｯ縺ｧ
    //    duplicateGroupId / duplicateGroupSize / duplicateMatchedBy 縺檎｢ｺ螳壹＠縺溘ｉ
    //    莉･髯阪・邨瑚ｷｯ縺ｧ縺ｯ荳頑嶌縺阪＠縺ｪ縺・・
    //
    //    types["duplicate"] 縺ｯ邨瑚ｷｯ縺ｫ髢｢繧上ｉ縺壼ｮ滄圀縺ｫ group 縺ｫ邨・∪繧後◆蛟呵｣懊∈荳蠎ｦ縺縺・
    //    莉倅ｸ弱☆繧九ゆｸ譁ｹ recommendedAction="merge_candidate" 縺ｸ縺ｮ譏・ｼ縺ｯ
    //    **name_address 髯仙ｮ・*・・erge-preview 縺・name+address 讀懆ｨｼ縺励°謖√◆縺ｪ縺・◆繧√・
    //    corporate_number / external_link_key 逕ｱ譚･蛟呵｣懊ｒ merge_candidate 縺ｫ縺吶ｋ縺ｨ
    //    UI 荳・merge 縺ｧ縺阪◎縺・↓隕九∴縺ｦ preview/execute 縺ｧ縺ｯ block 縺輔ｌ縺ｦ縺励∪縺・ｼ峨・
    const candidateById = new Map<string, Candidate>();
    for (const c of candidates) candidateById.set(c.id, c);

    // 5-a. name_address 繧ｰ繝ｫ繝ｼ繝・
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

    // 5-b. corporate_number 繧ｰ繝ｫ繝ｼ繝暦ｼ・wner 縺ｮ raw 蛟､繧堤峩謗･蜿ら・縲Ｄandidate 蛛ｴ縺ｮ
    //      corporateNumberMasked 縺ｯ display-level 縺ｫ萓晏ｭ倥☆繧九◆繧∽ｽｿ繧上↑縺・ｼ・
    //
    // Codex P1: 豕穂ｺｺ逡ｪ蜿ｷ縺ｮ驥崎､・､懷・縺ｯ縲‥isplayConfig.corporateNumber === "full"
    // 縺ｮ繧ｪ繝壹Ξ繝ｼ繧ｿ繝ｼ縺ｮ縺ｿ縺ｫ髢区叛縺吶ｋ縲Ｎasked / hidden / partial / read / edit 縺ｪ縺ｩ縺ｮ
    // 蛻ｶ髯蝉ｻ倥″繝ｦ繝ｼ繧ｶ繝ｼ縺ｧ繧・duplicateMatchedBy="corporate_number" 繧・opaque
    // ID dup-cn-* / duplicateMatchedByCounts.corporate_number > 0 縺瑚ｦ九∴繧九→
    // 縲悟酔荳豕穂ｺｺ逡ｪ蜿ｷ繧呈戟縺､ Owner 縺悟ｭ伜惠縺吶ｋ縲阪→縺・≧ raw equality 繧呈耳貂ｬ縺ｧ縺阪・
    // 豕穂ｺｺ逡ｪ蜿ｷ縺ｮ陦ｨ遉ｺ讓ｩ髯舌ｒ霑ょ屓縺吶ｋ諠・ｱ貍上∴縺・↓縺ｪ繧九ょｮ牙・蛛ｴ縺ｧ繧ｰ繝ｫ繝ｼ繝怜喧閾ｪ菴薙ｒ
    // 繧ｹ繧ｭ繝・・縺吶ｋ・・蛟呵｣懊ｂ莉ｶ謨ｰ繧ょ､悶↓蜃ｺ縺ｪ縺・ｼ峨・
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

    // 5-c. external_link_key 繧ｰ繝ｫ繝ｼ繝・
    const elkGroups = new Map<string, string[]>();
    for (const o of owners) {
      const key = buildOwnerExternalLinkKeyDuplicateKey(o.externalLinkKey);
      if (key === null) continue;
      const arr = elkGroups.get(key) ?? [];
      arr.push(o.id);
      elkGroups.set(key, arr);
    }

    // Codex P1: 繧ｰ繝ｫ繝ｼ繝怜牡蠖薙・ atomic 縺ｫ陦後≧縲・
    //
    // 譌ｧ螳溯｣・・ memberIds 縺ｮ蜈ｨ莉ｶ繧ｵ繧､繧ｺ繧・duplicateGroupSize 縺ｫ縺励※縺・◆縺溘ａ縲・
    // 菴主━蜈医げ繝ｫ繝ｼ繝励・繝｡繝ｳ繝舌・縺ｮ荳驛ｨ縺梧里縺ｫ鬮伜━蜈医げ繝ｫ繝ｼ繝励∈蜑ｲ繧雁ｽ薙※貂医∩縺ｮ蝣ｴ蜷医・
    //   - 縲梧悴蜑ｲ蠖薙・ 1 莠ｺ縺縺代阪↓ dup-cn-N / size=2 繧剃ｻ倥￠縺ｦ縺励∪縺・
    //   - 縺昴・ 1 莠ｺ縺ｨ蜷後§ groupId 繧呈戟縺､莉ｲ髢薙′蟄伜惠縺帙★縲ゞI 蛛ｴ縺ｮ
    //     `arr.length >= 2` 縺ｧ關ｽ縺｡縺ｦ duplicate 繧ｵ繝槭Μ繝ｼ縺九ｉ豸医∴繧・
    // 縺ｨ縺・≧荳肴紛蜷茨ｼ亥ｭ､遶・group・峨′逋ｺ逕溘＠縺ｦ縺・◆縲・
    //
    // 菫ｮ豁｣:
    //   1. 譌｢縺ｫ蜑ｲ繧雁ｽ薙※貂医∩・・uplicateGroupId !== null・峨・繝｡繝ｳ繝舌・縺ｯ隗ｦ繧峨↑縺・
    //   2. 譛ｪ蜑ｲ蠖薙Γ繝ｳ繝舌・縺縺代〒螳溘げ繝ｫ繝ｼ繝励ｒ邨・・
    //   3. 譛ｪ蜑ｲ蠖薙′ < 2 縺ｪ繧峨げ繝ｫ繝ｼ繝苓・菴薙ｒ菴懊ｉ縺ｪ縺・
    //      ・・ypes["duplicate"] / merge_candidate 繧ゆｻ倅ｸ弱＠縺ｪ縺・ｼ・
    //   4. 譛ｪ蜑ｲ蠖・>= 2 縺ｮ縺ｨ縺阪□縺・opaque ID 繧貞牡繧雁ｽ薙※縲《ize 縺ｯ **譛ｪ蜑ｲ蠖捺焚**
    //   5. counter 縺ｯ螳滄圀縺ｫ繧ｰ繝ｫ繝ｼ繝励′邨・∪繧後◆縺ｨ縺阪・縺ｿ騾ｲ繧√※騾｣逡ｪ縺ｮ鬟帙・繧帝亟縺・
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
      // 譛ｪ蜑ｲ蠖薙′ 1 莠ｺ莉･荳九↑繧・group 繧剃ｽ懊ｉ縺ｪ縺・ｼ亥ｭ､遶・group 髦ｲ豁｢・峨・
      if (unassigned.length < 2) return false;
      const size = unassigned.length;
      // Codex P2-round-2: merge_candidate 縺ｸ縺ｮ譏・ｼ縺ｯ name_address group 髯仙ｮ壹・
      // merge-preview API 縺ｯ buildOwnerDuplicateCandidateKey (name+address) 縺ｧ縺励°
      // 繝壹い讀懆ｨｼ縺励※縺・↑縺・◆繧√…orporate_number / external_link_key 逕ｱ譚･縺ｮ蛟呵｣懊↓
      // merge_candidate 繧剃ｻ倥￠繧九→ UI 荳・merge 縺ｧ縺阪◎縺・↓隕九∴縺ｦ preview/execute 縺ｧ
      // name_address_normalize_mismatch 縺ｫ繧医ｊ繝悶Ο繝・け縺輔ｌ縲｛perator 縺ｫ隱､隗｣繧・
      // 荳弱∴繧区ｩ溯・荳肴紛蜷医↓縺ｪ繧九・
      //
      // Codex P1 (round 3): non-name 邨瑚ｷｯ (corporate_number / external_link_key)
      // 縺ｧ duplicate 縺ｨ蛻､螳壹＆繧後◆蛟呵｣懊・ **delete_candidate 繧堤ｶｭ謖√＠縺ｪ縺・*縲・
      // orphan + import success + safeguards 縺ｪ縺励・ owner 縺後梧悴隗｣豎ｺ縺ｮ驥崎､・呵｣懊・
      // 縺ｮ縺ｾ縺ｾ delete_candidate 縺ｨ縺励※谿九ｋ縺ｨ縲｛rphan 繧ｿ繝悶・ archive 繝懊ち繝ｳ縺九ｉ
      // 蜑企勁縺輔ｌ縺ｦ繝・・繧ｿ謳榊､ｱ縺吶ｋ縲ゅョ繝ｼ繧ｿ謳榊､ｱ髦ｲ豁｢繧貞━蜈医＠縲］on-name duplicate 縺ｯ
      // 蟆代↑縺上→繧・review 縺ｫ關ｽ縺ｨ縺励※莠ｺ髢薙・遒ｺ隱阪↓蝗槭☆・・old 縺ｯ縺昴・縺ｾ縺ｾ邯ｭ謖・ｼ峨・
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
          // delete_candidate 繧貞ｿ・★ review 縺ｫ關ｽ縺ｨ縺呻ｼ医ョ繝ｼ繧ｿ謳榊､ｱ髦ｲ豁｢・峨・
          // merge_candidate 縺ｯ譛ｬ譚･ non-name 縺ｧ莉倥°縺ｪ縺・′髦ｲ蠕｡逧・↓ review 縺ｸ縲・
          // hold / review 縺ｯ縺昴・縺ｾ縺ｾ邯ｭ謖・ｼ・old 縺ｯ safeguards 逕ｱ譚･縺ｧ驥崎ｦ√・
          // review 縺ｯ譌｢縺ｫ繝・ヵ繧ｩ繝ｫ繝育｢ｺ隱咲憾諷具ｼ峨・
          if (
            c.recommendedAction === "delete_candidate" ||
            c.recommendedAction === "merge_candidate"
          ) {
            c.recommendedAction = "review";
          }
          // 髱・PII 縺ｮ reason 繧・blockReasons 縺ｫ霑ｽ蜉・磯㍾隍・・縺輔↑縺・ｼ峨・
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

    // 5-d. opaque ID 蜑ｲ蠖難ｼ・ap 謖ｿ蜈･鬆・〒螳牙ｮ壹＠縺滄｣逡ｪ・・
    //      counter 縺ｯ assignGroup 謌仙粥譎ゅ・縺ｿ騾ｲ繧√ｋ・磯｣帙・逡ｪ蜿ｷ繧剃ｽ懊ｉ縺ｪ縺・ｼ峨・
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

    // 6. type 繝輔ぅ繝ｫ繧ｿ
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

    // 7. PII 繝輔ぅ繝ｼ繝ｫ繝峨↓繝槭せ繧ｭ繝ｳ繧ｰ繧帝←逕ｨ・磯㍾隍・､懷・縺ｯ逕溷､縺ｧ螳御ｺ・ｸ医∩・・
    const maskedResult = result.map((c) => ({
      ...c,
      name: maskValue(c.name, displayConfig.name),
      address: maskValue(c.address, displayConfig.address),
      zip: maskValue(c.zip, displayConfig.zip),
      phone: maskValue(c.phone, displayConfig.phone),
    }));

    // Phase 2-A: duplicate 邨瑚ｷｯ蛻･莉ｶ謨ｰ繧る寔險医☆繧九・ candidate 縺ｯ蜊倅ｸ縺ｮ
    // duplicateMatchedBy 繧呈戟縺､縺ｮ縺ｧ蜷郁ｨ医＠縺ｦ繧・duplicateCount 繧定ｶ・∴縺ｪ縺・・
    // 莉ｶ謨ｰ縺ｮ縺ｿ縺ｧ PII / 豕穂ｺｺ逡ｪ蜿ｷ逕溷､ / externalLinkKey 逕溷､縺ｯ荳蛻・性縺ｾ縺ｪ縺・・
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
      // Codex P1: 豕穂ｺｺ逡ｪ蜿ｷ驥崎､・､懷・縺檎樟繧ｻ繝・す繝ｧ繝ｳ讓ｩ髯舌〒蛻ｩ逕ｨ蜿ｯ閭ｽ縺九ｒ遉ｺ縺吶・
      // false 縺ｮ蝣ｴ蜷医‥uplicateMatchedBy="corporate_number" 縺ｮ蛟呵｣懊・ API
      // 繝ｬ繧ｹ繝昴Φ繧ｹ縺ｫ蜷ｫ縺ｾ繧後↑縺・ｼ・atchedByCounts.corporate_number=0 縺ｫ縺ｪ繧具ｼ峨・
      // 蛟､閾ｪ菴薙・ boolean 縺ｮ縺ｿ縺ｧ PII 縺ｯ蜷ｫ縺ｾ縺ｪ縺・６I 縺ｯ讓ｩ髯蝉ｸ崎ｶｳ繝｡繝・そ繝ｼ繧ｸ縺ｮ
      // 陦ｨ遉ｺ蛻､譁ｭ縺ｫ菴ｿ縺・・
      corporateNumberDuplicateAvailable,
      // P2 (#139 fallout): singlePropertyId 縺ｨ蜷後§縺・property:read 縺檎┌縺・
      // 繧ｻ繝・す繝ｧ繝ｳ繧堤､ｺ縺・capability flag縲６I 縺ｯ縺薙ｌ繧定ｦ九※縲檎黄莉ｶ縲榊・縺ｮ
      // 繝ｪ繝ｳ繧ｯ縺昴・繧ゅ・繧呈ｶ医☆(count > 0 縺九▽ singlePropertyId=null 縺ｧ
      // resolveOwnerPropertyLink 縺・many 蛻､螳壹＠縺ｦ縺励∪縺・｝roperty:read 縺ｮ
      // 辟｡縺・Θ繝ｼ繧ｶ繝ｼ縺ｫ蠢・★ 403 縺ｫ縺ｪ繧・/properties?ownerId=... 繝ｪ繝ｳ繧ｯ繧・
      // 蜃ｺ縺励※縺・◆蝗槫ｸｰ縺ｮ菫ｮ豁｣)縲ＤorporateNumberDuplicateAvailable 縺ｨ蜷後§蠖｢:
      // 蛟､縺ｯ boolean 縺ｮ縺ｿ縺ｧ PII 縺ｯ蜷ｫ縺ｾ縺ｪ縺・・
      propertyLinkAvailable: hasPropertyRead,
      allCount: candidates.filter((c) => c.types.length > 0).length,
    };

    // 8. 逶｣譟ｻ繝ｭ繧ｰ・・II 縺ｯ蜷ｫ繧√↑縺・窶・type繝ｻ莉ｶ謨ｰ繝ｻ蜀・ｨｳ縺ｮ縺ｿ・・
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
