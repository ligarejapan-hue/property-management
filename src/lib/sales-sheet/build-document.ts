import {
  A4_LANDSCAPE,
  type SalesSheetDocument,
  type SalesSheetElement,
} from "./document-schema";
import { inlineDocumentImages } from "./inline-images";
import { isSafeImageSrc } from "./css-safety";
import { getStorage } from "@/lib/storage";
import type { StorageAdapter } from "@/lib/storage/types";

export interface SaleLandOverrides {
  price?: string;
  access?: string;
  landArea?: string;
  landCategory?: string;
  transactionType?: string;
  deliveryTiming?: string;
  remarks?: string;
}

export interface SaleLandInput {
  property: {
    address: string;
    zoningDistrict?: string | null;
    buildingCoverageRatio?: string | null;
    floorAreaRatio?: string | null;
    roadType?: string | null;
    roadWidth?: string | null;
    occupancyStatus?: string | null;
  };
  owner?: { name?: string | null } | null;
  photo?: { fileUrl: string } | null;
  overrides?: SaleLandOverrides;
}

/**
 * 保存する画像 src を正規化する。`PropertyPhoto.fileUrl` は storage backend に
 * よって `/uploads/{key}`（local）や `/{bucket}/{key}` / 絶対URL（server）など
 * 形が異なる。storage key を解決して常に正規の `/uploads/{key}` 形へ揃えることで、
 * 保存時の `isSafeImageSrc`（`/uploads/` か `data:` のみ許可）を通り、出力時に
 * `authorizeAndInlineDocumentImages` が `keyFromUrl` で再解決できる。
 * key を解決できない場合は null（呼び出し側で写真を落とす）。
 */
export function toCanonicalUploadsSrc(
  fileUrl: string | null | undefined,
  storage: Pick<StorageAdapter, "keyFromUrl"> = getStorage(),
): string | null {
  const key = storage.keyFromUrl(fileUrl ?? null);
  if (!key) return null;
  const candidate = `/uploads/${key}`;
  // key は storage 的に有効でも image src として不正なことがある（空白/%2e 等）。
  // その場合は写真を落とす（src を返さない）。さもないと保存境界の parseSalesSheetDocument が
  // 図面全体を 422 で弾く。
  return isSafeImageSrc(candidate) ? candidate : null;
}

const NAVY = "#15324f";
const RED = "#d0331a";
const FONT = '"Yu Gothic UI","Meiryo",sans-serif';

function row(label: string, value: string | null | undefined): { label: string; value: string } {
  return { label, value: value ?? "" };
}

/** 売土地 図面の document を組む（純関数・写真は未展開の /uploads/ src のまま）。 */
export function buildSaleLandDocument(input: SaleLandInput): SalesSheetDocument {
  const o = input.overrides ?? {};
  const p = input.property;
  const ratio =
    p.buildingCoverageRatio || p.floorAreaRatio
      ? `${p.buildingCoverageRatio ?? "-"}％ ／ ${p.floorAreaRatio ?? "-"}％`
      : "";
  const road =
    [p.roadType, p.roadWidth ? `幅員${p.roadWidth}m` : null].filter(Boolean).join(" ") || "";

  const elements: SalesSheetElement[] = [
    { id: "title", type: "text", x: 10, y: 8, w: 180, h: 10, z: 2,
      content: "売土地", style: { fontSizePt: 16, bold: true, color: NAVY } },
    { id: "price-label", type: "text", x: 10, y: 22, w: 30, h: 8, z: 2,
      content: "価格", style: { fontSizePt: 10, color: "#888888" } },
    { id: "price", type: "text", x: 10, y: 28, w: 130, h: 14, z: 2,
      content: o.price ?? "", style: { fontSizePt: 26, bold: true, color: RED } },
    { id: "overview", type: "table", x: 150, y: 22, w: 137, h: 160, z: 1,
      rows: [
        row("所在地", p.address),
        row("交通", o.access),
        row("土地面積", o.landArea),
        row("地目", o.landCategory),
        row("用途地域", p.zoningDistrict),
        row("建蔽率/容積率", ratio),
        row("接道", road),
        row("現況", p.occupancyStatus),
        row("引渡", o.deliveryTiming),
        row("取引態様", o.transactionType),
        row("備考", o.remarks),
      ],
      style: { fontSizePt: 9, borderColor: "#cccccc", labelColor: NAVY } },
    { id: "company", type: "text", x: 10, y: 192, w: 277, h: 10, z: 2,
      content: "株式会社リガーレジャパン Ligare Japan　TEL 03-6823-2760",
      style: { fontSizePt: 9, color: NAVY } },
  ];

  if (input.photo?.fileUrl) {
    elements.push({
      id: "photo", type: "image", x: 10, y: 46, w: 130, h: 95, z: 1,
      src: input.photo.fileUrl, fit: "cover", radiusMm: 2, alt: "物件写真",
    });
  }

  return {
    page: A4_LANDSCAPE,
    theme: { fontFamily: FONT, accentColor: NAVY },
    elements,
  };
}

/** DB データ → 写真を data: 展開済みの検証可能な document。 */
export async function buildInitialSalesSheetDocument(
  input: SaleLandInput,
): Promise<SalesSheetDocument> {
  return inlineDocumentImages(buildSaleLandDocument(input));
}
