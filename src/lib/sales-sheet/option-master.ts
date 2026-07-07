/**
 * 販売図面の選択肢マスタ。御社Excel「物件情報項目リスト」準拠。
 * F1は売マンションで使う分。他種別の追加分はF2で足す。
 */
export const PROPERTY_TYPE_MANSION = [
  "新築マンション","中古マンション","新築タウンハウス","中古タウンハウス",
  "新築リゾート","中古リゾート","その他",
] as const;
export const LAND_RIGHT = [
  "所有権","（旧法）地上権","（旧法）賃借権",
  "普通借地権（地上権）","定期借地権（地上権）",
  "普通借地権（賃借権）","定期借地権（賃借権）",
] as const;
export const USE_DISTRICT = [
  "第一種低層住居専用地域","第二種低層住居専用地域",
  "第一種中高層住居専用地域","第二種中高層住居専用地域",
  "第一種住居地域","第二種住居地域","準住居地域",
  "近隣商業地域","商業地域","準工業地域","工業地域","工業専用地域","無指定",
] as const;
export const BUILDING_STRUCTURE = ["木造","ブロック","鉄骨造","RC","SRC","PC","HPC","軽量鉄骨","その他"] as const;
export const AREA_METHOD_MANSION = ["壁芯","内法"] as const;
export const BALCONY_DIRECTION = ["北","北東","東","南東","南","南西","西","北西"] as const;
export const PARKING_MANSION = ["空有","空無","近隣確保","無"] as const;
export const MANAGEMENT_UNION = ["有","無"] as const;
export const MANAGEMENT_FORM = ["自主管理","一部委託","全部委託"] as const;
export const MANAGER_STATUS = ["常駐","日勤","巡回"] as const;
export const OCCUPANCY = ["居住中","空家","賃貸中","未完成"] as const;
export const DELIVERY_TIMING = ["即時","相談","期日指定","予定"] as const;
export const LAND_CATEGORY = ["宅地","田","畑","山林","雑種地","その他"] as const;
export const TERRAIN = ["平坦","高台","低地","ひな段","傾斜地","その他"] as const;
export const CITY_PLANNING = ["市街化区域","市街化調整区域","未線引区域","都市計画区域外","準都市"] as const;
export const AREA_ZONE = ["防火","準防火","高度","高度利用","風致","文教","その他"] as const;
export const ROAD_KIND = ["公道","私道"] as const;
export const ROAD_POSITION = ["有","無"] as const;
export const TRANSACTION_TYPE = ["売主","代理","専属専任","専任","一般媒介"] as const;
export const COMPENSATION = ["分かれ","当方不払","当方片手","代理折半","相談"] as const;
export const AD_TYPE = ["広告可","一部可ネット","一部可新聞チラシ","広告可要連絡","不可"] as const;
export const TAX = ["課税","不課税"] as const;
export const PRESENCE = ["あり","なし"] as const;

/** F2: 売土地で使う分。 */
export const PROPERTY_TYPE_LAND = ["売地","借地権","底地権"] as const;
export const BEST_USE_LAND = ["住宅用地","マンション用地","店舗用地","事務所用地","工業用地","その他"] as const;
export const AREA_METHOD_LAND = ["公簿","実測"] as const;
export const SETBACK_UNIT = ["m","㎡"] as const;
export const DIRECTION = ["北","北東","東","南東","南","南西","西","北西"] as const;
export const LAND_ACT_NOTICE = ["要","届出中","不要"] as const;
export const OCCUPANCY_LAND = ["更地","上物有"] as const;
