import type { Rect } from "./layout-engine";
import type { SalesSheetElement } from "./document-schema";
import { COMPANY_INFO } from "./company-info";
import type { CompanyProfile } from "./company-profile-store";

/**
 * footer-band.ts
 *
 * 御社ひな型どおりの下部会社帯（会社ブロック／取引条件テーブル／担当テーブルの横並び
 * 固定高帯）を組む純関数。`computeSpecSheetLayout` が返す `footer` 矩形（帯の領域）と、
 * 図面ごとの取引条件・担当者情報（`FooterBandData`）から text/table/shape 要素群を
 * 組み立てる。会社情報の値は第3引数 `company`（`CompanyProfile`）で受け取り、未指定時は
 * `company-info.ts` の `COMPANY_INFO` を既定値とする。このモジュールはレイアウト
 * （座標算出）のみを担う。DBからの解決（`company-profile-store.ts`）・エンジンへの結線
 * （`build-document.ts` の改修）は別タスク。
 *
 * 前提: `footer` は実運用サイズ（≈幅277×高24mm＝`COMPANY_W_MM`×`DEFAULT_FOOTER_H`）を想定。
 * それより極端に小さい矩形では各スロットが縮退しうるが、出力要素の w/h は常に正（schema
 * 準拠＝保存時 422 回避）に保つ（`clampRect` の `MIN_DIM_MM` ハネ止め）。
 *
 * 二重レンダラ（render-html.ts / SalesSheetRenderer.tsx）は無改修が制約のため、縦の
 * 区切り線は `shape:"line"` でなく `shape:"rect"`（細幅の塗り矩形）で表す。両レンダラの
 * "line" 実装は CSS の height を常に `strokeWidthMm`（既定0.3mm）へ強制上書きする横線
 * 専用の実装（width=el.w がそのまま出る一方、height は el.h を無視して薄く固定される）
 * で、height 優位＝縦向きの線を描けないため（実装前に両レンダラのソースで確認済）。
 * "shape" 種別自体は既存の閉じた element 種別セットの範囲内であり、新種別は追加しない。
 */

export interface FooterBandData {
  transactionType?: string; // 取引態様（例: 仲介）
  adType?: string; // 広告（例: 不可）
  compensation?: string; // 報酬（例: 相談）
  staff?: string; // 担当者
  agent?: string; // 取引士
  specialNotes?: string; // 特記事項
}

const NAVY = "#15324f";
/** 帯の下地色（枠 fill）＝「色付き帯」。 */
const BAND_FILL = "#f7f9fb";
/** 取引条件／担当テーブルの罫線色。 */
const TABLE_BORDER_COLOR = "#999999";

/** 横3分割の比率（会社ブロック／取引条件テーブル）。担当は残り幅（footer.w 基準）。 */
const COMPANY_W_RATIO = 0.55;
const TERMS_W_RATIO = 0.16;

/** 帯外周から内容までの余白／各スロットと区切り線の間の余白(mm)。 */
const PAD_MM = 2;
const GAP_MM = 2;

/** 縦区切り線（shape:"rect" の細幅塗り）の太さ(mm)。 */
const DIVIDER_W_MM = 0.3;
/** 帯外周の枠線太さ(mm)。 */
const FRAME_STROKE_W_MM = 0.3;

/** 会社ブロックは 3行×2列で組む。左列の幅(mm)。右列は残り幅（取引条件テーブルの手前まで）を使う。
 *  render-html は overflow:hidden で box をはみ出す文字を切るため、各値が収まる幅にする。 */
const GRID_LEFT_COL_W_MM = 76;
/** 左右列の間の余白(mm)。 */
const GRID_COL_GAP_MM = 4;

const FONT_PT = {
  nameJa: 13,
  contact: 8,
  grid: 6.5,
  table: 7,
} as const;

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

function mkText(
  id: string,
  rect: Rect,
  content: string,
  fontSizePt: number,
  opts: { bold?: boolean } = {},
): SalesSheetElement {
  return {
    id,
    type: "text",
    ...rect,
    z: 2,
    content,
    style: { fontSizePt, color: NAVY, bold: opts.bold ?? false },
  };
}

/** 縦区切り線。"line" ではなく細幅の塗り "rect"（モジュール冒頭コメント参照）。 */
function mkDivider(id: string, rect: Rect): SalesSheetElement {
  return {
    id,
    type: "shape",
    ...rect,
    z: 1,
    shape: "rect",
    fill: NAVY,
  };
}

/** 値のある行だけ残す（build-document.ts の各 buildSale*Document と同じ falsy 落とし）。 */
function pickRows(pairs: [string, string | undefined][]): { label: string; value: string }[] {
  return pairs.filter((pair): pair is [string, string] => !!pair[1]).map(([label, value]) => ({ label, value }));
}

export function buildFooterBand(
  footer: Rect,
  data: FooterBandData,
  company: CompanyProfile = COMPANY_INFO,
): SalesSheetElement[] {
  const companyW = Math.round(footer.w * COMPANY_W_RATIO);
  const termsW = Math.round(footer.w * TERMS_W_RATIO);
  const staffW = footer.w - companyW - termsW;

  const companyX0 = footer.x;
  const termsX0 = footer.x + companyW;
  const staffX0 = footer.x + companyW + termsW;

  const hasStaff = !!(data.staff || data.agent || data.specialNotes);

  const elements: SalesSheetElement[] = [];

  // 帯外周（色付き帯）。z=1＝最背面。
  elements.push({
    id: "footer-band",
    type: "shape",
    ...clampRect({ x: footer.x, y: footer.y, w: footer.w, h: footer.h }, footer),
    z: 1,
    shape: "rect",
    fill: BAND_FILL,
    stroke: NAVY,
    strokeWidthMm: FRAME_STROKE_W_MM,
  });

  // --- 会社ブロック（左・3行×2列でぎっしり詰める） ---
  // 左列=社名(大)/免許/所在地、右列=TEL・FAX(1行)/Email/HP。旧2行の間延びと社名行の空白を解消。
  const companyContentX = companyX0 + PAD_MM;
  const companyContentTop = footer.y + PAD_MM;
  const companyContentBottom = footer.y + footer.h - PAD_MM;
  const rowH = Math.max(0, (companyContentBottom - companyContentTop) / 3);
  const leftColW = GRID_LEFT_COL_W_MM;
  const rightColX = companyContentX + leftColW + GRID_COL_GAP_MM;
  const rightColW = Math.max(0, termsX0 - GAP_MM - rightColX);

  const companyLeft: [string, string, number][] = [
    ["footer-name-ja", company.nameJa, FONT_PT.nameJa],
    ["footer-license", company.license, FONT_PT.grid],
    ["footer-address", `所在地 ${company.address}`, FONT_PT.grid],
  ];
  const companyRight: [string, string, number][] = [
    ["footer-contact", `TEL ${company.tel}　FAX ${company.fax}`, FONT_PT.contact],
    ["footer-email", `Email ${company.email}`, FONT_PT.grid],
    ["footer-hp", `H　P ${company.hp}`, FONT_PT.grid],
  ];
  companyLeft.forEach(([id, content, fontPt], i) => {
    elements.push(
      mkText(
        id,
        clampRect({ x: companyContentX, y: companyContentTop + i * rowH, w: leftColW, h: rowH }, footer),
        content,
        fontPt,
        { bold: id === "footer-name-ja" },
      ),
    );
  });
  companyRight.forEach(([id, content, fontPt], i) => {
    elements.push(
      mkText(
        id,
        clampRect({ x: rightColX, y: companyContentTop + i * rowH, w: rightColW, h: rowH }, footer),
        content,
        fontPt,
      ),
    );
  });

  // --- 区切り線（会社|取引条件）。常に表示。 ---
  elements.push(
    mkDivider(
      "footer-divider-terms",
      clampRect({ x: termsX0, y: footer.y + PAD_MM, w: DIVIDER_W_MM, h: footer.h - PAD_MM * 2 }, footer),
    ),
  );

  // --- 取引条件テーブル（中央）。常に表示（値が無ければ空行1つで枠のみ出す）。 ---
  const termsRows = pickRows([
    ["取引態様", data.transactionType],
    ["広告", data.adType],
    ["報酬", data.compensation],
  ]);
  elements.push({
    id: "footer-terms-table",
    type: "table",
    ...clampRect(
      { x: termsX0 + GAP_MM, y: footer.y + PAD_MM, w: termsW - GAP_MM * 2, h: footer.h - PAD_MM * 2 },
      footer,
    ),
    z: 2,
    rows: termsRows.length > 0 ? termsRows : [{ label: "", value: "" }],
    style: { fontSizePt: FONT_PT.table, labelColor: NAVY, borderColor: TABLE_BORDER_COLOR },
  });

  // --- 担当テーブル（右）。担当/取引士/特記事項が全空なら省略（コンパクト版・右区切り線も省略）。 ---
  if (hasStaff) {
    elements.push(
      mkDivider(
        "footer-divider-staff",
        clampRect({ x: staffX0, y: footer.y + PAD_MM, w: DIVIDER_W_MM, h: footer.h - PAD_MM * 2 }, footer),
      ),
    );

    const staffRows = pickRows([
      ["担当", data.staff],
      ["取引士", data.agent],
      ["特記事項", data.specialNotes],
    ]);
    elements.push({
      id: "footer-staff-table",
      type: "table",
      ...clampRect(
        { x: staffX0 + GAP_MM, y: footer.y + PAD_MM, w: staffW - GAP_MM * 2, h: footer.h - PAD_MM * 2 },
        footer,
      ),
      z: 2,
      rows: staffRows,
      style: { fontSizePt: FONT_PT.table, labelColor: NAVY, borderColor: TABLE_BORDER_COLOR },
    });
  }

  return elements;
}
