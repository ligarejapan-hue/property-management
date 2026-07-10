import type { Rect } from "./layout-engine";
import type { SalesSheetElement } from "./document-schema";
import { COMPANY_INFO } from "./company-info";

/**
 * footer-band.ts
 *
 * 御社ひな型どおりの下部会社帯（会社ブロック／取引条件テーブル／担当テーブルの横並び
 * 固定高帯）を組む純関数。`computeSpecSheetLayout` が返す `footer` 矩形（帯の領域）と、
 * 図面ごとの取引条件・担当者情報（`FooterBandData`）から text/table/shape 要素群を
 * 組み立てる。会社情報の値そのものは `company-info.ts` の `COMPANY_INFO` に集約されて
 * おり、このモジュールはレイアウト（座標算出）のみを担う。エンジンへの結線
 * （`layout-engine.ts`/`build-document.ts` の改修）は別タスク。
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

/** 社名JPブロックの幅(mm)。 */
const NAME_JA_W_MM = 44;
/** 社名EN は社名JP（COMPANY_INFO.nameJa・定数長）の右に固定オフセット(mm)＝決定的。 */
const NAME_EN_OFFSET_MM = 46;
const NAME_EN_W_MM = 30;
/** TEL/FAX（社名の右）の x オフセット・幅(mm)。 */
const CONTACT_X_OFFSET_MM = 80;
const CONTACT_W_MM = 46;
/** 社名行の高さ(mm)。TEL/FAX 2行はこの行の中で均等割りする。 */
const NAME_ROW_H_MM = 6;
/** 社名行と情報グリッドの間の余白(mm)。 */
const GRID_TOP_GAP_MM = 1;
/** 情報グリッド左列の幅(mm)。右列は残り幅（取引条件テーブルの手前まで）を使う。 */
const GRID_LEFT_COL_W_MM = 76;
const GRID_COL_GAP_MM = 4;

const FONT_PT = {
  nameJa: 13,
  nameEn: 11,
  contact: 8,
  grid: 6.5,
  table: 7,
} as const;

/** 矩形を `footer` の内側へクランプする（幾何不変条件の最終防波堤・PAD計算の丸め誤差対策）。 */
function clampRect(r: Rect, footer: Rect): Rect {
  const x = Math.min(Math.max(r.x, footer.x), footer.x + footer.w);
  const y = Math.min(Math.max(r.y, footer.y), footer.y + footer.h);
  const w = Math.max(0, Math.min(r.w, footer.x + footer.w - x));
  const h = Math.max(0, Math.min(r.h, footer.y + footer.h - y));
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

/** 値のある行だけ残す（build-document.ts の companyFooterDetails と同じ falsy 落とし）。 */
function pickRows(pairs: [string, string | undefined][]): { label: string; value: string }[] {
  return pairs.filter((pair): pair is [string, string] => !!pair[1]).map(([label, value]) => ({ label, value }));
}

export function buildFooterBand(footer: Rect, data: FooterBandData): SalesSheetElement[] {
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

  // --- 会社ブロック（左） ---
  const companyContentX = companyX0 + PAD_MM;
  const companyContentTop = footer.y + PAD_MM;
  const companyContentBottom = footer.y + footer.h - PAD_MM;

  elements.push(
    mkText(
      "footer-name-ja",
      clampRect({ x: companyContentX, y: companyContentTop, w: NAME_JA_W_MM, h: NAME_ROW_H_MM }, footer),
      COMPANY_INFO.nameJa,
      FONT_PT.nameJa,
      { bold: true },
    ),
  );
  elements.push(
    mkText(
      "footer-name-en",
      // 社名ENは社名JPの右に固定オフセット（COMPANY_INFO.nameJaは定数長ゆえ決定的）。
      clampRect(
        { x: companyContentX + NAME_EN_OFFSET_MM, y: companyContentTop, w: NAME_EN_W_MM, h: NAME_ROW_H_MM },
        footer,
      ),
      COMPANY_INFO.nameEn,
      FONT_PT.nameEn,
      { bold: true },
    ),
  );

  const contactX = companyContentX + CONTACT_X_OFFSET_MM;
  const contactLineH = NAME_ROW_H_MM / 2;
  elements.push(
    mkText(
      "footer-tel",
      clampRect({ x: contactX, y: companyContentTop, w: CONTACT_W_MM, h: contactLineH }, footer),
      `TEL ${COMPANY_INFO.tel}`,
      FONT_PT.contact,
    ),
  );
  elements.push(
    mkText(
      "footer-fax",
      clampRect({ x: contactX, y: companyContentTop + contactLineH, w: CONTACT_W_MM, h: contactLineH }, footer),
      `FAX ${COMPANY_INFO.fax}`,
      FONT_PT.contact,
    ),
  );

  // 情報グリッド（社名行の下・2列×3行）。左列=免許/協会系（既にラベル込みの値）、
  // 右列=Email/HP/所在地（値そのものにラベルが無いためここで付与）。
  const gridY0 = companyContentTop + NAME_ROW_H_MM + GRID_TOP_GAP_MM;
  const gridRowH = Math.max(0, (companyContentBottom - gridY0) / 3);
  const gridRightX = companyContentX + GRID_LEFT_COL_W_MM + GRID_COL_GAP_MM;
  const gridRightW = Math.max(0, termsX0 - GAP_MM - gridRightX);

  const gridLeft: [string, string][] = [
    ["footer-license", COMPANY_INFO.license],
    ["footer-guarantee", COMPANY_INFO.guaranteeAssoc],
    ["footer-member", COMPANY_INFO.memberAssoc],
  ];
  const gridRight: [string, string][] = [
    ["footer-email", `Email ${COMPANY_INFO.email}`],
    ["footer-hp", `H　P ${COMPANY_INFO.hp}`],
    ["footer-address", `所在地 ${COMPANY_INFO.address}`],
  ];
  gridLeft.forEach(([id, content], i) => {
    elements.push(
      mkText(
        id,
        clampRect({ x: companyContentX, y: gridY0 + i * gridRowH, w: GRID_LEFT_COL_W_MM, h: gridRowH }, footer),
        content,
        FONT_PT.grid,
      ),
    );
  });
  gridRight.forEach(([id, content], i) => {
    elements.push(
      mkText(
        id,
        clampRect({ x: gridRightX, y: gridY0 + i * gridRowH, w: gridRightW, h: gridRowH }, footer),
        content,
        FONT_PT.grid,
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
