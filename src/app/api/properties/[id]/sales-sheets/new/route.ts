import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  parseJsonBody,
  ApiError,
  handleApiError,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { createDesign } from "@/lib/sales-sheet/design-service";
import {
  buildSaleLandDocument,
  buildSaleMansionDocument,
  buildSaleHouseDocument,
  buildSaleBuildingDocument,
  toCanonicalUploadsSrc,
} from "@/lib/sales-sheet/build-document";
import { loadCompanyProfile } from "@/lib/sales-sheet/company-profile-store";
import type { SalesSheetDocument } from "@/lib/sales-sheet/document-schema";
import { salesSheetTemplateKindFor } from "@/lib/sales-sheet/template-kind";
import { isImageKeyAuthorizedForProperty } from "@/lib/sales-sheet/authorize-document-images";
import { getStorage } from "@/lib/storage";
import { writeAuditLog } from "@/lib/audit";
import { buildWriteback, labelsOf } from "@/lib/sales-sheet/property-writeback/build-writeback";
import { applyWriteback } from "@/lib/sales-sheet/property-writeback/apply-writeback";

// 作成ダイアログが収集する任意の上書き項目（システムに無い値）。種別ごとに異なる。
// [F2-A Task4] LAND_FIELDS(field-model) の手入力キー全域 + レイアウト専用(catchCopy/
// salesPoints) に対応させる総入れ替え（mansionOverridesSchema と同じ方針。旧スキーマの
// price/access/landArea/landCategory:string/transactionType/deliveryTiming/remarks の
// 固定7項目を置換）。キー名は build-document.ts の SaleLandOverrides と一致させること。
// multiselect(地目/接道方向/都市計画/用途地域/地域地区/セールスポイント)のみ string[]、他は
// string。
// `landCategory` のみ string も受理する（@codex P2）: 旧（F2 以前）の作成ダイアログは
// landCategory を単一 string で送っていたため、デプロイ直後にブラウザキャッシュが効いた
// 旧クライアントが string を POST すると schema で 400 になり得る。buildLandValues
// （build-document.ts）が string | string[] を受けて配列へ正規化する実装は元々あるため、
// schema 側を string も許容するよう緩めるだけで足りる。roadDirections/cityPlanning/
// useDistrict/areaZone は F2 で新設のキーであり旧クライアントは送らないため array のまま。
// `deliveryTiming`（旧キー名。新ダイアログは `delivery` を送る）も同じ理由で受理する
// （@codex P2）: キャッシュされた旧クライアントが `deliveryTiming` で POST すると、schema に
// 無いキーとして Zod に剥がされ builder に届かず「引渡時期」が空欄になる。buildLandValues
// は元々 `o.delivery ?? o.deliveryTiming` で fallback する実装（SaleLandOverrides の
// @deprecated 互換）なので、schema 側にも `deliveryTiming` を追加するだけで足りる。
const landOverridesSchema = z.object({
  // 価格（DB の propertyType/land は単一 enum で「売地/借地権/底地権」と1:1対応しないため
  // propertyType は常に手入力。bestUse も自動反映元なし）
  propertyType: z.string().max(50).optional(),
  bestUse: z.string().max(50).optional(),
  price: z.string().max(200).optional(),
  unitPrice: z.string().max(200).optional(),
  // 所在・交通
  access: z.string().max(500).optional(),
  // 土地
  landArea: z.string().max(200).optional(),
  areaMethod: z.string().max(50).optional(),
  landCategory: z.union([z.array(z.string().max(100)).max(20), z.string().max(100)]).optional(),
  privateRoad: z.string().max(200).optional(),
  terrain: z.string().max(50).optional(),
  setback: z.string().max(200).optional(),
  setbackUnit: z.string().max(10).optional(),
  buildCondition: z.string().max(50).optional(),
  // 法令（roadKind は自動反映専用のため override キー無し。roadWidth は auto より精度の
  // 高い値を手入力したい場合に優先される override＝builtYearMonth と同じ「override優先＋
  // auto fallback」）
  roadWidth: z.string().max(100).optional(),
  roadDirections: z.array(z.string().max(100)).max(20).optional(),
  cityPlanning: z.array(z.string().max(100)).max(20).optional(),
  landPermit: z.string().max(50).optional(),
  useDistrict: z.array(z.string().max(100)).max(20).optional(),
  areaZone: z.array(z.string().max(100)).max(20).optional(),
  legalRestriction: z.string().max(1000).optional(),
  // 設備・現況
  equipment: z.string().max(1000).optional(),
  occupancy: z.string().max(50).optional(),
  delivery: z.string().max(100).optional(),
  /** @deprecated 旧キー名。`delivery` の別名（@codex P2・cached client後方互換）。 */
  deliveryTiming: z.string().max(200).optional(),
  remarks: z.string().max(1000).optional(),
  // 会社（フッター。MANSION_FIELDS と同一のキー・選択肢のため mansionOverridesSchema の
  // 対応キーと揃える）
  transactionType: z.string().max(200).optional(),
  compensation: z.string().max(200).optional(),
  adType: z.string().max(200).optional(),
  staff: z.string().max(200).optional(),
  agent: z.string().max(200).optional(),
  specialNotes: z.string().max(1000).optional(),
  // レイアウト専用（field-model の行ではない・キャッチ帯/セールスポイント見出し）
  catchCopy: z.string().max(200).optional(),
  salesPoints: z.array(z.string().max(200)).max(20).optional(),
});
// field-model(MANSION_FIELDS) の手入力キー全域 + レイアウト専用(catchCopy/salesPoints) に
// 対応させる（[T4→T5] 総入れ替え）。キー名は build-document.ts の SaleMansionOverrides と
// 一致させること。multiselect(用途地域/セールスポイント)のみ string[]、他は string。
// `structure`（構造）は自動反映専用（building.structureType が正）で上書き機構を持たない
// ため、旧スキーマにあった stale なキーとして削除。`deliveryTiming` は builder 側のキー名
// `delivery` へ改称（field-model の "引渡時期" と一致させる）。
// F3 Task4 レビュー(R14)で追加: exclusiveArea/balconyArea/balconyDir/layout/floorNo/
// managementFee/repairFee は仕様書 §4.4 の区分の書き戻し対象。R16(a6f003b9)以降、
// buildMansionValues(build-document.ts) はこれらを「override優先・空なら物件の自動
// 反映値」で解決し、document にも反映する(常に物件の値を使う旧挙動から変更済み)。
// ここに追加した目的は2つ: (1) 図面の作成画面でこの値を手入力して上書きできるように
// すること (2) 図面作成時に物件へ書き戻す(buildWriteback)ための入力経路を用意すること。
const mansionOverridesSchema = z.object({
  // 価格・費用（DB enum と語彙が1:1対応しないため propertyType は常に手入力）
  propertyType: z.string().max(50).optional(),
  price: z.string().max(200).optional(),
  unitPrice: z.string().max(200).optional(),
  tax: z.string().max(50).optional(),
  taxAmount: z.string().max(200).optional(),
  // R16以降 document にも反映される(override優先・空なら物件の自動反映値。上記コメント参照)。
  managementFee: z.string().max(200).optional(),
  repairFee: z.string().max(200).optional(),
  // 所在・交通
  access: z.string().max(500).optional(),
  // 土地・権利
  siteArea: z.string().max(200).optional(),
  siteRightRatio: z.string().max(200).optional(),
  landRight: z.string().max(100).optional(),
  useDistrict: z.array(z.string().max(100)).max(20).optional(),
  areaMethod: z.string().max(50).optional(),
  // 建物
  // exclusiveArea/balconyArea/balconyDir/layout/floorNo も同様(上記コメント参照)。
  exclusiveArea: z.string().max(200).optional(),
  balconyArea: z.string().max(200).optional(),
  balconyDir: z.string().max(50).optional(),
  layout: z.string().max(50).optional(),
  floorNo: z.string().max(50).optional(),
  basementFloors: z.string().max(50).optional(),
  builtYearMonth: z.string().max(100).optional(),
  parking: z.string().max(100).optional(),
  parkingFee: z.string().max(200).optional(),
  // 設備・現況・管理
  equipment: z.string().max(1000).optional(),
  legalRestriction: z.string().max(1000).optional(),
  managementUnion: z.string().max(50).optional(),
  managementForm: z.string().max(50).optional(),
  managerStatus: z.string().max(50).optional(),
  developer: z.string().max(200).optional(),
  builder: z.string().max(200).optional(),
  occupancy: z.string().max(50).optional(),
  delivery: z.string().max(100).optional(),
  remarks: z.string().max(1000).optional(),
  // 会社（フッター）
  transactionType: z.string().max(200).optional(),
  compensation: z.string().max(200).optional(),
  adType: z.string().max(200).optional(),
  staff: z.string().max(200).optional(),
  agent: z.string().max(200).optional(),
  specialNotes: z.string().max(1000).optional(),
  // レイアウト専用（field-model の行ではない・キャッチ帯/セールスポイント見出し）
  catchCopy: z.string().max(200).optional(),
  salesPoints: z.array(z.string().max(200)).max(20).optional(),
});
// [F2-B Task3] HOUSE_FIELDS(field-model) の手入力キー全域 + レイアウト専用(catchCopy/
// salesPoints) に対応させる総入れ替え（landOverridesSchema と同じ方針。旧スキーマの
// price/access/landArea/buildingArea/builtYearMonth/structure/transactionType/
// deliveryTiming/remarks の固定8項目を置換）。キー名は build-document.ts の
// SaleHouseOverrides と一致させること。multiselect(地目/接道方向/都市計画/用途地域/
// 地域地区/セールスポイント)のみ string[]、他は string。旧 house スキーマには
// landCategory が無かったため、land と異なり string|string[] の後方互換ユニオンは
// 不要（配列のみ）。`deliveryTiming` は旧スキーマのキー名で、旧ダイアログが実際に
// 送信していたため後方互換として受理し続ける（builder 側で delivery ?? deliveryTiming に
// フォールバック・land の @deprecated deliveryTiming と同じ経緯・キャッシュ済み
// クライアント対応の先回り）。
const houseOverridesSchema = z.object({
  propertyType: z.string().max(50).optional(),
  // 価格
  price: z.string().max(200).optional(),
  tax: z.string().max(50).optional(),
  taxAmount: z.string().max(200).optional(),
  // 所在・交通
  access: z.string().max(500).optional(),
  // 土地
  landArea: z.string().max(200).optional(),
  areaMethod: z.string().max(50).optional(),
  landRight: z.string().max(100).optional(),
  privateRoad: z.string().max(200).optional(),
  landCategory: z.array(z.string().max(100)).max(20).optional(),
  setback: z.string().max(200).optional(),
  setbackUnit: z.string().max(10).optional(),
  terrain: z.string().max(50).optional(),
  // 建物（house は building relation を配線しないため常に手入力）
  buildingArea: z.string().max(200).optional(),
  floor1Area: z.string().max(200).optional(),
  floor2Area: z.string().max(200).optional(),
  floor3Area: z.string().max(200).optional(),
  structure: z.string().max(200).optional(),
  aboveFloors: z.string().max(50).optional(),
  basementFloors: z.string().max(50).optional(),
  parking: z.string().max(100).optional(),
  builtYearMonth: z.string().max(100).optional(),
  renovYearMonth: z.string().max(100).optional(),
  // 法令（roadKind は自動反映専用のため override キー無し。roadWidth は auto より精度の
  // 高い値を手入力したい場合に優先される override＝LAND_FIELDS と同じ「override優先＋
  // auto fallback」）
  roadWidth: z.string().max(100).optional(),
  roadDirections: z.array(z.string().max(100)).max(20).optional(),
  cityPlanning: z.array(z.string().max(100)).max(20).optional(),
  useDistrict: z.array(z.string().max(100)).max(20).optional(),
  areaZone: z.array(z.string().max(100)).max(20).optional(),
  buildingConfirm: z.string().max(50).optional(),
  rebuild: z.string().max(50).optional(),
  legalRestriction: z.string().max(1000).optional(),
  // 設備・現況
  equipment: z.string().max(1000).optional(),
  occupancy: z.string().max(50).optional(),
  delivery: z.string().max(100).optional(),
  // @deprecated 旧キー名。`delivery` の別名として後方互換のみに残す（land の
  // deliveryTiming と同じ経緯・こちらは事前対応＝旧 house ダイアログが実際に送っていた
  // キー名）。
  deliveryTiming: z.string().max(200).optional(),
  remarks: z.string().max(1000).optional(),
  // 会社（フッター。MANSION_FIELDS/LAND_FIELDS と同一のキー・選択肢のため対応キーを揃える）
  transactionType: z.string().max(200).optional(),
  compensation: z.string().max(200).optional(),
  adType: z.string().max(200).optional(),
  staff: z.string().max(200).optional(),
  agent: z.string().max(200).optional(),
  specialNotes: z.string().max(1000).optional(),
  // レイアウト専用（field-model の行ではない・キャッチ帯/セールスポイント見出し）
  catchCopy: z.string().max(200).optional(),
  salesPoints: z.array(z.string().max(200)).max(20).optional(),
});
// [F2-C Task3] 一棟(building)を BUILDING_FIELDS 駆動に総入れ替え。旧フラットスキーマの12キー
// (price/access/landArea/totalFloorArea/totalUnits/builtYearMonth/structure/grossYield/
// expectedIncome/transactionType/deliveryTiming/remarks) はキー名を保持し、キャッシュ済みの
// 旧ダイアログからの POST を弾かない/落とさない（house/land と同じ後方互換方針だが、一棟は
// 唯一まだ旧フラットダイアログが本番稼働中のため必須）。deliveryTiming は delivery の別名。
const buildingOverridesSchema = z.object({
  propertyType: z.string().max(50).optional(),
  price: z.string().max(200).optional(),
  tax: z.string().max(50).optional(),
  taxAmount: z.string().max(200).optional(),
  access: z.string().max(500).optional(),
  landArea: z.string().max(200).optional(),
  areaMethod: z.string().max(50).optional(),
  landRight: z.string().max(100).optional(),
  privateRoad: z.string().max(200).optional(),
  landCategory: z.array(z.string().max(100)).max(20).optional(),
  setback: z.string().max(200).optional(),
  setbackUnit: z.string().max(10).optional(),
  terrain: z.string().max(50).optional(),
  totalFloorArea: z.string().max(200).optional(),
  structure: z.string().max(200).optional(),
  aboveFloors: z.string().max(50).optional(),
  basementFloors: z.string().max(50).optional(),
  builtYearMonth: z.string().max(100).optional(),
  renovYearMonth: z.string().max(100).optional(),
  parking: z.string().max(100).optional(),
  totalUnits: z.string().max(50).optional(),
  grossYield: z.string().max(100).optional(),
  expectedIncome: z.string().max(200).optional(),
  roadWidth: z.string().max(100).optional(),
  roadDirections: z.array(z.string().max(100)).max(20).optional(),
  cityPlanning: z.array(z.string().max(100)).max(20).optional(),
  useDistrict: z.array(z.string().max(100)).max(20).optional(),
  areaZone: z.array(z.string().max(100)).max(20).optional(),
  buildingConfirm: z.string().max(50).optional(),
  rebuild: z.string().max(50).optional(),
  legalRestriction: z.string().max(1000).optional(),
  equipment: z.string().max(1000).optional(),
  occupancy: z.string().max(50).optional(),
  delivery: z.string().max(100).optional(),
  /** @deprecated 旧キー名。`delivery` の別名として後方互換のみに残す（本番稼働中の旧ダイアログ対応）。 */
  deliveryTiming: z.string().max(200).optional(),
  remarks: z.string().max(1000).optional(),
  transactionType: z.string().max(200).optional(),
  compensation: z.string().max(200).optional(),
  adType: z.string().max(200).optional(),
  staff: z.string().max(200).optional(),
  agent: z.string().max(200).optional(),
  specialNotes: z.string().max(1000).optional(),
  catchCopy: z.string().max(200).optional(),
  salesPoints: z.array(z.string().max(200)).max(20).optional(),
});

// POST /api/properties/[id]/sales-sheets/new
// property データから種別に応じた初期 document を生成して design を作成し { id } を返す。
// 対応する種別（土地/区分マンション/戸建/一棟マンション・アパート）以外は 422。
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "物件編集の権限がありません", "FORBIDDEN");
    }

    const property = await prisma.property.findUnique({
      where: { id },
      select: {
        id: true,
        createdBy: true,
        assignedTo: true,
        propertyType: true,
        address: true,
        zoningDistrict: true,
        buildingCoverageRatio: true,
        floorAreaRatio: true,
        roadType: true,
        roadWidth: true,
        occupancyStatus: true,
        // 区分マンション用
        roomNo: true,
        exclusiveArea: true,
        balconyArea: true,
        layoutType: true,
        floorNo: true,
        orientation: true,
        managementFee: true,
        repairReserveFee: true,
        // ⚠物件そのものに入れた物件名。建物マスタを作らずに登録した区分
        // マンションはこちらにしか名前が無い (@codex #354 P2)。
        buildingName: true,
        // [Task10 C-1] F3で足した「販売」区分の16列。1枚目の図面作成時に buildWriteback で
        // ここへ保存した値を、2枚目以降の図面作成時の既定値(手入力が無ければ使う値)として
        // 読み戻す(build-document.ts の buildLandValues/buildHouseValues/buildBuildingValues
        // に渡す・区分マンションの部屋7項目は buildMansionValues が既に読んでいる)。
        salePrice: true,
        saleTaxType: true,
        saleTaxAmount: true,
        access: true,
        landArea: true,
        landAreaMethod: true,
        totalFloorArea: true,
        builtYear: true,
        builtMonth: true,
        structureType: true,
        aboveFloors: true,
        basementFloors: true,
        parking: true,
        totalUnits: true,
        grossYield: true,
        expectedIncome: true,
        building: {
          select: {
            // ⚠id だけは「棟の行も FOR UPDATE でロックするか」の判定に使う
            // (F3 writeback)。version は**ここでは読まない**
            // (C1: ロック前の値を version 判定・差分計算に使わない。ロック後に
            // tx 内で読み直した値を使う → 下の `fresh` 参照)。builtMonth/
            // basementFloors は[Task10 C-1] 図面への既定値の読み戻し用に読む
            // (builtYear/structureType/totalFloors/totalUnits は元々 document
            // 組み立てに使っていたためこれまでも選択済み)。
            id: true,
            name: true,
            totalFloors: true,
            builtYear: true,
            builtMonth: true,
            structureType: true,
            managementCompany: true,
            totalUnits: true,
            basementFloors: true,
          },
        },
      },
    });

    if (!property) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    if (!canAccessPropertyRecord(session, property)) {
      throw new ApiError(403, "この物件にアクセスできません", "FORBIDDEN");
    }
    const kind = salesSheetTemplateKindFor(property.propertyType);
    if (!kind) {
      throw new ApiError(422, "この物件種別では販売図面を作成できません", "INVALID_PROPERTY_TYPE");
    }

    // 作成ダイアログの上書き項目（空ボディ → {}・不正 JSON → 400）。
    const body = await parseJsonBody(request);
    const bodyObj = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    // F3: 物件・棟への保存の指示（既定ON・省略時は今の版を気にしない）。
    const saveToProperty = bodyObj.saveToProperty !== false;
    const propertyVersion = typeof bodyObj.propertyVersion === "number" ? bodyObj.propertyVersion : null;
    const buildingVersion = typeof bodyObj.buildingVersion === "number" ? bodyObj.buildingVersion : null;

    // 写真を最大 N 枚 seed。保存前に1枚ずつ認可（caller が読める＋この物件に属する）。
    // 未認可 / 解決不能 / 別物件は落とす（サーバ生成は 422 ではなく drop 方針）＝未認可 key を
    // document に入れない＝GET で未認可 raw key を返さないことを保証する。順序は isPrimary→sortOrder。
    const seedPhotos = async (max: number): Promise<{ fileUrl: string }[]> => {
      const rows = await prisma.propertyPhoto.findMany({
        where: { propertyId: id },
        orderBy: [{ isPrimary: "desc" }, { sortOrder: "asc" }],
        take: max,
        select: { fileUrl: true },
      });
      const out: { fileUrl: string }[] = [];
      for (const r of rows) {
        const src = toCanonicalUploadsSrc(r.fileUrl);
        if (!src) continue;
        const key = getStorage().keyFromUrl(src);
        if (!key) continue;
        if (await isImageKeyAuthorizedForProperty(key, { session, permissions, propertyId: id })) {
          out.push({ fileUrl: src });
        }
      }
      return out;
    };
    // 土地も自社マイソク様式の複数写真レイアウトに合わせ3枚に統一
    // （[F2-A Task4]・旧は土地のみ1枚 baseSheet 時代の名残）。
    const photos = await seedPhotos(3);

    const company = await loadCompanyProfile();
    let document: SalesSheetDocument;
    let templateId: string;
    // I1: writeback は zod 検証済みの overrides(各分岐の `o`)を使う。生の body を直接
    // 渡すと schema に無いキー(例: mansion の layout/balconyDir)が無検証で列に入り得る。
    let overrides: Record<string, string | undefined>;

    if (kind === "land") {
      const o = landOverridesSchema.parse(body);
      overrides = o as unknown as Record<string, string | undefined>;
      document = buildSaleLandDocument({
        property: {
          address: property.address,
          zoningDistrict: property.zoningDistrict,
          buildingCoverageRatio: property.buildingCoverageRatio?.toString() ?? null,
          floorAreaRatio: property.floorAreaRatio?.toString() ?? null,
          roadType: property.roadType,
          roadWidth: property.roadWidth?.toString() ?? null,
          // 現況の日本語化は各ビルダー内部で行う（全テンプレで統一）。
          occupancyStatus: property.occupancyStatus,
          // [Task10 C-1] 物件に保存済みの販売条件を既定値として読み戻す。
          salePrice: property.salePrice?.toString() ?? null,
          access: property.access,
          landArea: property.landArea?.toString() ?? null,
          landAreaMethod: property.landAreaMethod,
        },
        photos,
        overrides: o,
        company,
      });
      templateId = "sale-land";
    } else if (kind === "mansion") {
      const o = mansionOverridesSchema.parse(body);
      overrides = o as unknown as Record<string, string | undefined>;
      document = buildSaleMansionDocument({
        property: {
          address: property.address,
          roomNo: property.roomNo,
          exclusiveArea: property.exclusiveArea?.toString() ?? null,
          balconyArea: property.balconyArea?.toString() ?? null,
          layoutType: property.layoutType,
          floorNo: property.floorNo,
          orientation: property.orientation,
          managementFee: property.managementFee,
          repairReserveFee: property.repairReserveFee,
          zoningDistrict: property.zoningDistrict,
          occupancyStatus: property.occupancyStatus,
          // [Task10 C-1] 物件に保存済みの販売条件を既定値として読み戻す(区分は building
          // relation を持つが、この5項目は buildWriteback が RULES.mansion で property の
          // スカラ列へ保存するため land/house/building と同じく property から読む)。
          salePrice: property.salePrice?.toString() ?? null,
          saleTaxType: property.saleTaxType,
          saleTaxAmount: property.saleTaxAmount?.toString() ?? null,
          access: property.access,
          parking: property.parking,
        },
        // ⚠**建物マスタが無くても物件名だけは渡す** (@codex #354 P2)。
        // 建物マスタを作らずに登録した区分マンションは property.building が
        // null で、ここを丸ごと null にすると**販売図面の建物名称が空**になる。
        building:
          property.building || property.buildingName
            ? {
                name: property.building?.name ?? property.buildingName,
                totalFloors: property.building?.totalFloors ?? null,
                builtYear: property.building?.builtYear ?? null,
                // [Task10 C-1] builtYearMonth の月精度を読み戻すために追加。
                builtMonth: property.building?.builtMonth ?? null,
                structureType: property.building?.structureType ?? null,
                managementCompany:
                  property.building?.managementCompany ?? null,
                totalUnits: property.building?.totalUnits ?? null,
                // [Task10 C-1] 地下階(basementFloors)の既定値として読み戻すために追加。
                basementFloors: property.building?.basementFloors ?? null,
              }
            : null,
        photos,
        overrides: o,
        company,
      });
      templateId = "sale-mansion";
    } else if (kind === "house") {
      const o = houseOverridesSchema.parse(body);
      overrides = o as unknown as Record<string, string | undefined>;
      document = buildSaleHouseDocument({
        property: {
          address: property.address,
          layoutType: property.layoutType,
          zoningDistrict: property.zoningDistrict,
          buildingCoverageRatio: property.buildingCoverageRatio?.toString() ?? null,
          floorAreaRatio: property.floorAreaRatio?.toString() ?? null,
          roadType: property.roadType,
          roadWidth: property.roadWidth?.toString() ?? null,
          occupancyStatus: property.occupancyStatus,
          // [Task10 C-1] 物件に保存済みの販売条件を既定値として読み戻す(house は
          // building relation を配線しないため、全て property のスカラ列から)。
          salePrice: property.salePrice?.toString() ?? null,
          saleTaxType: property.saleTaxType,
          saleTaxAmount: property.saleTaxAmount?.toString() ?? null,
          access: property.access,
          landArea: property.landArea?.toString() ?? null,
          landAreaMethod: property.landAreaMethod,
          totalFloorArea: property.totalFloorArea?.toString() ?? null,
          structureType: property.structureType,
          aboveFloors: property.aboveFloors,
          basementFloors: property.basementFloors,
          parking: property.parking,
          builtYear: property.builtYear,
          builtMonth: property.builtMonth,
        },
        photos,
        overrides: o,
        company,
      });
      templateId = "sale-house";
    } else {
      const o = buildingOverridesSchema.parse(body);
      overrides = o as unknown as Record<string, string | undefined>;
      document = buildSaleBuildingDocument({
        property: {
          address: property.address,
          zoningDistrict: property.zoningDistrict,
          buildingCoverageRatio: property.buildingCoverageRatio?.toString() ?? null,
          floorAreaRatio: property.floorAreaRatio?.toString() ?? null,
          roadType: property.roadType,
          roadWidth: property.roadWidth?.toString() ?? null,
          occupancyStatus: property.occupancyStatus,
          // [Task10 C-1] 物件に保存済みの販売条件・収益系を既定値として読み戻す(一棟も
          // house と同じく building relation を配線しないため、全て property のスカラ列から)。
          salePrice: property.salePrice?.toString() ?? null,
          saleTaxType: property.saleTaxType,
          saleTaxAmount: property.saleTaxAmount?.toString() ?? null,
          access: property.access,
          landArea: property.landArea?.toString() ?? null,
          landAreaMethod: property.landAreaMethod,
          totalFloorArea: property.totalFloorArea?.toString() ?? null,
          structureType: property.structureType,
          aboveFloors: property.aboveFloors,
          basementFloors: property.basementFloors,
          parking: property.parking,
          totalUnits: property.totalUnits,
          grossYield: property.grossYield?.toString() ?? null,
          expectedIncome: property.expectedIncome?.toString() ?? null,
          builtYear: property.builtYear,
          builtMonth: property.builtMonth,
        },
        kind: property.propertyType === "apartment_block" ? "apartment" : "mansion",
        photos,
        overrides: o,
        company,
      });
      templateId = "sale-building";
    }

    const noWriteback = { saved: [] as string[], unreadable: [] as string[], conflict: false };
    const conflictWriteback = { saved: [] as string[], unreadable: [] as string[], conflict: true };

    // 図面の作成 + 物件・棟への保存（読み取れた値のみ）を1トランザクションにまとめる
    // （原子性: 途中で失敗したら図面も作らない）。物件配下を書き換える前に親の行を
    // 先にロックする既存の決まりに合わせ、区分は棟の行も併せてロックする。
    const { design, writeback } = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM properties WHERE id = ${id}::uuid FOR UPDATE`;
      // @codex P1: ロックする棟を「トランザクションに入る前に読んだ property.building.id」で
      // 決めてはいけない。最初の読み取りからここまでの間に別処理（CSV取込など）が
      // properties.building_id を張り替えると、古い棟をロックしたまま新しい棟を更新しうる
      // （張り替えでは properties.version が上がらず、棟の version も 1 同士で一致しがち＝
      // version 判定は両方すり抜ける）。物件行を押さえた後なら building_id はもう動かせない
      // ので、その時点の紐付けを SQL 側で引き直してロックする（往復を増やさない）。
      // 紐付きが無ければ 0 行＝ロック無しで、条件分岐は不要。
      await tx.$queryRaw`
        SELECT b.id FROM buildings b
        JOIN properties p ON p.building_id = b.id
        WHERE p.id = ${id}::uuid
        FOR UPDATE OF b`;

      const created = await createDesign(
        { propertyId: id, document, userId: session.id, templateId },
        tx,
      );

      if (!saveToProperty) {
        return { design: created, writeback: noWriteback };
      }

      // C1: ロックを掴んだ**直後に読み直す**。最初の読み取り(282行目)と ここの間には
      // 写真取得・認可・会社プロフィール読込・document 組み立てという I/O が挟まるため、
      // version 判定・buildWriteback の current・ChangeLog の oldValue は
      // すべてこの読み直した値(fresh)を基準にする(最初の読み取りの値は使わない)。
      const fresh = await tx.property.findUnique({
        where: { id },
        select: {
          id: true,
          version: true,
          salePrice: true,
          saleTaxType: true,
          saleTaxAmount: true,
          access: true,
          landArea: true,
          landAreaMethod: true,
          totalFloorArea: true,
          builtYear: true,
          builtMonth: true,
          structureType: true,
          aboveFloors: true,
          basementFloors: true,
          parking: true,
          totalUnits: true,
          grossYield: true,
          expectedIncome: true,
          // ⚠R14: 区分マンションの物件側7項目(仕様書 §4.4)。「今の値と同じか」の判定と
          // ChangeLog の oldValue に使う(選ばないと常に undefined 扱いになり両方壊れる)。
          exclusiveArea: true,
          balconyArea: true,
          layoutType: true,
          orientation: true,
          floorNo: true,
          managementFee: true,
          repairReserveFee: true,
          building: {
            select: {
              id: true,
              version: true,
              structureType: true,
              totalFloors: true,
              basementFloors: true,
              totalUnits: true,
              builtYear: true,
              builtMonth: true,
            },
          },
        },
      });
      if (!fresh) {
        // FOR UPDATE の直後に消えている(想定外)。writeback は諦め図面だけ作る。
        return { design: created, writeback: conflictWriteback };
      }

      const hasBuilding = fresh.building !== null;
      // C2/I6: saveToProperty=true なのに version が無い/数値でない場合は無条件で
      // 上書きせず conflict 扱いにする(現行クライアントは version を送らない=Task 5 まで
      // 常にここを通る。図面自体は作る)。棟がある物件は buildingVersion も同様。
      const versionMissing =
        propertyVersion === null || (hasBuilding && buildingVersion === null);
      const versionStale =
        !versionMissing &&
        (propertyVersion !== fresh.version ||
          (hasBuilding && buildingVersion !== fresh.building!.version));
      if (versionMissing || versionStale) {
        return { design: created, writeback: conflictWriteback };
      }

      const result = buildWriteback({
        kind,
        values: overrides,
        current: { property: fresh, building: fresh.building },
      });
      const applied = await applyWriteback(tx, {
        propertyId: id,
        buildingId: fresh.building?.id ?? null,
        result,
        before: { property: fresh, building: fresh.building },
        propertyVersion: fresh.version,
        buildingVersion: fresh.building?.version ?? null,
        userId: session.id,
      });
      if (!applied.ok) {
        // FOR UPDATE 下では理論上起きないはずだが、書き込み自体にも条件を付ける
        // (@codex #394 R29 P1 と同じ考え方)防御として扱う。
        return { design: created, writeback: conflictWriteback };
      }

      return {
        design: created,
        writeback: { saved: labelsOf(kind, result), unreadable: result.unreadable, conflict: false },
      };
    });

    // 監査ログ（非PIIメタのみ: document 本文・画像 key・overrides・住所等は記録しない）。
    await writeAuditLog({
      userId: session.id,
      action: "sales_sheet_design_create",
      targetTable: "sales_sheet_designs",
      targetId: design.id,
      detail: { propertyId: id },
    });

    return NextResponse.json({ id: design.id, propertyWriteback: writeback }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
