import type { FormChoice, FormDef, FormEntry, FormField, FormItem } from "./types";

/** 付帯設備表の種類(設計 第2段階 §4.8)。同じ書類の中でタブで選ぶ(段F の決めたこと 1)。 */
export type EquipmentKind = "house" | "unit";
export const EQUIPMENT_KIND_LABELS: Record<EquipmentKind, string> = { house: "土地建物用", unit: "区分所有建物用" };

/** 設備の内容(書式のセルごとの文字 parts と、丸を付けられる言葉 options)。 */
export interface EquipDetail { parts: string[]; options?: string[] }
/**
 * 設備の行の表(段F の決めたこと 2〜4)。文字は全宅連の書式のセルのまま(テストで突き合わせる)。
 * table=表１/表２の見出し・group=部門・equip=設備・blank=書式の空欄の行・note=備考。
 */
export type EquipRow =
  | { kind: "table"; key: string; title: string; nameHeader: string; detailHeader: string }
  | { kind: "group"; title: string }
  | { kind: "equip"; key: string; name: string; details?: EquipDetail[]; place?: boolean; count?: "台" | "ヶ所"; safety?: boolean }
  | { kind: "blank"; key: string }
  | { kind: "note"; key: string };

export const EQUIP_FAULT = "判明している故障・不具合の具体的内容";
export const EQUIP_SAFETY = "特定保守製品の表示（注２）";
const DETAIL_HEADER = "設置箇所・設備の内容・付帯設備等";
const d = (parts: string | string[], options?: string[]): EquipDetail => ({ parts: Array.isArray(parts) ? parts : [parts], ...(options ? { options } : {}) });
const EGS = ["電気", "ガス", "石油"];

const HOUSE: EquipRow[] = [
  { kind: "table", key: "t1", title: "表１．主要設備", nameHeader: "主要設備の名称", detailHeader: `${DETAIL_HEADER}（該当する箇所に〇を記入してください。）` },
  { kind: "group", title: "給湯関係" },
  { kind: "equip", key: "01", name: "給湯器", details: [d("（電気・ガス・石油・太陽熱）", [...EGS, "太陽熱"]), d("給湯箇所：（キッチン・浴室・洗面所）", ["キッチン", "浴室", "洗面所"])], safety: true },
  { kind: "equip", key: "02", name: "屋内式ガス湯沸かし器《個別》", safety: true },
  { kind: "blank", key: "03" },
  { kind: "group", title: "水廻り関係" },
  { kind: "equip", key: "04", name: "流し台" },
  { kind: "equip", key: "05", name: "混合水栓" },
  { kind: "equip", key: "06", name: "レンジフード《換気扇》" },
  { kind: "equip", key: "07", name: "コンロ", details: [d("（電気・ガス）", ["電気", "ガス"])] },
  { kind: "equip", key: "08", name: "グリル", details: [d("（電気・ガス）", ["電気", "ガス"])] },
  { kind: "equip", key: "09", name: "", details: [d("ビルトインオーブンレンジ（電気・ガス）", ["電気", "ガス"])] },
  { kind: "equip", key: "10", name: "", details: [d("ビルトイン食器洗浄乾燥機（電気・ガス）", ["電気", "ガス"])], safety: true },
  { kind: "equip", key: "11", name: "浄水器" },
  { kind: "equip", key: "12", name: "ディスポーザー" },
  { kind: "blank", key: "13" },
  { kind: "equip", key: "14", name: "シャワー" },
  { kind: "equip", key: "15", name: "混合水栓" },
  { kind: "equip", key: "16", name: "", details: [d("浴槽（追炊き・足し湯・保温・湯張り）", ["追炊き", "足し湯", "保温", "湯張り"])] },
  { kind: "equip", key: "17", name: "", details: [d("浴室洗面台　鏡（有・無）", ["有", "無"])] },
  { kind: "equip", key: "18", name: "屋内式風呂がま《バランス釜》", safety: true },
  { kind: "equip", key: "19", name: "浴室内乾燥《浴室内乾燥（暖房）機》", safety: true },
  { kind: "equip", key: "20", name: "", details: [d(["１階（洗面台・照明・シャワー・コンセント", "・鏡・曇り止め）"], ["洗面台", "照明", "シャワー", "コンセント", "鏡", "曇り止め"])] },
  { kind: "equip", key: "21", name: "", details: [d(["２階（洗面台・照明・シャワー・コンセント", "・鏡・曇り止め）"], ["洗面台", "照明", "シャワー", "コンセント", "鏡", "曇り止め"])] },
  { kind: "blank", key: "22" },
  { kind: "equip", key: "23", name: "", details: [d(["１階（便器・温水洗浄・保温・乾燥・", "ロータンク・手洗い・　　　）"], ["便器", "温水洗浄", "保温", "乾燥", "ロータンク", "手洗い"])] },
  { kind: "equip", key: "24", name: "", details: [d(["２階（便器・温水洗浄・保温・乾燥・", "ロータンク・手洗い・　　　）"], ["便器", "温水洗浄", "保温", "乾燥", "ロータンク", "手洗い"])] },
  { kind: "equip", key: "25", name: "防水パン" },
  { kind: "equip", key: "26", name: "洗濯用水栓" },
  { kind: "blank", key: "27" },
  { kind: "group", title: "空調関係" },
  { kind: "equip", key: "28", name: "冷暖房機", details: [d("（電気・ガス・石油）", EGS)], place: true, count: "台" },
  { kind: "equip", key: "29", name: "冷房機", details: [d("（電気・ガス・石油）", EGS)], place: true, count: "台" },
  { kind: "equip", key: "30", name: "暖房機", details: [d("（電気・ガス・石油）", EGS)], place: true, count: "台", safety: true },
  { kind: "equip", key: "31", name: "床暖房設備", details: [d("（電気・ガス・石油）", EGS)], place: true, count: "ヶ所" },
  { kind: "equip", key: "32", name: "", details: [d("換気扇（設置箇所：浴室・洗面所・トイレ・　　　　）", ["浴室", "洗面所", "トイレ"])] },
  { kind: "equip", key: "33", name: "２４時間換気システム" },
  { kind: "group", title: "その他" },
  { kind: "equip", key: "34", name: "インターホン", details: [d("（モニター：有・無）", ["有", "無"])] },
  { kind: "blank", key: "35" },
  { kind: "note", key: "36" },
  { kind: "table", key: "t2", title: "表２．その他設備", nameHeader: "その他設備の名称", detailHeader: `${DETAIL_HEADER}（該当する箇所に〇を記入ください。）` },
  { kind: "group", title: "照明関係" },
  { kind: "equip", key: "37", name: "屋内照明器具", count: "台" },
  { kind: "equip", key: "38", name: "屋外照明器具", place: true },
  { kind: "group", title: "収納関係" },
  { kind: "equip", key: "39", name: "収納棚", details: [d("（食器棚（造付）・電動昇降戸棚・つり戸棚）", ["食器棚（造付）", "電動昇降戸棚", "つり戸棚"])] },
  { kind: "equip", key: "40", name: "収納スペース", details: [d("（床下収納・小屋裏収納・　　　）", ["床下収納", "小屋裏収納"])] },
  { kind: "equip", key: "41", name: "下駄箱" },
  { kind: "blank", key: "42" },
  { kind: "group", title: "建具関係" },
  ...["網戸", "雨戸", "畳・ふすま", "戸・扉", "障子"].map((name, i): EquipRow => ({ kind: "equip", key: String(43 + i), name })),
  { kind: "group", title: "テレビ視聴" },
  { kind: "equip", key: "48", name: "地上波用ＴＶアンテナ" },
  { kind: "equip", key: "49", name: "衛星アンテナ" },
  { kind: "blank", key: "50" },
  { kind: "group", title: "その他" },
  ...["カーペット（敷込）", "カーテン", "カーテンレール", "物置", "物干し", "スロップシンク(屋外）", "屋外水栓", "庭木・庭石", "門・塀", "車庫・カーポート", "インターネット回線"]
    .map((name, i): EquipRow => ({ kind: "equip", key: String(51 + i), name })),
  { kind: "equip", key: "62", name: "住宅用火災警報器", place: true },
  { kind: "equip", key: "63", name: "太陽光発電システム" },
  { kind: "note", key: "64" },
];

const UNIT: EquipRow[] = [
  { kind: "table", key: "t1", title: "表１．主要設備", nameHeader: "主要設備の名称", detailHeader: `${DETAIL_HEADER}（該当する箇所に〇をご記入ください。）` },
  { kind: "group", title: "給湯関係" },
  { kind: "equip", key: "01", name: "給湯器", details: [d("（電気・ガス・石油・太陽熱）", [...EGS, "太陽熱"]), d("給湯箇所：（キッチン・浴室・洗面所）", ["キッチン", "浴室", "洗面所"])], safety: true },
  { kind: "blank", key: "02" },
  { kind: "equip", key: "03", name: "屋内式ガス湯沸かし器（個別）", safety: true },
  { kind: "blank", key: "04" },
  { kind: "group", title: "水廻り関係" },
  { kind: "equip", key: "05", name: "流し台" },
  { kind: "equip", key: "06", name: "混合水栓" },
  { kind: "equip", key: "07", name: "レンジフード《換気扇》" },
  { kind: "equip", key: "08", name: "コンロ", details: [d("（電気・ガス）", ["電気", "ガス"])] },
  { kind: "equip", key: "09", name: "グリル", details: [d("（電気・ガス）", ["電気", "ガス"])] },
  { kind: "equip", key: "10", name: "", details: [d("ビルトインオーブンレンジ（電気・ガス）", ["電気", "ガス"])] },
  { kind: "equip", key: "11", name: "", details: [d("ビルトイン食器洗浄乾燥機（電気・ガス）", ["電気", "ガス"])], safety: true },
  { kind: "equip", key: "12", name: "浄水器" },
  { kind: "equip", key: "13", name: "ディスポーザー" },
  { kind: "blank", key: "14" },
  { kind: "equip", key: "15", name: "シャワー" },
  { kind: "equip", key: "16", name: "混合水栓" },
  { kind: "equip", key: "17", name: "", details: [d("浴槽（追炊き・足し湯・保温・湯張り）", ["追炊き", "足し湯", "保温", "湯張り"])] },
  { kind: "equip", key: "18", name: "", details: [d("浴室洗面台　鏡（有・無）", ["有", "無"])] },
  { kind: "equip", key: "19", name: "屋内式風呂がま《バランス釜》", safety: true },
  { kind: "equip", key: "20", name: "浴室内乾燥（浴室内乾燥（暖房）機）", safety: true },
  { kind: "equip", key: "21", name: "", details: [d(["（洗面台・照明・シャワー・コンセント", "鏡・曇り止め）"], ["洗面台", "照明", "シャワー", "コンセント", "鏡", "曇り止め"])] },
  { kind: "blank", key: "22" },
  { kind: "equip", key: "23", name: "", details: [d(["（便器・温水洗浄・保温・乾燥・ロータンク", "手洗い・　　　）"], ["便器", "温水洗浄", "保温", "乾燥", "ロータンク", "手洗い"])] },
  { kind: "equip", key: "24", name: "防水パン" },
  { kind: "equip", key: "25", name: "洗濯用水栓" },
  { kind: "blank", key: "26" },
  { kind: "group", title: "空調関係" },
  { kind: "equip", key: "27", name: "冷暖房機", details: [d("（電気・ガス・石油）", EGS)], place: true, count: "台" },
  { kind: "equip", key: "28", name: "冷房機", details: [d("（電気・ガス・石油）", EGS)], place: true, count: "台" },
  { kind: "equip", key: "29", name: "暖房機", details: [d("（電気・ガス・石油）", EGS)], place: true, count: "台", safety: true },
  { kind: "equip", key: "30", name: "床暖房設備", details: [d("（電気・ガス・石油）", EGS)], place: true, count: "ヶ所" },
  { kind: "equip", key: "31", name: "", details: [d("換気扇（設置箇所：浴室・洗面所・トイレ・　　　　）", ["浴室", "洗面所", "トイレ"])] },
  { kind: "equip", key: "32", name: "２４時間換気システム" },
  { kind: "group", title: "その他" },
  { kind: "equip", key: "33", name: "インターホン", details: [d("（モニター：有・無）", ["有", "無"])] },
  { kind: "blank", key: "34" },
  { kind: "note", key: "35" },
  { kind: "table", key: "t2", title: "表２．その他設備", nameHeader: "その他設備の名称", detailHeader: `${DETAIL_HEADER}（該当する箇所に〇を記入ください。）` },
  { kind: "group", title: "照明" },
  { kind: "equip", key: "36", name: "室内照明器具", count: "台" },
  { kind: "group", title: "収納関係" },
  { kind: "equip", key: "37", name: "収納棚", details: [d("（食器棚（造付）・電動昇降戸棚・つり戸棚）", ["食器棚（造付）", "電動昇降戸棚", "つり戸棚"])] },
  { kind: "equip", key: "38", name: "収納スペース", details: [d("（床下収納・小屋裏収納・　　　）", ["床下収納", "小屋裏収納"])] },
  { kind: "equip", key: "39", name: "下駄箱" },
  { kind: "group", title: "建具関係" },
  ...["網戸", "畳・ふすま", "戸・扉", "障子"].map((name, i): EquipRow => ({ kind: "equip", key: String(40 + i), name })),
  { kind: "group", title: "テレビ視聴" },
  { kind: "equip", key: "44", name: "ＴＶ共視聴設備" },
  { kind: "blank", key: "45" },
  { kind: "group", title: "その他" },
  ...["カーペット（敷込）", "カーテン", "カーテンレール", "物干し", "スロップシンク（屋外）", "屋外水栓", "インターネット回線"]
    .map((name, i): EquipRow => ({ kind: "equip", key: String(46 + i), name })),
  { kind: "equip", key: "53", name: "住宅用火災警報器", place: true },
  { kind: "blank", key: "54" },
  { kind: "note", key: "55" },
];

export const EQUIPMENT_ROWS: Record<EquipmentKind, EquipRow[]> = { house: HOUSE, unit: UNIT };

/** 設備の名前(名称が無い行は内容の文字・Excel と入力欄の見出しに使う)。 */
export const equipLabel = (r: Extract<EquipRow, { kind: "equip" }>): string => r.name || (r.details?.[0]?.parts.join("") ?? "");
const YN: FormChoice[] = [{ value: "有", label: "有" }, { value: "無", label: "無" }];
const cs = (xs: string[]): FormChoice[] => xs.map((x) => ({ value: x, label: x }));

/** 設備の行の表から、入力欄と形の検査に使う項目の表を作る(PDF は business/equipment.ts が同じ行の表から4列で組み立てる)。 */
function entriesOf(kind: EquipmentKind): FormEntry[] {
  const p = kind === "house" ? "h" : "u";
  const only = [kind];
  let nameHeader = "";
  const out: FormEntry[] = [];
  for (const r of EQUIPMENT_ROWS[kind]) {
    if (r.kind === "table") {
      nameHeader = r.nameHeader;
      out.push({ kind: "section", title: r.title, only });
    } else if (r.kind === "group") {
      out.push({ kind: "item", key: `${p}g${out.length}`, label: r.title, only });
    } else if (r.kind === "note") {
      out.push({ kind: "item", key: p + r.key, label: "備考", only, fields: [{ key: `${p}${r.key}Text`, label: "", max: 1000, lines: 3 }] });
    } else if (r.kind === "blank") {
      out.push({
        kind: "item", key: p + r.key, label: "", sub: true, only, choices: YN,
        fields: [{ key: `${p}${r.key}Name`, label: nameHeader, max: 100 }, { key: `${p}${r.key}Fault`, label: EQUIP_FAULT, max: 300 }],
      });
    } else {
      const fields: FormField[] = [
        ...(r.place ? [{ key: `${p}${r.key}Place`, label: "設置箇所：", max: 100 }] : []),
        ...(r.count ? [{ key: `${p}${r.key}Count`, label: r.count, pre: "計", max: 10, after: true }] : []),
        { key: `${p}${r.key}Fault`, label: EQUIP_FAULT, max: 300 },
      ];
      const item: FormItem = { kind: "item", key: p + r.key, label: equipLabel(r), sub: true, only, choices: YN, fields };
      out.push(item);
      (r.details ?? []).forEach((dt, i) => {
        if (dt.options?.length) out.push({ kind: "item", key: `${p}${r.key}D${i}`, label: dt.parts.join(""), sub: true, only, multiple: true, choices: cs(dt.options) });
      });
      if (r.safety) out.push({ kind: "item", key: `${p}${r.key}S`, label: EQUIP_SAFETY, sub: true, only, choices: YN });
    }
  }
  return out;
}

export const EQUIPMENT_FORM: FormDef = {
  key: "equipment",
  tabs: { key: "kind", label: "種類", choices: (Object.keys(EQUIPMENT_KIND_LABELS) as EquipmentKind[]).map((k) => ({ value: k, label: EQUIPMENT_KIND_LABELS[k] })) },
  entries: [
    { kind: "item", key: "withGuide", label: "説明のページ（表紙と「ご記入にあたって」）", noPrint: true, choices: cs(["付ける", "付けない"]) },
    ...entriesOf("house"),
    ...entriesOf("unit"),
  ],
};
