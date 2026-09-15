import type { Rect } from "./layout-engine";
import type { SalesSheetElement } from "./document-schema";
import { COMPANY_INFO } from "./company-info";
import type { CompanyProfile } from "./company-profile-store";
import { CONSUMER_COLORS } from "./consumer-theme";

/**
 * footer-band.ts
 *
 * 消費者向けひな型(2026-09)の下部会社帯（仕様書 §4.6）を組む純関数。`CONSUMER_FOOTER`
 * （`layout-engine.ts`）の矩形と、図面ごとの取引条件・担当者情報（`FooterBandData`）から
 * text/table/shape 要素群を組み立てる。会社情報の値は第3引数 `company`（`CompanyProfile`）
 * で受け取り、未指定時は `company-info.ts` の `COMPANY_INFO` を既定値とする。このモジュールは
 * レイアウト（座標算出）のみを担う。DBからの解決は `company-profile-store.ts`。
 *
 * 前提: `footer` は実運用サイズ（`CONSUMER_FOOTER`）を想定。それより極端に小さい矩形では
 * 各スロットが縮退しうるが、出力要素の w/h は常に正（schema 準拠＝保存時 422 回避）に保つ
 * （`clampRect` の `MIN_DIM_MM` ハネ止め）。
 */

export interface FooterBandData {
  transactionType?: string; // 取引態様（例: 仲介）
  adType?: string; // 広告（例: 不可）
  compensation?: string; // 報酬（例: 相談）
  staff?: string; // 担当者
  agent?: string; // 取引士
  specialNotes?: string; // 特記事項
}

/** w/h の下限(mm)。document-schema は w/h を「正数」必須とするため、想定外に小さい footer
 *  でも 0 を出さないハネ止め（実運用の footer=277×24 では発火しない）。 */
const MIN_DIM_MM = 0.1;

/** 矩形を `footer` の内側へクランプする（幾何不変条件の最終防波堤・PAD計算の丸め誤差対策）。
 *  w/h は schema 準拠のため厳密に正へ丸め、その分 x/y を内側へ引いて footer をはみ出さない。 */
function clampRect(r: Rect, footer: Rect): Rect {
  const right = footer.x + footer.w;
  const bottom = footer.y + footer.h;
  let x = Math.min(Math.max(r.x, footer.x), right);
  let y = Math.min(Math.max(r.y, footer.y), bottom);
  let w = Math.max(0, Math.min(r.w, right - x));
  let h = Math.max(0, Math.min(r.h, bottom - y));
  if (w < MIN_DIM_MM) {
    w = Math.min(MIN_DIM_MM, footer.w);
    x = Math.min(x, right - w);
  }
  if (h < MIN_DIM_MM) {
    h = Math.min(MIN_DIM_MM, footer.h);
    y = Math.min(y, bottom - h);
  }
  return { x, y, w, h };
}

/** 値のある行だけ残す（build-document.ts の各 buildSale*Document と同じ falsy 落とし）。 */
function pickRows(pairs: [string, string | undefined][]): { label: string; value: string }[] {
  return pairs.filter((pair): pair is [string, string] => !!pair[1]).map(([label, value]) => ({ label, value }));
}

/** 帯テーブルの行ラベル。生成(buildConsumerFooterTransactionElements)と復元(readFooterData)で共有。 */
const TERMS_LABELS = { transactionType: "取引態様", adType: "広告", compensation: "報酬" } as const;
const STAFF_LABELS = { staff: "担当", agent: "取引士", specialNotes: "特記事項" } as const;

/** document の帯テーブルから現在の6値を復元する(欠け・省略は "")。 */
export function readFooterData(elements: SalesSheetElement[]): FooterBandData {
  const terms = elements.find((e) => e.id === "footer-terms-table" && e.type === "table");
  const staff = elements.find((e) => e.id === "footer-staff-table" && e.type === "table");
  const read = (el: SalesSheetElement | undefined, label: string): string => {
    if (!el || el.type !== "table") return "";
    return el.rows.find((r) => r.label === label)?.value ?? "";
  };
  return {
    transactionType: read(terms, TERMS_LABELS.transactionType),
    adType: read(terms, TERMS_LABELS.adType),
    compensation: read(terms, TERMS_LABELS.compensation),
    staff: read(staff, STAFF_LABELS.staff),
    agent: read(staff, STAFF_LABELS.agent),
    specialNotes: read(staff, STAFF_LABELS.specialNotes),
  };
}

/** 6項目の等価判定(undefined と "" を同一視)。editFooterData の no-op 判定に使う。 */
export function footerDataEqual(a: FooterBandData, b: FooterBandData): boolean {
  const keys: (keyof FooterBandData)[] = [
    "transactionType",
    "adType",
    "compensation",
    "staff",
    "agent",
    "specialNotes",
  ];
  return keys.every((k) => (a[k] ?? "") === (b[k] ?? ""));
}

// ---------------------------------------------------------------------------
// 消費者向けひな型(2026-09)の会社帯。仕様書 §4.6。
// 左から 会社ブロック(105mm) / 取引6項目(表2つ) / 電話(72mm)。右端22mmは地図QRの置き場。
// 帯の外枠 footer-band は取引情報パネルが帯の位置を復元するため残す(白・線なし)。
// ---------------------------------------------------------------------------

export const CONSUMER_TEL_CTA = "内覧のご希望・ご質問はお電話で";

const CONSUMER_COMPANY_W_MM = 105;
const CONSUMER_TERMS_X_MM = 108;
const CONSUMER_STAFF_X_MM = 147;
const CONSUMER_TX_TABLE_W_MM = 36;
const CONSUMER_TEL_X_MM = 186;
const CONSUMER_TEL_W_MM = 72;
const CONSUMER_LINE_H_MM = 3.8;

function consumerText(
  id: string,
  rect: Rect,
  content: string,
  fontSizePt: number,
  opts: { bold?: boolean; color?: string; align?: "left" | "center" | "right"; lineHeight?: number } = {},
): SalesSheetElement {
  return {
    id,
    type: "text",
    ...rect,
    z: 2,
    content,
    style: {
      fontSizePt,
      color: opts.color ?? CONSUMER_COLORS.ink,
      bold: opts.bold ?? false,
      ...(opts.align ? { align: opts.align } : {}),
      ...(opts.lineHeight ? { lineHeight: opts.lineHeight } : {}),
    },
  };
}

/** 取引条件/担当の表(線なし)。作成時と取引情報パネルの再生成で共有する。 */
export function buildConsumerFooterTransactionElements(footer: Rect, data: FooterBandData): SalesSheetElement[] {
  const hasStaff = !!(data.staff || data.agent || data.specialNotes);
  const tableStyle = { fontSizePt: 7.5, labelColor: CONSUMER_COLORS.navy, valueColor: CONSUMER_COLORS.ink, borderless: true, cellPaddingMm: 0.4 };
  const termsRows = pickRows([
    [TERMS_LABELS.transactionType, data.transactionType],
    [TERMS_LABELS.adType, data.adType],
    [TERMS_LABELS.compensation, data.compensation],
  ]);
  const elements: SalesSheetElement[] = [
    {
      id: "footer-terms-table",
      type: "table",
      ...clampRect({ x: footer.x + CONSUMER_TERMS_X_MM, y: footer.y + 2, w: CONSUMER_TX_TABLE_W_MM, h: footer.h - 4 }, footer),
      z: 2,
      rows: termsRows.length > 0 ? termsRows : [{ label: "", value: "" }],
      style: tableStyle,
    },
  ];
  if (hasStaff) {
    elements.push({
      id: "footer-staff-table",
      type: "table",
      ...clampRect({ x: footer.x + CONSUMER_STAFF_X_MM, y: footer.y + 2, w: CONSUMER_TX_TABLE_W_MM, h: footer.h - 4 }, footer),
      z: 2,
      rows: pickRows([
        [STAFF_LABELS.staff, data.staff],
        [STAFF_LABELS.agent, data.agent],
        [STAFF_LABELS.specialNotes, data.specialNotes],
      ]),
      style: { ...tableStyle },
    });
  }
  return elements;
}

export function buildConsumerFooterBand(
  footer: Rect,
  data: FooterBandData,
  company: CompanyProfile = COMPANY_INFO,
): SalesSheetElement[] {
  const { x, y } = footer;
  const line = (i: number): number => y + 7 + CONSUMER_LINE_H_MM * i;
  const halfW = CONSUMER_COMPANY_W_MM / 2;
  return [
    { id: "footer-band", type: "shape", ...clampRect({ x, y, w: footer.w, h: footer.h }, footer), z: 1, shape: "rect", fill: CONSUMER_COLORS.white },
    consumerText("footer-name-ja", clampRect({ x, y: y + 1, w: CONSUMER_COMPANY_W_MM, h: 6 }, footer), company.nameJa, 10, { bold: true, color: CONSUMER_COLORS.navy }),
    consumerText("footer-license", clampRect({ x, y: line(0), w: CONSUMER_COMPANY_W_MM, h: CONSUMER_LINE_H_MM }, footer), company.license, 7),
    consumerText("footer-address", clampRect({ x, y: line(1), w: CONSUMER_COMPANY_W_MM, h: CONSUMER_LINE_H_MM }, footer), `所在地 ${company.address}`, 7),
    consumerText("footer-contact", clampRect({ x, y: line(2), w: CONSUMER_COMPANY_W_MM, h: CONSUMER_LINE_H_MM }, footer), `TEL ${company.tel}　FAX ${company.fax}`, 7),
    consumerText("footer-email", clampRect({ x, y: line(3), w: halfW, h: CONSUMER_LINE_H_MM }, footer), `Email ${company.email}`, 7),
    consumerText("footer-hp", clampRect({ x: x + halfW, y: line(3), w: halfW, h: CONSUMER_LINE_H_MM }, footer), `HP ${company.hp}`, 7),
    // 最下行(y+22.2〜25)は第③段の規約行のために空けておく。
    ...buildConsumerFooterTransactionElements(footer, data),
    consumerText("footer-tel-cta", clampRect({ x: x + CONSUMER_TEL_X_MM, y: y + 2, w: CONSUMER_TEL_W_MM, h: 5 }, footer), CONSUMER_TEL_CTA, 8, { bold: true, color: CONSUMER_COLORS.navy, align: "right" }),
    consumerText("footer-tel-number", clampRect({ x: x + CONSUMER_TEL_X_MM, y: y + 7, w: CONSUMER_TEL_W_MM, h: 10 }, footer), company.tel, 19, { bold: true, color: CONSUMER_COLORS.navy, align: "right", lineHeight: 1.2 }),
  ];
}
