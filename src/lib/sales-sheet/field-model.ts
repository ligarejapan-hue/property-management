/**
 * 販売図面の入力方式モデル(純・宣言的定義)。
 * widget/選択肢/単位/自動反映元/条件付き表示 を1か所で定義し、
 * 作成ダイアログと図面ビルダーが同じ定義を読む。
 * F1は売マンション(MANSION_FIELDS)のみ。他種別はF2で追加。
 */
import * as M from "./option-master";

export type FieldWidget = "select" | "multiselect" | "toggle" | "text" | "number";

export interface SheetField {
  key: string;
  label: string;
  widget: FieldWidget;
  section: string;
  options?: readonly string[];
  unit?: string;
  autoFrom?: string;      // 物件データ自動反映元
  controlOnly?: boolean;  // ダイアログのみ(表の行にしない)
  showWhen?: { field: string; equals: string };
}

export const MANSION_FIELDS: readonly SheetField[] = [
  // 価格・費用
  { key: "propertyType", label: "物件種目", widget: "select", section: "価格", options: M.PROPERTY_TYPE_MANSION, autoFrom: "propertyType" },
  { key: "buildingName", label: "建物名称", widget: "text", section: "価格", autoFrom: "buildingName" },
  { key: "price", label: "価格", widget: "number", section: "価格", unit: "万円" },
  { key: "unitPrice", label: "㎡単価", widget: "number", section: "価格", unit: "万円" },
  { key: "tax", label: "消費税", widget: "select", section: "価格", options: M.TAX, controlOnly: true },
  { key: "taxAmount", label: "うち消費税", widget: "number", section: "価格", unit: "万円", showWhen: { field: "tax", equals: "課税" } },
  { key: "managementFee", label: "管理費", widget: "number", section: "価格", unit: "円/月", autoFrom: "managementFee" },
  { key: "repairFee", label: "修繕積立金", widget: "number", section: "価格", unit: "円/月", autoFrom: "repairReserveFee" },
  // 所在・交通
  { key: "address", label: "所在地", widget: "text", section: "所在", autoFrom: "address" },
  { key: "access", label: "交通", widget: "text", section: "所在" },
  // 土地・権利
  { key: "siteArea", label: "敷地面積", widget: "number", section: "土地", unit: "㎡" },
  { key: "siteRightRatio", label: "敷地権割合共有持分", widget: "text", section: "土地" },
  { key: "landRight", label: "土地権利", widget: "select", section: "土地", options: M.LAND_RIGHT },
  { key: "useDistrict", label: "用途地域", widget: "multiselect", section: "土地", options: M.USE_DISTRICT, autoFrom: "zoningDistrict" },
  // 建物
  { key: "areaMethod", label: "面積計測方式", widget: "select", section: "建物", options: M.AREA_METHOD_MANSION, controlOnly: true },
  // unit(㎡) は持たせない: buildMansionValues が面積計測方式(壁芯/内法)と合わせて
  // "67.21㎡（壁芯）" 形にあらかじめ合成した文字列を渡すため、sheet-rows 側で
  // ㎡ を二重付与しないようにする（@codex P2 fix）。
  { key: "exclusiveArea", label: "専有面積", widget: "number", section: "建物", autoFrom: "exclusiveArea" },
  { key: "balconyArea", label: "バルコニー面積", widget: "number", section: "建物", unit: "㎡", autoFrom: "balconyArea" },
  { key: "balconyDir", label: "バルコニー向き", widget: "select", section: "建物", options: M.BALCONY_DIRECTION, autoFrom: "orientation" },
  { key: "layout", label: "間取り", widget: "text", section: "建物", autoFrom: "layoutType" },
  { key: "structure", label: "建物構造", widget: "select", section: "建物", options: M.BUILDING_STRUCTURE, autoFrom: "structureType" },
  { key: "floorNo", label: "所在階", widget: "number", section: "建物", unit: "階", autoFrom: "floorNo" },
  { key: "totalFloors", label: "地上階", widget: "number", section: "建物", unit: "階", autoFrom: "totalFloors" },
  { key: "basementFloors", label: "地下階", widget: "number", section: "建物", unit: "階" },
  { key: "builtYearMonth", label: "築年月", widget: "text", section: "建物", autoFrom: "builtYear" },
  { key: "totalUnits", label: "総戸数", widget: "number", section: "建物", unit: "戸", autoFrom: "totalUnits" },
  { key: "parking", label: "駐車場", widget: "select", section: "建物", options: M.PARKING_MANSION },
  { key: "parkingFee", label: "駐車場月額", widget: "number", section: "建物", unit: "円/月" },
  // 設備・現況・管理
  { key: "equipment", label: "設備・条件", widget: "text", section: "設備" },
  { key: "legalRestriction", label: "その他法令上の制限", widget: "text", section: "設備" },
  { key: "managementUnion", label: "管理組合", widget: "select", section: "設備", options: M.MANAGEMENT_UNION },
  { key: "managementForm", label: "管理形態", widget: "select", section: "設備", options: M.MANAGEMENT_FORM },
  { key: "managerStatus", label: "管理人状況", widget: "select", section: "設備", options: M.MANAGER_STATUS },
  { key: "managementCompany", label: "管理会社", widget: "text", section: "設備", autoFrom: "managementCompany" },
  { key: "developer", label: "分譲会社", widget: "text", section: "設備" },
  { key: "builder", label: "施工会社", widget: "text", section: "設備" },
  { key: "occupancy", label: "現況", widget: "select", section: "設備", options: M.OCCUPANCY, autoFrom: "occupancyStatus" },
  { key: "delivery", label: "引渡時期", widget: "select", section: "設備", options: M.DELIVERY_TIMING },
  { key: "remarks", label: "備考", widget: "text", section: "設備" },
  // 会社（フッター・手入力のみ・自動反映元なし。ビルダーはこのセクションを
  // スペック表から除外し、会社フッター帯の組み立てにのみ使う）
  { key: "transactionType", label: "取引態様", widget: "select", section: "会社", options: M.TRANSACTION_TYPE },
  { key: "compensation", label: "報酬", widget: "select", section: "会社", options: M.COMPENSATION },
  { key: "adType", label: "広告", widget: "select", section: "会社", options: M.AD_TYPE },
  { key: "staff", label: "担当者", widget: "text", section: "会社" },
  { key: "agent", label: "取引士", widget: "text", section: "会社" },
  { key: "specialNotes", label: "特記事項", widget: "text", section: "会社" },
];

/**
 * 売土地のスペック表フィールド定義([F2-A Task3])。マンションと異なり消費税欄は
 * 持たない(土地は非課税)。地目/接道方向/都市計画/用途地域/地域地区は複数選択(併記)。
 */
export const LAND_FIELDS: readonly SheetField[] = [
  // 価格
  { key: "propertyType", label: "物件種目", widget: "select", section: "価格", options: M.PROPERTY_TYPE_LAND },
  { key: "bestUse", label: "最適用途", widget: "select", section: "価格", options: M.BEST_USE_LAND },
  { key: "price", label: "価格", widget: "number", section: "価格", unit: "万円" },
  { key: "unitPrice", label: "坪/㎡単価", widget: "number", section: "価格", unit: "万円" },
  // 所在・交通
  { key: "address", label: "所在地", widget: "text", section: "所在", autoFrom: "address" },
  { key: "access", label: "交通", widget: "text", section: "所在" },
  // 土地
  // unit は持たせない: buildLandValues が面積計測方式(公簿/実測)と合わせて "150.5㎡（実測）"
  // 形にあらかじめ合成した文字列を渡すため、sheet-rows 側で ㎡ を二重付与しない
  // （MANSION_FIELDS.exclusiveArea と同じ理由・build-document.ts の fmtAreaWithMethod 参照）。
  { key: "landArea", label: "土地面積", widget: "number", section: "土地" },
  { key: "areaMethod", label: "面積計測方式", widget: "select", section: "土地", options: M.AREA_METHOD_LAND, controlOnly: true },
  { key: "landCategory", label: "地目", widget: "multiselect", section: "土地", options: M.LAND_CATEGORY },
  { key: "privateRoad", label: "私道負担", widget: "number", section: "土地", unit: "㎡" },
  { key: "terrain", label: "地勢", widget: "select", section: "土地", options: M.TERRAIN },
  // unit は持たせない: セットバック単位(m/㎡)と合成した文字列を buildLandValues が渡す
  // （build-document.ts の fmtValueWithUnit 参照）。
  { key: "setback", label: "セットバック", widget: "number", section: "土地" },
  { key: "setbackUnit", label: "セットバック単位", widget: "select", section: "土地", options: M.SETBACK_UNIT, controlOnly: true },
  { key: "buildCondition", label: "建築条件", widget: "select", section: "土地", options: M.PRESENCE },
  // 法令
  { key: "roadKind", label: "接道種別", widget: "select", section: "法令", options: M.ROAD_KIND, autoFrom: "roadType" },
  { key: "roadWidth", label: "接道幅員", widget: "text", section: "法令", unit: "m", autoFrom: "roadWidth" },
  { key: "roadDirections", label: "接道方向", widget: "multiselect", section: "法令", options: M.DIRECTION },
  { key: "cityPlanning", label: "都市計画", widget: "multiselect", section: "法令", options: M.CITY_PLANNING },
  { key: "landPermit", label: "国土法届出", widget: "select", section: "法令", options: M.LAND_ACT_NOTICE },
  { key: "useDistrict", label: "用途地域", widget: "multiselect", section: "法令", options: M.USE_DISTRICT, autoFrom: "zoningDistrict" },
  { key: "areaZone", label: "地域地区", widget: "multiselect", section: "法令", options: M.AREA_ZONE },
  { key: "coverageRatio", label: "建蔽率", widget: "number", section: "法令", unit: "％", autoFrom: "buildingCoverageRatio" },
  { key: "floorRatio", label: "容積率", widget: "number", section: "法令", unit: "％", autoFrom: "floorAreaRatio" },
  { key: "legalRestriction", label: "その他法令上の制限", widget: "text", section: "法令" },
  // 設備・現況
  { key: "equipment", label: "設備・条件", widget: "text", section: "設備" },
  { key: "occupancy", label: "現況", widget: "select", section: "設備", options: M.OCCUPANCY_LAND, autoFrom: "occupancyStatus" },
  { key: "delivery", label: "引渡時期", widget: "select", section: "設備", options: M.DELIVERY_TIMING },
  { key: "remarks", label: "備考", widget: "text", section: "設備" },
  // 会社（フッター・手入力のみ・自動反映元なし。MANSION_FIELDS と同一のキー・ラベル・
  // 選択肢のため、ビルダー側の会社帯組み立て(FooterBandData)を共有できる）
  { key: "transactionType", label: "取引態様", widget: "select", section: "会社", options: M.TRANSACTION_TYPE },
  { key: "compensation", label: "報酬", widget: "select", section: "会社", options: M.COMPENSATION },
  { key: "adType", label: "広告", widget: "select", section: "会社", options: M.AD_TYPE },
  { key: "staff", label: "担当者", widget: "text", section: "会社" },
  { key: "agent", label: "取引士", widget: "text", section: "会社" },
  { key: "specialNotes", label: "特記事項", widget: "text", section: "会社" },
];

/**
 * 売戸建のスペック表フィールド定義([F2-B Task2])。マンション/土地と異なり、house は
 * building relation を配線しない(現行踏襲)ため、建物構造/築年月/増改築年月/各階面積/
 * 地上階・地下階は autoFrom を持たず常に手入力。消費税(課税/不課税)欄を持つ点は
 * マンションと同じ(土地は非課税だが戸建は課税対象)。地目/接道方向/都市計画/用途地域/
 * 地域地区は複数選択(併記・LAND_FIELDS と同じ5項目)。
 */
export const HOUSE_FIELDS: readonly SheetField[] = [
  // 価格
  { key: "propertyType", label: "物件種目", widget: "select", section: "価格", options: M.PROPERTY_TYPE_HOUSE },
  { key: "price", label: "価格", widget: "number", section: "価格", unit: "万円" },
  { key: "tax", label: "消費税", widget: "select", section: "価格", options: M.TAX, controlOnly: true },
  { key: "taxAmount", label: "うち消費税", widget: "number", section: "価格", unit: "万円", showWhen: { field: "tax", equals: "課税" } },
  // 所在・交通
  { key: "address", label: "所在地", widget: "text", section: "所在", autoFrom: "address" },
  { key: "access", label: "交通", widget: "text", section: "所在" },
  // 土地
  // unit は持たせない: buildHouseValues が面積計測方式(公簿/実測)と合わせて "120.5㎡（実測）"
  // 形にあらかじめ合成した文字列を渡すため、sheet-rows 側で ㎡ を二重付与しない
  // （LAND_FIELDS.landArea と同じ理由・build-document.ts の fmtAreaWithMethod 参照）。
  { key: "landArea", label: "土地面積", widget: "number", section: "土地" },
  { key: "areaMethod", label: "面積計測方式", widget: "select", section: "土地", options: M.AREA_METHOD_LAND, controlOnly: true },
  { key: "landRight", label: "土地権利", widget: "select", section: "土地", options: M.LAND_RIGHT },
  { key: "privateRoad", label: "私道負担", widget: "number", section: "土地", unit: "㎡" },
  { key: "landCategory", label: "地目", widget: "multiselect", section: "土地", options: M.LAND_CATEGORY },
  // unit は持たせない: セットバック単位(m/㎡)と合成した文字列を buildHouseValues が渡す
  // （LAND_FIELDS.setback と同じ理由）。
  { key: "setback", label: "セットバック", widget: "number", section: "土地" },
  { key: "setbackUnit", label: "単位", widget: "select", section: "土地", options: M.SETBACK_UNIT, controlOnly: true },
  { key: "terrain", label: "地勢", widget: "select", section: "土地", options: M.TERRAIN },
  // 建物（house は building relation を配線しない=現行踏襲のため、建物構造/築年月は
  // autoFrom を持たず常に手入力）
  { key: "buildingArea", label: "建物面積(延べ)", widget: "number", section: "建物", unit: "㎡" },
  { key: "floor1Area", label: "1階面積", widget: "number", section: "建物", unit: "㎡" },
  { key: "floor2Area", label: "2階面積", widget: "number", section: "建物", unit: "㎡" },
  { key: "floor3Area", label: "3階面積", widget: "number", section: "建物", unit: "㎡" },
  { key: "structure", label: "建物構造", widget: "select", section: "建物", options: M.BUILDING_STRUCTURE },
  { key: "aboveFloors", label: "地上階", widget: "number", section: "建物", unit: "階" },
  { key: "basementFloors", label: "地下階", widget: "number", section: "建物", unit: "階" },
  { key: "layout", label: "間取り", widget: "text", section: "建物", autoFrom: "layoutType" },
  { key: "parking", label: "駐車場", widget: "select", section: "建物", options: M.PARKING_HOUSE },
  { key: "builtYearMonth", label: "築年月", widget: "text", section: "建物" },
  { key: "renovYearMonth", label: "増改築年月", widget: "text", section: "建物" },
  // 法令
  { key: "roadKind", label: "接道種別", widget: "select", section: "法令", options: M.ROAD_KIND, autoFrom: "roadType" },
  { key: "roadWidth", label: "接道幅員", widget: "text", section: "法令", unit: "m", autoFrom: "roadWidth" },
  { key: "roadDirections", label: "接道方向", widget: "multiselect", section: "法令", options: M.DIRECTION },
  { key: "cityPlanning", label: "都市計画", widget: "multiselect", section: "法令", options: M.CITY_PLANNING },
  { key: "useDistrict", label: "用途地域", widget: "multiselect", section: "法令", options: M.USE_DISTRICT, autoFrom: "zoningDistrict" },
  { key: "areaZone", label: "地域地区", widget: "multiselect", section: "法令", options: M.AREA_ZONE },
  { key: "coverageRatio", label: "建蔽率", widget: "number", section: "法令", unit: "％", autoFrom: "buildingCoverageRatio" },
  { key: "floorRatio", label: "容積率", widget: "number", section: "法令", unit: "％", autoFrom: "floorAreaRatio" },
  { key: "buildingConfirm", label: "建築確認区分", widget: "select", section: "法令", options: M.BUILDING_CONFIRM },
  { key: "rebuild", label: "再建築", widget: "select", section: "法令", options: M.REBUILD_STATUS },
  { key: "legalRestriction", label: "その他法令上の制限", widget: "text", section: "法令" },
  // 設備・現況
  { key: "equipment", label: "設備・条件", widget: "text", section: "設備" },
  { key: "occupancy", label: "現況", widget: "select", section: "設備", options: M.OCCUPANCY, autoFrom: "occupancyStatus" },
  { key: "delivery", label: "引渡時期", widget: "select", section: "設備", options: M.DELIVERY_TIMING },
  { key: "remarks", label: "備考", widget: "text", section: "設備" },
  // 会社（フッター・手入力のみ・自動反映元なし。MANSION_FIELDS/LAND_FIELDS と同一の
  // キー・ラベル・選択肢のため、FooterBandData を共有できる）
  { key: "transactionType", label: "取引態様", widget: "select", section: "会社", options: M.TRANSACTION_TYPE },
  { key: "compensation", label: "報酬", widget: "select", section: "会社", options: M.COMPENSATION },
  { key: "adType", label: "広告", widget: "select", section: "会社", options: M.AD_TYPE },
  { key: "staff", label: "担当者", widget: "text", section: "会社" },
  { key: "agent", label: "取引士", widget: "text", section: "会社" },
  { key: "specialNotes", label: "特記事項", widget: "text", section: "会社" },
];

/**
 * 一棟(building)のスペック表フィールド定義([F2-C Task2])。売戸建(HOUSE_FIELDS)にほぼ準拠
 * しつつ、収益系(総戸数/想定利回り/満室想定収入)と付帯権利を持つ。見出しは kind により
 * 一棟マンション/一棟アパートに二分岐する(build-document 側で決定)。house 同様 building
 * relation は配線しない(現行踏襲)ため、構造/築年月/総戸数/想定利回り/満室想定収入は常に
 * 手入力。各階面積は持たず延床面積で表す(一棟)。現況語彙は house/mansion と同一
 * (mapOccupancyStatusToMansionOccupancy 再利用)。付帯権利は LAND_RIGHT を再利用しラベルのみ
 * 差し替え。想定利回り(%)/満室想定収入(万円)は unit を持たせず、buildBuildingValues が
 * 合成する(キャッシュ済みクライアントの単位付き自由入力での二重付与を防ぐ)。
 */
export const BUILDING_FIELDS: readonly SheetField[] = [
  // 価格
  { key: "propertyType", label: "物件種目", widget: "select", section: "価格", options: M.PROPERTY_TYPE_BUILDING },
  { key: "price", label: "価格", widget: "number", section: "価格", unit: "万円" },
  { key: "tax", label: "消費税", widget: "select", section: "価格", options: M.TAX, controlOnly: true },
  { key: "taxAmount", label: "うち消費税", widget: "number", section: "価格", unit: "万円", showWhen: { field: "tax", equals: "課税" } },
  // 所在・交通
  { key: "address", label: "所在地", widget: "text", section: "所在", autoFrom: "address" },
  { key: "access", label: "交通", widget: "text", section: "所在" },
  // 土地
  // landArea/setback は unit を持たせない: buildBuildingValues が面積計測方式(公簿/実測)・
  // 単位(m/㎡)と合成する（HOUSE_FIELDS.landArea/setback と同じ理由）。
  { key: "landArea", label: "土地面積", widget: "number", section: "土地" },
  { key: "areaMethod", label: "面積計測方式", widget: "select", section: "土地", options: M.AREA_METHOD_LAND, controlOnly: true },
  { key: "landRight", label: "付帯権利", widget: "select", section: "土地", options: M.LAND_RIGHT },
  { key: "privateRoad", label: "私道負担", widget: "number", section: "土地", unit: "㎡" },
  { key: "landCategory", label: "地目", widget: "multiselect", section: "土地", options: M.LAND_CATEGORY },
  { key: "setback", label: "セットバック", widget: "number", section: "土地" },
  { key: "setbackUnit", label: "単位", widget: "select", section: "土地", options: M.SETBACK_UNIT, controlOnly: true },
  { key: "terrain", label: "地勢", widget: "select", section: "土地", options: M.TERRAIN },
  // 建物（building relation は配線しない=現行踏襲のため構造/築年月は手入力。各階面積は
  // 持たず延床面積で表す＝一棟）
  { key: "totalFloorArea", label: "延床面積", widget: "number", section: "建物", unit: "㎡" },
  { key: "structure", label: "構造", widget: "select", section: "建物", options: M.BUILDING_STRUCTURE },
  { key: "aboveFloors", label: "地上階", widget: "number", section: "建物", unit: "階" },
  { key: "basementFloors", label: "地下階", widget: "number", section: "建物", unit: "階" },
  { key: "builtYearMonth", label: "築年月", widget: "text", section: "建物" },
  { key: "renovYearMonth", label: "増改築年月", widget: "text", section: "建物" },
  { key: "parking", label: "駐車場", widget: "select", section: "建物", options: M.PARKING_HOUSE },
  // 収益（一棟固有・手入力）
  { key: "totalUnits", label: "総戸数", widget: "number", section: "収益", unit: "戸" },
  { key: "grossYield", label: "想定利回り", widget: "number", section: "収益" },
  { key: "expectedIncome", label: "満室想定収入(年額)", widget: "number", section: "収益" },
  // 法令
  { key: "roadKind", label: "接道種別", widget: "select", section: "法令", options: M.ROAD_KIND, autoFrom: "roadType" },
  { key: "roadWidth", label: "接道幅員", widget: "text", section: "法令", unit: "m", autoFrom: "roadWidth" },
  { key: "roadDirections", label: "接道方向", widget: "multiselect", section: "法令", options: M.DIRECTION },
  { key: "cityPlanning", label: "都市計画", widget: "multiselect", section: "法令", options: M.CITY_PLANNING },
  { key: "useDistrict", label: "用途地域", widget: "multiselect", section: "法令", options: M.USE_DISTRICT, autoFrom: "zoningDistrict" },
  { key: "areaZone", label: "地域地区", widget: "multiselect", section: "法令", options: M.AREA_ZONE },
  { key: "coverageRatio", label: "建蔽率", widget: "number", section: "法令", unit: "％", autoFrom: "buildingCoverageRatio" },
  { key: "floorRatio", label: "容積率", widget: "number", section: "法令", unit: "％", autoFrom: "floorAreaRatio" },
  { key: "buildingConfirm", label: "建築確認区分", widget: "select", section: "法令", options: M.BUILDING_CONFIRM },
  { key: "rebuild", label: "再建築", widget: "select", section: "法令", options: M.REBUILD_STATUS },
  { key: "legalRestriction", label: "その他法令上の制限", widget: "text", section: "法令" },
  // 設備・現況
  { key: "equipment", label: "設備・条件", widget: "text", section: "設備" },
  { key: "occupancy", label: "現況", widget: "select", section: "設備", options: M.OCCUPANCY, autoFrom: "occupancyStatus" },
  { key: "delivery", label: "引渡時期", widget: "select", section: "設備", options: M.DELIVERY_TIMING },
  { key: "remarks", label: "備考", widget: "text", section: "設備" },
  // 会社（フッター）
  { key: "transactionType", label: "取引態様", widget: "select", section: "会社", options: M.TRANSACTION_TYPE },
  { key: "compensation", label: "報酬", widget: "select", section: "会社", options: M.COMPENSATION },
  { key: "adType", label: "広告", widget: "select", section: "会社", options: M.AD_TYPE },
  { key: "staff", label: "担当者", widget: "text", section: "会社" },
  { key: "agent", label: "取引士", widget: "text", section: "会社" },
  { key: "specialNotes", label: "特記事項", widget: "text", section: "会社" },
];
