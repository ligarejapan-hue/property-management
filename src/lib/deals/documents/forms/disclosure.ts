import type { FormChoice, FormDef, FormEntry, FormField, FormItem } from "./types";

/** 告知書の種類(設計 第2段階 §4.7)。同じ書類の中でタブで選ぶ(段E の決めたこと 1)。 */
export type DisclosureKind = "house" | "unit";
export const DISCLOSURE_KIND_LABELS: Record<DisclosureKind, string> = { house: "土地建物・土地用", unit: "区分所有建物用" };

/**
 * 項目の表の文字は全宅連の書式のセルの文字のまま(段E の決めたこと 2・テストで突き合わせる)。
 * 鍵は土地建物=h・区分=u で始める(前回の入力が種類で混ざらないように)。
 */
type Ctx = { p: "h" | "u"; only: [DisclosureKind] };
const cs = (xs: string[]): FormChoice[] => xs.map((x) => ({ value: x, label: x }));
const fl = (c: Ctx, key: string, label: string, opt: Partial<FormField> = {}): FormField => ({ key: c.p + key, label, max: 200, ...opt });
const yy = (c: Ctx, key: string, last: "月頃" | "日" = "月頃"): FormField[] => [
  fl(c, `${key}Y`, "年", { max: 10, after: true }),
  ...(last === "日" ? [fl(c, `${key}M`, "月", { max: 10, after: true }), fl(c, `${key}D`, "日", { max: 10, after: true })] : [fl(c, `${key}M`, "月頃", { max: 10, after: true })]),
];
/** 年月の最初の欄の前に書式の字を出す(⑥「時期：＿年＿月頃」)。 */
const withPre = (fields: FormField[], pre: string): FormField[] => fields.map((f, i) => (i === 0 ? { ...f, pre } : f));
/** 番号の行。 */
const head = (c: Ctx, key: string, label: string, choices?: string[], fields?: FormField[]): FormItem =>
  ({ kind: "item", key: c.p + key, label, only: c.only, ...(choices ? { choices: cs(choices) } : {}), ...(fields ? { fields } : {}) });
/** 番号の行の下の行。 */
const sub = (c: Ctx, key: string, label: string, choices?: string[], fields?: FormField[], multiple = false): FormItem =>
  ({ kind: "item", key: c.p + key, label, sub: true, only: c.only, ...(choices ? { choices: cs(choices), ...(multiple ? { multiple: true } : {}) } : {}), ...(fields ? { fields } : {}) });
/** 書式の □ の付いた文1つ(チェックを付けるだけ)。 */
const check = (c: Ctx, key: string, text: string, fields?: FormField[]): FormItem => sub(c, key, "", [text], fields, true);
/** 下の行の書き込み欄だけ。 */
const write = (c: Ctx, key: string, label: string, lines?: number): FormItem => sub(c, key, "", undefined, [fl(c, key + "Text", label, lines ? { lines, max: 1000 } : {})]);

const YN = ["無", "有"];
const YNU = ["無", "有", "不明"];
const FOUND = ["発見していない", "発見している"];
const HAS = ["有", "無"];

/** ①〜⑪(建物のこと)。土地建物と区分で文字の違う所だけ引数で変える。 */
function buildingItems(c: Ctx, v: { reform: string; asbestos: string; asbestosDate: string; built: string; fireArea: string; otherDoc: "split" | "one" }): FormEntry[] {
  return [
    head(c, "01", "①雨漏り"),
    check(c, "01a", "現在まで雨漏りを発見していない。"),
    check(c, "01b", "過去に雨漏りがあった。", [fl(c, "01bPlace", "箇所：")]),
    sub(c, "01c", "修理工事：", ["未", "済"], yy(c, "01c")),
    check(c, "01d", "現在雨漏り箇所がある。", [fl(c, "01dPlace", "箇所：")]),
    head(c, "02", "②白蟻被害"),
    check(c, "02a", "現在まで白蟻の被害を発見していない。"),
    sub(c, "02b", "白蟻予防工事：", ["未", "済"], yy(c, "02b")),
    check(c, "02c", "過去に白蟻の被害があった。", [fl(c, "02cPlace", "箇所：")]),
    sub(c, "02d", "駆除と修理工事：", ["未", "済"], yy(c, "02d")),
    check(c, "02e", "現在白蟻の被害がある。", [fl(c, "02ePlace", "箇所：")]),
    head(c, "03", "③建物の不具合（傾き・腐食・不具合等）", FOUND),
    write(c, "03a", "箇所・状況："),
    head(c, "04", "④給排水施設の故障・漏水", FOUND),
    write(c, "04a", "箇所・状況："),
    // 年月は「実施している(＿年＿月頃)」の括弧の中(書式の並び・2026-10-30)
    { ...head(c, "05", v.reform, ["実施していない", "実施している", "不明"], yy(c, "05")), fieldsAt: { choice: "実施している", open: "(", close: ")" } },
    write(c, "05a", "箇所・内容："),
    write(c, "05b", "建設業者："),
    sub(c, "05c", "建築確認済証：", HAS),
    sub(c, "05d", "検査済証：", HAS),
    sub(c, "05e", "設計図書：", HAS),
    head(c, "06", "⑥火災(ボヤ等含む)の被害", YN, withPre(yy(c, "06"), "時期：")),
    write(c, "06a", v.fireArea),
    head(c, "07", v.asbestos, YN),
    sub(c, "07a", v.asbestosDate, undefined, yy(c, "07a", "日")),
    write(c, "07b", "調査の実施機関："),
    write(c, "07c", "調査の範囲："),
    write(c, "07d", "備考："),
    head(c, "08", "⑧建物状況調査", YN),
    // 書式の「（建物状況調査報告書・建物状況調査の結果の概要）」の外側の括弧(1回だけ・2026-10-30)
    { ...sub(c, "08a", "", ["建物状況調査報告書", "建物状況調査の結果の概要"]), around: ["（", "）"] },
    sub(c, "08b", "作成年月日：", undefined, yy(c, "08b", "日")),
    write(c, "08c", "調査実施者："),
    head(c, "09", "⑨耐震診断及び地震に対する安全性に関する資料", YN),
    sub(c, "09a", "（保存している資料）", ["耐震基準適合証明書", "既存住宅性能評価書", "耐震診断結果報告書", "既存住宅売買瑕疵保険の付保証明書", "その他"], [fl(c, "09aName", v.otherDoc === "split" ? ")" : "）", { after: true, pre: "（資料名：" })], true),
    head(c, "10", "⑩住宅性能評価", YN),
    sub(c, "10a", "（保存している資料）", ["設計住宅性能評価書", "建設住宅性能評価書", "既存住宅性能評価書"], undefined, true),
    head(c, "11", "⑪建物新築時の資料及び分譲業者名"),
    sub(c, "11a", "建築確認済証：", HAS),
    sub(c, "11b", "設計図書：", HAS),
    sub(c, "11c", "検査済証：", HAS),
    write(c, "11d", v.built),
  ];
}

const status = (c: Ctx, key: string, label: string, choices: string[], text: string, lines?: number): FormEntry[] => [head(c, key, label, choices), write(c, `${key}a`, text, lines)];

const H: Ctx = { p: "h", only: ["house"] };
const U: Ctx = { p: "u", only: ["unit"] };

const HOUSE: FormEntry[] = [
  ...buildingItems(H, {
    reform: "⑤増改築･修繕･リフォーム･用途変更の履歴及び資料", asbestos: "⑦石綿使用調査結果の記録", asbestosDate: "調査年月日：",
    built: "分譲業者・宅建業者名：", fireArea: "箇所・状況:", otherDoc: "split",
  }),
  head(H, "12", "⑫境界について"),
  sub(H, "12a", "隣地との境界：", ["確認できた", "確認できない"]),
  write(H, "12b", "確認できない箇所："),
  sub(H, "12c", "取決め書：", YN),
  sub(H, "12d", "紛争:", YN, [fl(H, "12dText", "紛争の内容：")]),
  head(H, "13", "⑬越境について"),
  sub(H, "13a", "越境：", YNU),
  sub(H, "13b", "越境物：", ["塀", "フェンス", "擁壁", "建物", "植栽", "給水管", "排水管", "ガス管", "その他"], [fl(H, "13bOther", "）", { after: true, pre: "（" })], true),
  sub(H, "13c", "取決め書：", YN),
  sub(H, "13d", "紛争:", YN, [fl(H, "13dText", "紛争の内容：")]),
  write(H, "13e", "場所・状況："),
  head(H, "14", "⑭擁壁について", YN),
  { ...sub(H, "14a", "／所有者：", ["売主", "隣地所有者", "共有", "不明"], [fl(H, "14aDir", "側", { max: 20, after: true, pre: "方角:" })]), fieldsFirst: true },
  { ...sub(H, "14b", "／所有者：", ["売主", "隣地所有者", "共有", "不明"], [fl(H, "14bDir", "側", { max: 20, after: true, pre: "方角:" })]), fieldsFirst: true },
  sub(H, "14c", "取決め書：", YN),
  sub(H, "14d", "紛争：", YN, [fl(H, "14dText", "紛争の内容:")]),
  sub(H, "14e", "亀裂等の有無：", FOUND),
  write(H, "14f", "状況："),
  ...status(H, "15", "⑮地盤の沈下、軟弱", FOUND, "状況："),
  head(H, "16", "⑯土壌汚染に関する情報"),
  sub(H, "16a", "敷地の住宅以外（店舗・工場等）の用途での使用履歴", YNU, [...yy(H, "16a"), fl(H, "16aUse", "用途：")]),
  sub(H, "16b", "土壌汚染に関するその他の情報", YNU, [fl(H, "16bText", "内容：")]),
  head(H, "17", "⑰地中埋設物"),
  check(H, "17a", "発見していない"),
  // 「発見している」も □ を付けて選ぶ(見出しにしない・2026-10-30)。鍵は前からある 17b を変えずに 17c を足す。
  check(H, "17c", "発見している"),
  sub(H, "17b", "", ["旧建物基礎", "建物廃材", "浄化槽", "井戸", "その他"], [fl(H, "17bOther", "）", { after: true, pre: "（" }), fl(H, "17bPlace", "場所・状況／")], true),
  ...status(H, "18", "⑱騒音・振動・臭気等", YNU, "状況："),
  ...status(H, "19", "⑲電波障害", YNU, "状況："),
  ...status(H, "20", "⑳浸水等の被害", YNU, "状況："),
  ...status(H, "21", "㉑近隣の建築計画", YNU, "状況："),
  ...status(H, "22", "㉒売買物件に影響を及ぼすと思われる周辺施設", YNU, "内容："),
  ...status(H, "23", "㉓売買物件に影響を及ぼすと思われる過去に起きた事件・事故", YNU, "内容："),
  ...status(H, "24", "㉔近隣との申し合わせ事項", YNU, "内容："),
  head(H, "25", "㉕その他売主から買主に引き継ぐ事項"),
  write(H, "25a", "", 3),
  head(H, "99", "備考"),
  write(H, "99a", "", 4),
];

const UNIT: FormEntry[] = [
  { kind: "section", title: "表１ 物件の状況 本物件は通常の経年変化があるほか、下記のとおりの状況であります。", only: ["unit"] },
  ...buildingItems(U, {
    reform: "⑤改築・修繕・リフォーム・用途変更の履歴及び資料", asbestos: "⑦石綿使用調査結果の記録", asbestosDate: "調査年月日：",
    built: "分譲業者・宅建業者名：", fireArea: "箇所・状況：", otherDoc: "one",
  }),
  head(U, "12", "⑫土壌汚染に関する情報"),
  sub(U, "12a", "敷地の住宅以外（店舗・工場等）の用途での使用履歴", YNU, [...yy(U, "12a"), fl(U, "12aUse", "用途：")]),
  sub(U, "12b", "土壌汚染に関するその他の情報", YNU, [fl(U, "12bText", "内容：")]),
  ...status(U, "13", "⑬騒音・振動・臭気等", YNU, "状況："),
  // 書式には「備考：」が2つ(①〜⑬の後と⑳の後)。入力欄と Excel では範囲で見分ける(PDF は書式どおり・2026-10-30)
  { ...head(U, "98", "備考："), name: "備考（①〜⑬）" },
  write(U, "98a", "", 3),
  ...status(U, "14", "⑭近隣の建築計画", YNU, "状況："),
  ...status(U, "15", "⑮電波障害", YNU, "状況："),
  ...status(U, "16", "⑯浸水等の被害", YNU, "状況："),
  ...status(U, "17", "⑰売買物件に影響を及ぼすと思われる周辺施設", YNU, "内容："),
  ...status(U, "18", "⑱売買物件に影響を及ぼすと思われる過去に起きた事件・事故等", YNU, "内容："),
  ...status(U, "19", "⑲近隣との申し合わせ事項", YNU, "内容："),
  ...status(U, "20", "⑳その他売主から買主に引き継ぐ事項", YNU, "内容：", 3),
  { ...head(U, "99", "備考："), name: "備考（⑭〜⑳）" },
  write(U, "99a", "", 4),
  { kind: "section", title: "表２ 管理費・修繕積立金の変更予定", only: ["unit"] },
  ...status(U, "t1", "①管理費・修繕積立金等の変更予定", ["無", "協議中", "有"], "時期・金額："),
  ...status(U, "t2", "②大規模修繕の予定", ["無", "協議中", "有"], "時期・概要・臨時負担金の有無："),
  ...status(U, "t3", "③自治会費等", YN, "金額・支払方法："),
  head(U, "t4", "④管理組合集会における討議事項"),
  write(U, "t4a", "概要：", 3),
];

export const DISCLOSURE_FORM: FormDef = {
  key: "disclosure",
  tabs: { key: "kind", label: "種類", choices: (Object.keys(DISCLOSURE_KIND_LABELS) as DisclosureKind[]).map((k) => ({ value: k, label: DISCLOSURE_KIND_LABELS[k] })) },
  entries: [
    { kind: "item", key: "withGuide", label: "説明のページ（表紙と「ご記入にあたって」）", noPrint: true, choices: cs(["付ける", "付けない"]) },
    ...HOUSE,
    ...UNIT,
  ],
};
