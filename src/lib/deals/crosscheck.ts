import { jstDateString } from "./datetime";
import type { BasePropertyKind } from "./constants";

/**
 * 取引の数値照合。同じ意味の値を出どころごとに集めて比べる。純関数(読み込みは crosscheck-load.ts)。
 * - 件数に数えるのは「不一致」だけ。種類が違う・表記の違い・確認できない・片方が未入力は数えない。
 * - 区分の床面積は登記(内法)と契約(壁芯)を分ける。実測の土地と公簿の謄本も同じ扱い。
 * - 土地のある物件(戸建・土地・一棟)は土地と建物の全筆がそろって初めて担保と所有者を比べる。足りなければ照合OKと出さない。
 * ⚠謄本の所有者名は入力に入るが、結果には入れない(比べた結果だけを返す)。ログ・監査にも出さない。
 */

export type CrosscheckStatus = "match" | "mismatch" | "missing" | "kind_differs" | "notation_differs" | "unverifiable";
export type CrosscheckItemKey =
  | "area_registered" | "area_wall" | "area_kinds" | "area_floor" | "area_land" | "area_land_kinds"
  | "price" | "settlement_date" | "landlord_change_date" | "seller" | "mortgage";

export const CROSSCHECK_STATUS_LABELS: Record<CrosscheckStatus, string> = {
  match: "一致", mismatch: "不一致", missing: "片方が未入力", kind_differs: "種類が違う", notation_differs: "表記の違い(異体字)", unverifiable: "確認できない",
};

/** 注意の識別子。次のタスク(決済から逆算した段取り)から参照するので、変えない。 */
export const CROSSCHECK_NOTICE_IDS = {
  activeMortgage: "crosscheck.activeMortgage",
  registryStale: "crosscheck.registryStale",
  nameVariant: "crosscheck.nameVariant",
} as const;
export type CrosscheckNoticeId = (typeof CROSSCHECK_NOTICE_IDS)[keyof typeof CROSSCHECK_NOTICE_IDS];

export const SELLER_MISMATCH_MESSAGE = "登記名義人と売主が一致しません。相続登記・氏名変更登記などが決済までに必要か確認してください";
export const REGISTRY_STALE_MESSAGE = "謄本が古い可能性があります。決済前に最新の謄本で確認してください";
export const ACTIVE_MORTGAGE_MESSAGE = "抹消書類の手配を確認してください";
export const NAME_VARIANT_MESSAGE = "登記の表記(異体字)と違います。書類の表記を登記に合わせるか確認してください";
export const LANDLORD_DATE_MESSAGE = "変更日が決済日と違います(意図したものか確認)";

/** 謄本の種類。土地のある物件で、どちらが要るかを決める。 */
export type RegistrySide = "土地" | "建物";
export type RegistryUncertain = "unreadable" | "unclassified" | "too_many" | "no_full_certificate";
export const LANDED_REQUIRED_SIDES: Partial<Record<BasePropertyKind, readonly RegistrySide[]>> = {
  house: ["土地", "建物"], building: ["土地", "建物"], land: ["土地"],
};
export const isLandedKind = (k: BasePropertyKind | null): k is BasePropertyKind => !!k && !!LANDED_REQUIRED_SIDES[k];

const UNCERTAIN_TEXT: Record<RegistryUncertain, string> = {
  unreadable: "読めない謄本があります",
  unclassified: "土地か建物か判定できない謄本があります",
  too_many: "謄本が多く、すべてを確認できません",
  no_full_certificate: "全部事項の謄本が無い土地・建物があります",
};

/** 足りない・確かめられない謄本の説明。問題が無ければ null。 */
export function registryGapText(missing: readonly RegistrySide[], uncertain: RegistryUncertain | null): string | null {
  if (missing.length) return `${missing.join("・")}の謄本がありません`;
  return uncertain ? UNCERTAIN_TEXT[uncertain] : null;
}

/**
 * 登記でよく使う異体字と、そろえる先の字。名前の比較で「表記の違い」を見分けるためだけに使う。
 * ⚠一致にはしない(書類の表記を登記に合わせる必要があるため)。字を足すときはこの表に足す。
 */
export const NAME_VARIANTS: Readonly<Record<string, string>> = {
  "髙": "高", "﨑": "崎", "齋": "斎", "邊": "辺", "邉": "辺",
};

/** 取引の画面のタブ・物件の画面・発行した書類のどれを開くか。 */
export type CrosscheckLink =
  | { kind: "tab"; tab: "basic" | "property" | "parties" | "money" | "documents" }
  | { kind: "property"; tab?: "attachments" }
  | { kind: "document"; documentId: string };

export interface CrosscheckSource {
  key: string;
  label: string;
  /** 画面に出す値。空・確認できないときは null。 */
  value: string | null;
  state: "value" | "empty" | "unverifiable";
  /** そろえたあとの比べる値。値が無ければ null。 */
  compareKey: string | null;
  /** 発行した書類の出どころのときの種類(発行の前の確認で使う)。 */
  docType?: string;
  link?: CrosscheckLink;
}

export interface CrosscheckItem {
  key: CrosscheckItemKey;
  label: string;
  status: CrosscheckStatus;
  message: string | null;
  sources: CrosscheckSource[];
  /** 比べる値が残っていない過去の書類の数。 */
  legacyDocuments: number;
}

export interface CrosscheckNotice {
  id: CrosscheckNoticeId;
  message: string;
  /** 残っている担保の件数(activeMortgage だけ)。 */
  count?: number;
  /** 読めた謄本だけの件数で、ほかにも残っているかもしれない。 */
  partial?: boolean;
}

export interface CrosscheckResult {
  /** ok=比べた項目がすべて一致 / mismatch=不一致あり / incomplete=不一致は無いが要る謄本で確かめられていない / none=比べられた項目が無い */
  summary: "ok" | "mismatch" | "incomplete" | "none";
  mismatchCount: number;
  comparedCount: number;
  items: CrosscheckItem[];
  notices: CrosscheckNotice[];
  /** 照合に使った謄本(取り込んだ日と用途)。 */
  registries: { date: string; usedFor: string[] }[];
}

/** 謄本から読めた値。⚠owners.list に氏名が入る。 */
export type RegistryFacts =
  | { status: "none" }
  | { status: "unreadable" }
  /** 謄本を読む権限が無い(読んでいない)。 */
  | { status: "denied" }
  | {
    status: "ok";
    /** 土地のある物件で足りない謄本・確かめられない理由(それ以外の物件には無い)。 */
    missing?: RegistrySide[];
    uncertain?: RegistryUncertain | null;
    /** 土地のある物件で使った謄本(種類と取り込んだ日)。 */
    certificates?: { side: RegistrySide; createdAt: string }[];
    areas: { unit: string | null; land: string | null; building: string | null; attachmentCreatedAt: string } | null;
    rights: { activeRights: number; readable: boolean; attachmentCreatedAt: string } | null;
    owners: {
      list: { name: string; share: string | null }[]; confirmed: boolean;
      /** 使った謄本のうち古いほうの日(複数のとき)。 */
      attachmentCreatedAt: string;
      newestCreatedAt?: string;
      /** 土地と建物(筆)で所有者や持分が違う。 */
      differsAcross?: boolean;
    } | null;
  };

export interface CrosscheckDocument {
  price?: number | null;
  settlementDate?: string | null;
  floorArea?: number | null;
  landArea?: number | null;
  activeRights?: number | null;
}

/** 発行した書類(種類・出し分けごとの最新版)と、残っている値。残っていない項目は undefined。 */
export interface IssuedDocFacts extends CrosscheckDocument {
  documentId: string;
  docType: string;
  variant: string;
  version: number;
  title: string;
  issuedAt: string;
}

export interface CrosscheckInput {
  kindBase: BasePropertyKind | null;
  price: number | null;
  settlementDate: string | null;
  snapshot: { floorArea: number | null; landArea: number | null };
  /** 物件の無い取引・物件を見られない人は null。 */
  property: {
    exclusiveArea: unknown; exclusiveAreaRegistry: unknown; landArea: unknown; landAreaMethod: string | null; totalFloorArea: unknown;
  } | null;
  registry: RegistryFacts;
  /** 売主名を比べてよいか。謄本と所有者の閲覧の権限が無い人は denied(結果から名義を当てられないように)。 */
  sellerCompare: "allowed" | "denied";
  sellers: { name: string; shareNum: number | null; shareDen: number | null }[];
  documents: IssuedDocFacts[];
}

/**
 * 値の種類ごとに、値を使う書類(発行の写しに残す項目もこの表で決める)。
 * 鍵受領書のように価格を載せない書類は、あとで価格が変わっても食い違いにしない。
 */
export const CROSSCHECK_DOC_FIELDS: Record<"price" | "settlementDate" | "area" | "activeRights", readonly string[]> = {
  price: [
    "funding_plan", "business_plan", "mediation", "settlement_statement", "settlement_guide", "settlement_guide_seller",
    "balance_receipt", "oc_purchase_consult",
  ],
  settlementDate: [
    "settlement_statement", "settlement_guide", "settlement_guide_seller", "completion_confirmation", "contract_guide",
    "power_of_attorney", "prep_checklist", "checklist_settlement", "landlord_change_notice",
  ],
  area: ["business_plan", "mediation"],
  activeRights: ["checklist_settlement"],
};

// ---------- 表記をそろえる ----------

const nfkc = (v: string) => v.normalize("NFKC").replace(/\s+/g, "");

/** 面積を 100分の1㎡ の整数に(浮動小数の誤差を避ける)。読めないもの・坪は null(推測で換算しない)。 */
export function normalizeArea(v: unknown): number | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 0) return null;
  } else if (typeof v !== "string" && !(v && typeof v === "object" && "toString" in v)) {
    return null;
  }
  const s = nfkc(String(v)).replace(/平方メートル|m2|,/gi, "");
  const m = /^(\d+)(?:[.:・](\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export function normalizeYen(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = nfkc(v).replace(/[,¥\\円]/g, "");
  return /^\d+$/.test(s) ? Number(s) : null;
}

export function normalizeDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/.exec(nfkc(v));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 名前の比べる形。⚠異体字(髙と高など)はそろえない(foldNameVariants で別に見る)。 */
export function normalizeName(v: string): string {
  return nfkc(v).toLowerCase()
    .replace(/\(株\)/g, "株式会社").replace(/\(有\)/g, "有限会社").replace(/\(同\)/g, "合同会社");
}

/** 異体字をそろえた名前。そろえて初めて同じなら「表記の違い」。 */
export function foldNameVariants(v: string): string {
  return [...normalizeName(v)].map((c) => NAME_VARIANTS[c] ?? c).join("");
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const reduce = (num: number, den: number) => {
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
};

/** 「2分の1」「持分 ２分の１」「1/2」を約分した形に。読めなければ null。 */
export function parseShare(v: string | null | undefined): { num: number; den: number } | null {
  if (!v) return null;
  const s = nfkc(v);
  const ja = /(\d+)分の(\d+)/.exec(s);
  const slash = ja ? null : /(\d+)\/(\d+)/.exec(s);
  const [num, den] = ja ? [Number(ja[2]), Number(ja[1])] : slash ? [Number(slash[1]), Number(slash[2])] : [0, 0];
  return num > 0 && den > 0 ? reduce(num, den) : null;
}

// ---------- 出どころ ----------

const fmtArea = (h: number) => `${Math.floor(h / 100)}.${String(h % 100).padStart(2, "0")}㎡`;
const fmtYen = (n: number) => `${n.toLocaleString("en-US")}円`;

type Base = Pick<CrosscheckSource, "key" | "label" | "docType" | "link">;

/** 空か読めない値かを分ける。空=empty・読めない=unverifiable。 */
function sourceOf<T extends string | number>(
  base: Base, raw: unknown, norm: (v: unknown) => T | null, fmt: (v: T) => string,
): CrosscheckSource {
  if (raw === null || raw === undefined || raw === "") return { ...base, value: null, state: "empty", compareKey: null };
  const n = norm(raw);
  if (n === null) return { ...base, value: null, state: "unverifiable", compareKey: null };
  return { ...base, value: fmt(n), state: "value", compareKey: String(n) };
}

const areaSource = (base: Base, raw: unknown) => sourceOf(base, raw, normalizeArea, fmtArea);
const unverifiableSource = (base: Base): CrosscheckSource => ({ ...base, value: null, state: "unverifiable", compareKey: null });
const emptySource = (base: Base): CrosscheckSource => ({ ...base, value: null, state: "empty", compareKey: null });

const SNAPSHOT_LINK: CrosscheckLink = { kind: "tab", tab: "property" };
const PROPERTY_LINK: CrosscheckLink = { kind: "property" };
const REGISTRY_LINK: CrosscheckLink = { kind: "property", tab: "attachments" };
const DOCS_LINK: CrosscheckLink = { kind: "tab", tab: "documents" };

const jstDay = (iso: string) => jstDateString(new Date(iso));
const dayJa = (ymd: string) => ymd.replace(/-/g, "/");

function registryAreaSource(r: RegistryFacts, pick: "unit" | "land" | "building", label: string): CrosscheckSource {
  const base = { key: "registry", link: REGISTRY_LINK };
  if (r.status === "none") return emptySource({ ...base, label: `${label}(謄本)` });
  if (r.status !== "ok") return unverifiableSource({ ...base, label: `${label}(謄本)` });
  if (!r.areas) return emptySource({ ...base, label: `${label}(謄本)` });
  const named = `${label}(謄本・${dayJa(jstDay(r.areas.attachmentCreatedAt))} 取込)`;
  const v = r.areas[pick];
  return v === null ? unverifiableSource({ ...base, label: named }) : areaSource({ ...base, label: named }, v);
}

/** 書類の出どころ。その値を使う書類で値が残っていないものは legacy に数える(不一致にしない)。 */
function documentSources(
  docs: IssuedDocFacts[], field: "price" | "settlementDate" | "floorArea" | "landArea",
  make: (base: Base, raw: unknown) => CrosscheckSource,
): { sources: CrosscheckSource[]; legacy: number } {
  const usedBy = CROSSCHECK_DOC_FIELDS[field === "floorArea" || field === "landArea" ? "area" : field];
  const sources: CrosscheckSource[] = [];
  let legacy = 0;
  for (const d of docs) {
    if (!usedBy.includes(d.docType)) continue;
    const raw = d[field];
    if (raw === undefined) {
      legacy++;
      continue;
    }
    sources.push(make({
      key: `document:${d.documentId}`, label: `${d.title} 第${d.version}版(発行時)`, docType: d.docType,
      link: { kind: "document", documentId: d.documentId },
    }, raw));
  }
  return { sources, legacy };
}

function legacySource(n: number): CrosscheckSource[] {
  return n > 0 ? [unverifiableSource({ key: "legacy", label: `過去に発行した書類 ${n}件(値が残っていません)`, link: DOCS_LINK })] : [];
}

// ---------- 判定 ----------

function statusOf(sources: CrosscheckSource[]): CrosscheckStatus {
  const values = sources.filter((s) => s.state === "value");
  if (new Set(values.map((s) => s.compareKey)).size > 1) return "mismatch";
  if (values.length < 2) return sources.some((s) => s.state === "unverifiable") ? "unverifiable" : "missing";
  return sources.some((s) => s.state === "empty") ? "missing" : "match";
}

const MESSAGES: Partial<Record<CrosscheckStatus, string>> = {
  missing: "比べる相手の値がまだありません。",
  unverifiable: "確かめられない出どころがあります(値が読めない・過去に発行した書類など)。",
};

function compareItem(key: CrosscheckItemKey, label: string, sources: CrosscheckSource[], legacy = 0): CrosscheckItem {
  const status = statusOf(sources);
  let message = MESSAGES[status] ?? null;
  if (status === "mismatch") {
    // 書類を除いた元のデータどうしが一致していれば、発行のあとに値が変わった。
    const live = sources.filter((s) => s.state === "value" && !s.docType);
    message = new Set(live.map((s) => s.compareKey)).size > 1
      ? "出どころの値が一致しません。正しい値を確認してください。"
      : key === "price"
        ? "発行後に価格が変わっています。再発行が必要か確認してください"
        : "発行後に値が変わった書類があります。発行し直すか確認してください。";
  }
  return { key, label, status, message, sources, legacyDocuments: legacy };
}

function kindsItem(key: CrosscheckItemKey, label: string, message: string, a: CrosscheckSource, b: CrosscheckSource): CrosscheckItem | null {
  if (a.state !== "value" || b.state !== "value") return null;
  // どちらも物件の欄のことがあるので、この項目の中で出どころの鍵が重ならないようにする。
  return { key, label, status: "kind_differs", message, sources: [{ ...a, key: `a:${a.key}` }, { ...b, key: `b:${b.key}` }], legacyDocuments: 0 };
}

function areaItems(i: CrosscheckInput): CrosscheckItem[] {
  if (!i.kindBase) return [];
  const p = i.property;
  const out: CrosscheckItem[] = [];
  const snapshot = (raw: unknown, label: string) => areaSource({ key: "snapshot", label, link: SNAPSHOT_LINK }, raw);
  if (i.kindBase === "unit") {
    const reg = registryAreaSource(i.registry, "unit", "登記の専有面積");
    const propReg = p ? [areaSource({ key: "property", label: "物件の専有面積(登記簿)", link: PROPERTY_LINK }, p.exclusiveAreaRegistry)] : [];
    out.push(compareItem("area_registered", "専有面積(登記・内法)", [reg, ...propReg]));
    const docs = documentSources(i.documents, "floorArea", areaSource);
    const wall = [
      ...(p ? [areaSource({ key: "property", label: "物件の専有面積(壁芯)", link: PROPERTY_LINK }, p.exclusiveArea)] : []),
      snapshot(i.snapshot.floorArea, "取引の専有面積"),
      ...docs.sources, ...legacySource(docs.legacy),
    ];
    out.push(compareItem("area_wall", "専有面積(契約・壁芯)", wall, docs.legacy));
    const registered = [reg, ...propReg].find((s) => s.state === "value");
    const contract = wall.find((s) => s.state === "value");
    const kinds = registered && contract
      ? kindsItem("area_kinds", "専有面積(内法と壁芯)", "登記は内法、契約は壁芯で測るので、差があっても間違いではありません。", registered, contract)
      : null;
    if (kinds) out.push(kinds);
    return out;
  }
  if (i.kindBase === "house" || i.kindBase === "building") {
    const docs = documentSources(i.documents, "floorArea", areaSource);
    out.push(compareItem("area_floor", "建物の床面積", [
      registryAreaSource(i.registry, "building", "登記の床面積"),
      ...(p ? [areaSource({ key: "property", label: "物件の建物面積", link: PROPERTY_LINK }, p.totalFloorArea)] : []),
      snapshot(i.snapshot.floorArea, "取引の延床面積"), ...docs.sources, ...legacySource(docs.legacy),
    ], docs.legacy));
  }
  const docs = documentSources(i.documents, "landArea", areaSource);
  const reg = registryAreaSource(i.registry, "land", "登記の地積");
  // 実測の土地は公簿(謄本)と測り方が違う。実測の値どうしだけを比べる。
  const surveyed = !!p?.landAreaMethod && /実測/.test(p.landAreaMethod);
  const propLand = p ? [areaSource({ key: "property", label: "物件の土地面積", link: PROPERTY_LINK }, p.landArea)] : [];
  out.push(compareItem("area_land", "土地の面積", [
    ...(surveyed ? [] : [reg]), ...propLand, snapshot(i.snapshot.landArea, "取引の土地面積"), ...docs.sources, ...legacySource(docs.legacy),
  ], docs.legacy));
  if (surveyed && propLand[0]) {
    const kinds = kindsItem("area_land_kinds", "土地の面積(公簿と実測)", "謄本は公簿、物件は実測の面積なので、差があっても間違いではありません。", reg, propLand[0]);
    if (kinds) out.push(kinds);
  }
  return out;
}

function priceItem(i: CrosscheckInput): CrosscheckItem {
  const make = (b: Base, raw: unknown) => sourceOf(b, raw, normalizeYen, fmtYen);
  const docs = documentSources(i.documents, "price", make);
  return compareItem("price", "売買価格", [
    make({ key: "deal", label: "取引の売買価格", link: { kind: "tab", tab: "money" } }, i.price),
    ...docs.sources, ...legacySource(docs.legacy),
  ], docs.legacy);
}

function dateItems(i: CrosscheckInput): CrosscheckItem[] {
  const make = (b: Base, raw: unknown) => sourceOf(b, raw, normalizeDate, dayJa);
  const deal = make({ key: "deal", label: "取引の決済日", link: { kind: "tab", tab: "basic" } }, i.settlementDate);
  const docs = documentSources(i.documents, "settlementDate", make);
  // 賃貸人の変更日は、翌月1日など決済日と別の日にすることがある。違っても不一致にしない。
  const differs = (s: CrosscheckSource) => s.docType === "landlord_change_notice" && deal.state === "value" && s.state === "value" && s.compareKey !== deal.compareKey;
  const items = [compareItem("settlement_date", "決済日", [deal, ...docs.sources.filter((s) => !differs(s)), ...legacySource(docs.legacy)], docs.legacy)];
  for (const s of docs.sources.filter(differs)) {
    const kinds = kindsItem("landlord_change_date", "賃貸人の変更日", LANDLORD_DATE_MESSAGE, deal, s);
    if (kinds) items.push(kinds);
  }
  return items;
}

const sameShare = (a: { num: number; den: number }, b: { num: number; den: number }) => a.num === b.num && a.den === b.den;
const WHOLE = { num: 1, den: 1 };

/** 売主の持分と謄本の持分。 */
function shareResult(i: CrosscheckInput, owners: { name: string; share: string | null }[]): "ok" | "unread" | "unentered" | "differs" {
  const ofSeller = (s: { shareNum: number | null; shareDen: number | null }) =>
    (s.shareNum && s.shareDen ? reduce(s.shareNum, s.shareDen) : null);
  if (owners.length === 1) {
    const s = ofSeller(i.sellers[0]);
    return s && !sameShare(s, WHOLE) ? "differs" : "ok";
  }
  // 同じ名前の共有者がいると、どの持分か決められない。
  const keys = owners.map((o) => foldNameVariants(o.name));
  if (new Set(keys).size !== keys.length) return "unread";
  const shares = new Map(owners.map((o) => [foldNameVariants(o.name), parseShare(o.share)]));
  if ([...shares.values()].some((s) => s === null)) return "unread";
  let unentered = false;
  for (const seller of i.sellers) {
    const mine = ofSeller(seller);
    if (!mine) {
      unentered = true;
      continue;
    }
    const theirs = shares.get(foldNameVariants(seller.name));
    if (theirs && !sameShare(mine, theirs)) return "differs";
  }
  return unentered ? "unentered" : "ok";
}

/** 担保と所有者を比べるのに要る謄本が足りないときの説明。足りていれば null。 */
function coverageGap(i: CrosscheckInput): string | null {
  // 種類が決まらないと、土地と建物のどちらの謄本が要るか決められない(1通だけで安心させない)。
  if (!i.kindBase) return "物件の種類が未選択のため、必要な謄本を判定できません";
  const required = LANDED_REQUIRED_SIDES[i.kindBase];
  if (!required) return null;
  const r = i.registry;
  if (r.status === "none") return registryGapText(required, null);
  if (r.status === "unreadable") return UNCERTAIN_TEXT.unreadable;
  if (r.status === "denied") return null;
  return registryGapText(r.missing ?? [], r.uncertain ?? null);
}

function sellerItem(i: CrosscheckInput): CrosscheckItem {
  const sellerSource: CrosscheckSource = i.sellers.length
    ? { key: "party", label: "当事者の売主", value: i.sellers.map((s) => s.name).join("、"), state: "value", compareKey: null, link: { kind: "tab", tab: "parties" } }
    : emptySource({ key: "party", label: "当事者の売主", link: { kind: "tab", tab: "parties" } });
  const hidden = "(名前は表示しません)";
  const regBase = { key: "registry", label: "謄本の登記名義人", link: REGISTRY_LINK };
  const done = (status: CrosscheckStatus, message: string | null, reg: CrosscheckSource): CrosscheckItem => (
    { key: "seller", label: "売主名", status, message, sources: [sellerSource, reg], legacyDocuments: 0 }
  );
  if (i.sellerCompare === "denied") {
    return done("unverifiable", "権限がないため確認できません。", unverifiableSource(regBase));
  }
  const gap = coverageGap(i);
  if (gap) return done("unverifiable", `確認できない(${gap})`, unverifiableSource(regBase));
  const reg = i.registry;
  if (reg.status === "none" || (reg.status === "ok" && !reg.owners)) {
    return done("missing", "所有者を確かめられる謄本がありません。", emptySource(regBase));
  }
  if (reg.status !== "ok" || !reg.owners) return done("unverifiable", "謄本から所有者を判定できませんでした。", unverifiableSource(regBase));
  const named = { ...regBase, label: `謄本の登記名義人(${dayJa(jstDay(reg.owners.attachmentCreatedAt))} 取込)` };
  const shown: CrosscheckSource = { ...named, value: hidden, state: "value", compareKey: null };
  if (!reg.owners.confirmed || reg.owners.list.length === 0) {
    return done("unverifiable", "謄本から所有者を判定できませんでした。謄本を見て確認してください。", unverifiableSource(named));
  }
  if (!i.sellers.length) return done("missing", "当事者の売主がまだ入っていません。", shown);
  // 決済のあとに取り込んだ謄本は買主の名義になっていることがある。
  if (i.settlementDate && jstDay(reg.owners.newestCreatedAt ?? reg.owners.attachmentCreatedAt) > i.settlementDate) {
    return done("unverifiable", "決済日より後に取り込んだ謄本のため、売主とは比べていません。", unverifiableSource(named));
  }
  const ownerList = reg.owners.list;
  const same = (norm: (v: string) => string) => {
    const a = i.sellers.map((s) => norm(s.name)).sort();
    const b = ownerList.map((o) => norm(o.name)).sort();
    return a.length === b.length && a.every((n, idx) => n === b[idx]);
  };
  if (!same(foldNameVariants)) return done("mismatch", SELLER_MISMATCH_MESSAGE, shown);
  if (reg.owners.differsAcross) {
    return done("unverifiable", "名前は一致しています。土地と建物で所有者または持分が違うため、謄本を見て確認してください。", shown);
  }
  const share = shareResult(i, ownerList);
  // 異体字だけの違いは一致にも不一致にもしない(書類の表記を登記に合わせるかは人が決める)。
  if (!same(normalizeName) && share !== "differs") {
    const note = share === "unentered" ? "当事者の持分が未入力です。" : share === "unread" ? "謄本の持分を読めなかったため、持分は比べていません。" : "";
    return done("notation_differs", note ? `${NAME_VARIANT_MESSAGE}。${note}` : NAME_VARIANT_MESSAGE, shown);
  }
  switch (share) {
    case "differs": return done("mismatch", "登記名義人の持分と当事者の持分が一致しません。持分を確認してください。", shown);
    case "unentered": return done("missing", "名前は一致しています。当事者の持分が未入力です。", shown);
    case "unread": return done("match", "名前は一致しています。謄本の持分を読めなかったため、持分は比べていません。", shown);
    default: return done("match", null, shown);
  }
}

function mortgageItem(i: CrosscheckInput): CrosscheckItem {
  const count = (b: Base, raw: unknown) => sourceOf(b, raw, (v) => (typeof v === "number" ? v : null), (n) => `${n}件`);
  const regBase = { key: "registry", label: "謄本の残っている乙区の権利", link: REGISTRY_LINK };
  const check = i.documents.find((d) => d.docType === "checklist_settlement");
  const checkBase: Base = check
    ? { key: `document:${check.documentId}`, label: `${check.title} 第${check.version}版の抹消の項目`, docType: check.docType, link: { kind: "document", documentId: check.documentId } }
    : { key: "document", label: "書類確認書(決済時)の抹消の項目", link: DOCS_LINK };
  const docSource = !check ? emptySource(checkBase)
    : check.activeRights === undefined ? unverifiableSource(checkBase) : count(checkBase, check.activeRights);
  const r = i.registry;
  const reg = r.status === "none" || (r.status === "ok" && !r.rights)
    ? emptySource(regBase)
    : r.status !== "ok" || !r.rights || !r.rights.readable
      ? unverifiableSource(regBase)
      : count({ ...regBase, label: `${regBase.label}(${dayJa(jstDay(r.rights.attachmentCreatedAt))} 取込)` }, r.rights.activeRights);
  const gap = coverageGap(i);
  if (gap) return { key: "mortgage", label: "有効な担保", status: "unverifiable", message: `確認できない(${gap})`, sources: [unverifiableSource(regBase), docSource], legacyDocuments: 0 };
  const item = compareItem("mortgage", "有効な担保", [reg, docSource]);
  if (item.status === "mismatch") {
    return { ...item, message: "謄本の権利の件数と、書類確認書を発行したときの件数が違います。謄本を確認して発行し直してください。" };
  }
  return item;
}

/** 決済日の3か月前(短い月は月末に寄せる)。 */
function threeMonthsBefore(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 - 3, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}

function registriesUsed(r: RegistryFacts): { date: string; usedFor: string[] }[] {
  if (r.status !== "ok") return [];
  const out: { date: string; usedFor: string[] }[] = [];
  if (r.certificates) {
    for (const c of r.certificates) {
      const date = jstDay(c.createdAt);
      const hit = out.find((x) => x.date === date);
      if (!hit) out.push({ date, usedFor: [c.side] });
      else if (!hit.usedFor.includes(c.side)) hit.usedFor.push(c.side);
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }
  const add = (iso: string, use: string) => {
    const date = jstDay(iso);
    const hit = out.find((x) => x.date === date);
    if (hit) hit.usedFor.push(use);
    else out.push({ date, usedFor: [use] });
  };
  if (r.areas) add(r.areas.attachmentCreatedAt, "面積");
  if (r.rights) add(r.rights.attachmentCreatedAt, "担保");
  if (r.owners) add(r.owners.attachmentCreatedAt, "売主名");
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function buildCrosscheck(input: CrosscheckInput): CrosscheckResult {
  const items = [...areaItems(input), priceItem(input), ...dateItems(input), sellerItem(input), mortgageItem(input)];
  const mismatchCount = items.filter((i) => i.status === "mismatch").length;
  const comparedCount = mismatchCount + items.filter((i) => i.status === "match" || i.status === "notation_differs").length;
  const registries = registriesUsed(input.registry);
  const notices: CrosscheckNotice[] = [];
  const r = input.registry;
  const gap = coverageGap(input);
  // 片方の謄本しか読めなくても、見つかった権利の手配は要る。
  if (r.status === "ok" && r.rights && r.rights.activeRights > 0) {
    notices.push({
      id: CROSSCHECK_NOTICE_IDS.activeMortgage, message: ACTIVE_MORTGAGE_MESSAGE, count: r.rights.activeRights,
      ...(gap || !r.rights.readable ? { partial: true } : {}),
    });
  }
  if (items.some((i) => i.status === "notation_differs")) notices.push({ id: CROSSCHECK_NOTICE_IDS.nameVariant, message: NAME_VARIANT_MESSAGE });
  if (input.settlementDate) {
    const limit = threeMonthsBefore(input.settlementDate);
    if (registries.some((x) => x.date < limit)) notices.push({ id: CROSSCHECK_NOTICE_IDS.registryStale, message: REGISTRY_STALE_MESSAGE });
  }
  // 区分以外は、要る謄本で担保と所有者を確かめられていなければ照合OKと出さない。
  const unconfirmed = input.kindBase !== "unit" && (
    !!gap || r.status === "denied" || items.some((i) => (
      (i.key === "seller" && i.status === "unverifiable")
      // 謄本の権利を読めないとき。過去の書類の側だけが確認できないのは謄本の問題ではない。
      || (i.key === "mortgage" && i.sources.some((s) => s.key === "registry" && s.state === "unverifiable"))
    ))
  );
  return {
    summary: mismatchCount > 0 ? "mismatch" : comparedCount === 0 ? "none" : unconfirmed ? "incomplete" : "ok",
    mismatchCount, comparedCount, items, notices, registries,
  };
}

/**
 * 発行の前に確認に出す項目。これから出す書類の古い版だけが食い違いの元なら出さない
 * (直すための発行で毎回止めない)。
 */
export function issueWarnings(result: CrosscheckResult, docType: string): CrosscheckItem[] {
  return result.items.filter((i) => {
    if (i.status !== "mismatch") return false;
    if (!i.sources.some((s) => s.docType === docType)) return true;
    const others = i.sources.filter((s) => s.state === "value" && s.docType !== docType);
    return new Set(others.map((s) => s.compareKey)).size > 1;
  });
}
