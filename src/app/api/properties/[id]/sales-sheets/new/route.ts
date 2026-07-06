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
import type { SalesSheetDocument } from "@/lib/sales-sheet/document-schema";
import { salesSheetTemplateKindFor } from "@/lib/sales-sheet/template-kind";
import { isImageKeyAuthorizedForProperty } from "@/lib/sales-sheet/authorize-document-images";
import { getStorage } from "@/lib/storage";
import { writeAuditLog } from "@/lib/audit";

// 作成ダイアログが収集する任意の上書き項目（システムに無い値）。種別ごとに異なる。
// [F2-A Task4] LAND_FIELDS(field-model) の手入力キー全域 + レイアウト専用(catchCopy/
// salesPoints) に対応させる総入れ替え（mansionOverridesSchema と同じ方針。旧スキーマの
// price/access/landArea/landCategory:string/transactionType/deliveryTiming/remarks の
// 固定7項目を置換）。キー名は build-document.ts の SaleLandOverrides と一致させること。
// multiselect(地目/接道方向/都市計画/用途地域/地域地区/セールスポイント)のみ string[]、他は
// string。`deliveryTiming`（旧キー名の@deprecated別名）は新ダイアログが送らないため対象外。
// `landCategory` のみ string も受理する（@codex P2）: 旧（F2 以前）の作成ダイアログは
// landCategory を単一 string で送っていたため、デプロイ直後にブラウザキャッシュが効いた
// 旧クライアントが string を POST すると schema で 400 になり得る。buildLandValues
// （build-document.ts）が string | string[] を受けて配列へ正規化する実装は元々あるため、
// schema 側を string も許容するよう緩めるだけで足りる。roadDirections/cityPlanning/
// useDistrict/areaZone は F2 で新設のキーであり旧クライアントは送らないため array のまま。
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
const mansionOverridesSchema = z.object({
  // 価格・費用（DB enum と語彙が1:1対応しないため propertyType は常に手入力）
  propertyType: z.string().max(50).optional(),
  price: z.string().max(200).optional(),
  unitPrice: z.string().max(200).optional(),
  tax: z.string().max(50).optional(),
  taxAmount: z.string().max(200).optional(),
  // 所在・交通
  access: z.string().max(500).optional(),
  // 土地・権利
  siteArea: z.string().max(200).optional(),
  siteRightRatio: z.string().max(200).optional(),
  landRight: z.string().max(100).optional(),
  useDistrict: z.array(z.string().max(100)).max(20).optional(),
  areaMethod: z.string().max(50).optional(),
  // 建物
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
const houseOverridesSchema = z.object({
  price: z.string().max(200).optional(),
  access: z.string().max(500).optional(),
  landArea: z.string().max(200).optional(),
  buildingArea: z.string().max(200).optional(),
  builtYearMonth: z.string().max(100).optional(),
  structure: z.string().max(200).optional(),
  transactionType: z.string().max(200).optional(),
  deliveryTiming: z.string().max(200).optional(),
  remarks: z.string().max(1000).optional(),
});
const buildingOverridesSchema = z.object({
  price: z.string().max(200).optional(),
  access: z.string().max(500).optional(),
  landArea: z.string().max(200).optional(),
  totalFloorArea: z.string().max(200).optional(),
  totalUnits: z.string().max(50).optional(),
  builtYearMonth: z.string().max(100).optional(),
  structure: z.string().max(200).optional(),
  grossYield: z.string().max(100).optional(),
  expectedIncome: z.string().max(200).optional(),
  transactionType: z.string().max(200).optional(),
  deliveryTiming: z.string().max(200).optional(),
  remarks: z.string().max(1000).optional(),
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
        building: {
          select: {
            name: true,
            totalFloors: true,
            builtYear: true,
            structureType: true,
            managementCompany: true,
            totalUnits: true,
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

    let document: SalesSheetDocument;
    let templateId: string;

    if (kind === "land") {
      const o = landOverridesSchema.parse(body);
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
        },
        photos,
        overrides: o,
      });
      templateId = "sale-land";
    } else if (kind === "mansion") {
      const o = mansionOverridesSchema.parse(body);
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
        },
        building: property.building
          ? {
              name: property.building.name,
              totalFloors: property.building.totalFloors,
              builtYear: property.building.builtYear,
              structureType: property.building.structureType,
              managementCompany: property.building.managementCompany,
              totalUnits: property.building.totalUnits,
            }
          : null,
        photos,
        overrides: o,
      });
      templateId = "sale-mansion";
    } else if (kind === "house") {
      const o = houseOverridesSchema.parse(body);
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
        },
        photos,
        overrides: o,
      });
      templateId = "sale-house";
    } else {
      const o = buildingOverridesSchema.parse(body);
      document = buildSaleBuildingDocument({
        property: {
          address: property.address,
          zoningDistrict: property.zoningDistrict,
          buildingCoverageRatio: property.buildingCoverageRatio?.toString() ?? null,
          floorAreaRatio: property.floorAreaRatio?.toString() ?? null,
          roadType: property.roadType,
          roadWidth: property.roadWidth?.toString() ?? null,
          occupancyStatus: property.occupancyStatus,
        },
        kind: property.propertyType === "apartment_block" ? "apartment" : "mansion",
        photos,
        overrides: o,
      });
      templateId = "sale-building";
    }

    const design = await createDesign({ propertyId: id, document, userId: session.id, templateId });

    // 監査ログ（非PIIメタのみ: document 本文・画像 key・overrides・住所等は記録しない）。
    await writeAuditLog({
      userId: session.id,
      action: "sales_sheet_design_create",
      targetTable: "sales_sheet_designs",
      targetId: design.id,
      detail: { propertyId: id },
    });

    return NextResponse.json({ id: design.id }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
