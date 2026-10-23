/**
 * 書類の「段階」と「種類」の自動判別(純関数・DB も外部も触らない)。
 *
 * 発注者の要望(2026-10-23)「契約関係書類と決済関係書類の自動整理」。
 * 設計: docs/superpowers/specs/2026-10-23-doc-auto-organize-design.md
 *
 * 判別の順: ①ファイル名 → ②本文(PDF の抽出文字)の先頭 3,000 文字。
 * 見出し域(先頭 400 文字)で見つかれば high、それより後ろなら low。
 * ⚠「推測で埋めない」= どれにも当たらなければ null(=その他)。人が直せる。
 */

export const DOC_STAGES = [
  { code: "pre_contract", label: "契約前", short: "①" },
  { code: "contract", label: "契約関係", short: "②" },
  { code: "settlement", label: "決済関係", short: "③" },
  { code: "identity", label: "本人確認", short: "④" },
] as const;

export type DocStageCode = (typeof DOC_STAGES)[number]["code"];

export interface DocKind {
  code: string;
  label: string;
  stage: DocStageCode;
  /** 比べる形(normalizeForMatch 済み)の語。1つでも含めば候補。 */
  keywords: readonly string[];
}

/**
 * 種類の表。語はドライブに今あるファイル名(売買契約書・重要事項説明書・媒介契約書・
 * 付帯設備表・物件状況告知書・重要事項調査報告書・決済ご案内・精算金・取引完了確認書・
 * 領収書・区分所有者変更届・口座振替依頼書)を下敷きにしている。
 * ⚠「重要事項調査報告書」と「重要事項説明書」は別の種類。語は必ず全体で持つ。
 * ⚠領収書は表に入れず、下の RECEIPT_* で手付/残代金に振り分ける。
 */
export const DOC_KINDS: readonly DocKind[] = [
  // ① 契約前
  { code: "brokerage_agreement", label: "媒介契約書", stage: "pre_contract", keywords: ["媒介契約", "専任媒介", "一般媒介"] },
  { code: "mgmt_report", label: "重要事項調査報告書", stage: "pre_contract", keywords: ["重要事項調査報告書", "管理に係る重要事項"] },
  { code: "bylaws", label: "管理規約・使用細則", stage: "pre_contract", keywords: ["管理規約", "使用細則"] },
  { code: "appraisal_report", label: "査定書・査定報告書", stage: "pre_contract", keywords: ["査定報告", "査定書"] },
  // ② 契約関係
  { code: "sales_contract", label: "売買契約書", stage: "contract", keywords: ["売買契約書", "不動産売買契約"] },
  { code: "disclosure", label: "重要事項説明書", stage: "contract", keywords: ["重要事項説明書", "重説"] },
  { code: "fixtures_list", label: "付帯設備表", stage: "contract", keywords: ["付帯設備表", "設備表"] },
  { code: "condition_report", label: "物件状況告知書", stage: "contract", keywords: ["物件状況告知書", "物件状況報告書", "告知書"] },
  { code: "deposit_receipt", label: "手付金 領収書・預り証", stage: "contract", keywords: [] },
  // ③ 決済関係
  { code: "settlement_notice", label: "決済のご案内", stage: "settlement", keywords: ["決済ご案内", "決済のご案内", "決済案内"] },
  { code: "settlement_statement", label: "精算書", stage: "settlement", keywords: ["精算書", "精算金", "残金精算", "固定資産税精算"] },
  { code: "settlement_receipt", label: "領収書(残代金・仲介手数料)", stage: "settlement", keywords: [] },
  { code: "completion_confirmation", label: "取引完了確認書", stage: "settlement", keywords: ["取引完了確認"] },
  { code: "owner_change_forms", label: "区分所有者変更届・口座振替依頼書", stage: "settlement", keywords: ["区分所有者変更", "口座振替", "自動振込"] },
  { code: "key_handover", label: "鍵・引渡し関係", stage: "settlement", keywords: ["鍵引渡", "引渡確認", "引き渡し確認", "鍵の引"] },
  // ④ 本人確認
  { code: "identity_document", label: "本人確認書類", stage: "identity", keywords: ["運転免許", "マイナンバー", "在留カード", "本人確認", "パスポート", "健康保険証"] },
];

/** 領収書・預り証のしるし。見つかったら手付/残代金の文脈で振り分ける。 */
const RECEIPT_MARKERS = ["領収書", "領収証", "預り証"] as const;
const DEPOSIT_CONTEXT = ["手付"] as const;
const SETTLEMENT_CONTEXT = ["残代金", "残金", "仲介手数料", "精算"] as const;

/** 本文はここまでしか見ない(1ページ目相当)。 */
export const TEXT_SCAN_LIMIT = 3000;
/** 見出し域。ここで見つかれば high。 */
export const HEADING_ZONE = 400;

export type DocConfidence = "high" | "low" | "manual";

export interface DocClassification {
  kind: string;
  stage: DocStageCode;
  confidence: Exclude<DocConfidence, "manual">;
}

/** 比べる形: NFKC → 空白除去 → 小文字。保存には使わない。 */
export function normalizeForMatch(s: string): string {
  return s.normalize("NFKC").replace(/[\s　]/g, "").toLowerCase();
}

export function docKindByCode(code: string | null | undefined): DocKind | null {
  if (!code) return null;
  return DOC_KINDS.find((k) => k.code === code) ?? null;
}

export function docStageOfKind(code: string | null | undefined): DocStageCode | null {
  return docKindByCode(code)?.stage ?? null;
}

export function docStageLabel(stage: string | null | undefined): string {
  return DOC_STAGES.find((s) => s.code === stage)?.label ?? "その他";
}

interface Hit {
  kind: string;
  position: number;
  /** 名前だけの「領収書」のように、文脈が無くて仮に決めたもの。 */
  tentative: boolean;
}

function firstIndexOf(haystack: string, words: readonly string[]): number {
  let best = -1;
  for (const w of words) {
    const i = haystack.indexOf(w);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

/** 領収書・預り証の語があれば、手付/残代金の文脈で種類を決める。無ければ null。 */
function receiptHit(normalized: string): Hit | null {
  const receiptAt = firstIndexOf(normalized, RECEIPT_MARKERS);
  if (receiptAt < 0) return null;
  const depositAt = firstIndexOf(normalized, DEPOSIT_CONTEXT);
  const settlementAt = firstIndexOf(normalized, SETTLEMENT_CONTEXT);
  if (depositAt >= 0 && (settlementAt < 0 || depositAt <= settlementAt)) {
    return { kind: "deposit_receipt", position: receiptAt, tentative: false };
  }
  if (settlementAt >= 0) return { kind: "settlement_receipt", position: receiptAt, tentative: false };
  return { kind: "settlement_receipt", position: receiptAt, tentative: true };
}

/**
 * 1つの出どころの中で、最も前に出た種類を返す。
 * - 名前(`receiptFirst`=true): 領収書・預り証の語があればそれを優先
 *   (「媒介契約に基づく仲介手数料として_領収書」は領収書)。
 * - 本文(`receiptFirst`=false): 領収書もほかの語と同じく「最も前に出た語」で競わせる
 *   (決済のご案内の持ち物欄に「領収書」とあっても、ご案内のまま)。
 */
function bestHit(normalized: string, receiptFirst: boolean): Hit | null {
  const receipt = receiptHit(normalized);
  if (receipt && receiptFirst) return receipt;
  let best: Hit | null = receipt;
  for (const k of DOC_KINDS) {
    const at = firstIndexOf(normalized, k.keywords);
    if (at < 0) continue;
    if (best === null || at < best.position) best = { kind: k.code, position: at, tentative: false };
  }
  return best;
}

/**
 * ファイル名と本文から種類を決める。どれにも当たらなければ null。
 * - 名前で当たれば high(名前だけの「領収書」は low)
 * - 本文で当たれば、見出し域なら high・後ろなら low
 */
export function classifyDocument(input: { fileName: string; text?: string | null }): DocClassification | null {
  const byName = bestHit(normalizeForMatch(input.fileName), true);
  if (byName) {
    return {
      kind: byName.kind,
      stage: docStageOfKind(byName.kind) as DocStageCode,
      confidence: byName.tentative ? "low" : "high",
    };
  }
  const raw = input.text ?? "";
  if (raw === "") return null;
  const body = normalizeForMatch(raw.slice(0, TEXT_SCAN_LIMIT));
  const byText = bestHit(body, false);
  if (!byText) return null;
  return {
    kind: byText.kind,
    stage: docStageOfKind(byText.kind) as DocStageCode,
    confidence: byText.tentative || byText.position >= HEADING_ZONE ? "low" : "high",
  };
}
