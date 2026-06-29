import { z } from "zod";
import { getStorage } from "@/lib/storage";
import { authorizeUploadAccess, isUploadKeyOwnedByProperty } from "@/lib/uploads-authorization";
import type { SalesSheetDocument, SalesSheetElement } from "./document-schema";
import type { ApiSession, PermissionEntry } from "@/lib/api-helpers";

// 1×1 透明 GIF: 認可外画像のプレースホルダ。レイアウト（z-order）を保つため
// 要素は削除せず src のみ安全な data: URL に差し替える。
const TRANSPARENT_PLACEHOLDER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function dropImage(el: Extract<SalesSheetElement, { type: "image" }>): SalesSheetElement {
  return { ...el, src: TRANSPARENT_PLACEHOLDER };
}

// 出力時の DoS ガード（property:write ユーザーが多数の /uploads 参照を含む document を保存し
// export で大量並列 read → メモリ枯渇するのを防ぐ）。
const MAX_INLINE_IMAGES = 50; // 1 document あたりの /uploads 画像数の上限（超過は出力拒否）
const MAX_TOTAL_INLINE_BYTES = 32 * 1024 * 1024; // data 化後の合計バイト上限（超過分は drop）

/**
 * document 内の全 image 要素について src を認可・インライン化する。
 *
 * - `data:` src → そのまま保持（スキーマで data:image 限定済み）
 * - `/uploads/` src → storage key を解決し `authorizeUploadAccess` で判定
 *   - "ok"       → bytes を読んで data: URL に変換
 *   - 其の他      → バイト未読込のままプレースホルダ化（情報漏洩ゼロ）
 * - key 解決不可 / read 失敗 → プレースホルダ化（例外は伝播しない）
 *
 * 入力 document は変更しない（新オブジェクトを返す）。
 * バイト列・key・URL はログ・レスポンスに出さない。
 */
export async function authorizeAndInlineDocumentImages(
  doc: SalesSheetDocument,
  ctx: { session: ApiSession; permissions: PermissionEntry[] },
): Promise<SalesSheetDocument> {
  const storage = getStorage();

  // DoS 防止: 出力対象（data: 以外の image）が多すぎる document は read 前に出力拒否（fail-fast）。
  // ZodError → handleApiError で 422。key/URL はメッセージに出さない。
  const inlineCount = doc.elements.filter(
    (el) => el.type === "image" && !el.src.startsWith("data:"),
  ).length;
  if (inlineCount > MAX_INLINE_IMAGES) {
    throw new z.ZodError([
      { code: z.ZodIssueCode.custom, message: "図面に含まれる画像が多すぎます", path: ["elements"] },
    ]);
  }

  // 逐次処理（並列 read の fan-out を避ける）＋ 同一 key の重複 read を cache で排除。
  // data 化後の合計バイトが上限を超えたら以降の画像は drop（メモリ上限）。
  const cache = new Map<string, string>();
  let totalBytes = 0;
  const elements: SalesSheetElement[] = [];
  for (const el of doc.elements) {
    if (el.type !== "image" || el.src.startsWith("data:")) {
      elements.push(el);
      continue;
    }
    const key = storage.keyFromUrl(el.src);
    if (!key) {
      elements.push(dropImage(el));
      continue;
    }
    const cached = cache.get(key);
    if (cached) {
      elements.push({ ...el, src: cached });
      continue;
    }
    const decision = await authorizeUploadAccess({
      key,
      session: ctx.session,
      permissions: ctx.permissions,
    });
    if (decision !== "ok") {
      elements.push(dropImage(el));
      continue;
    }
    const result = await storage.read(key).catch(() => null);
    if (!result) {
      elements.push(dropImage(el));
      continue;
    }
    // 非画像 MIME（拡張子推定で application/octet-stream 等）は `data:image/` 検証を通らず、
    // 出力の再 parse で図面全体が 422 になる。該当画像だけプレースホルダ化して全体破綻を防ぐ。
    if (!result.contentType.startsWith("image/")) {
      elements.push(dropImage(el));
      continue;
    }
    if (totalBytes + result.size > MAX_TOTAL_INLINE_BYTES) {
      elements.push(dropImage(el)); // 合計バイト上限超過 → drop（メモリ枯渇防止）
      continue;
    }
    totalBytes += result.size;
    const dataUrl = `data:${result.contentType};base64,${result.body.toString("base64")}`;
    cache.set(key, dataUrl);
    elements.push({ ...el, src: dataUrl });
  }

  return { ...doc, elements };
}

/**
 * 保存境界の画像認可ガード（user-supplied document 用）。各 image 要素の src について:
 *  - `data:` src → スキップ（インライン bytes はサイズ上限で別途制限）
 *  - `/uploads/` src → storage key を解決し authorizeUploadAccess で判定。
 *    "ok" 以外（forbidden / not_found / 他物件 / key 解決不能）は throw して保存を拒否する。
 *
 * 各 /uploads key について **(1) caller が読めること**（authorizeUploadAccess === "ok"）かつ
 * **(2) その key がこの図面の物件 `propertyId` に属すること**（isUploadKeyOwnedByProperty）の
 * 両方を要求する。別物件 / 未認可 / 存在しない / 解決不能な key を含む document は保存拒否。
 * (2) が無いと、複数物件を読める管理者が物件Aの図面に物件Bの key を保存でき、A 担当の
 * field_staff が GET でその key を受け取る（cross-property GET echo）。
 *
 * 未認可 /uploads が sales_sheet_designs.document に保存され GET で echo されるのを防ぐ多層防御
 * （バイト自体は export の認可インライン化と /uploads 配信ルートで別途保護）。ZodError で投げ
 * handleApiError が 422 化する。key/URL はメッセージに出さない（漏洩防止）。
 */
export async function assertDocumentImagesAuthorized(
  doc: SalesSheetDocument,
  ctx: { session: ApiSession; permissions: PermissionEntry[]; propertyId: string },
): Promise<void> {
  const storage = getStorage();
  for (const el of doc.elements) {
    if (el.type !== "image") continue;
    if (el.src.startsWith("data:")) continue; // インライン bytes（サイズ上限で別途制限）
    const key = storage.keyFromUrl(el.src);
    if (!key || !(await isImageKeyAuthorizedForProperty(key, ctx))) {
      throw new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          message: "保存できない画像が含まれています（アクセス権限のない画像）",
          path: ["elements"],
        },
      ]);
    }
  }
}

/**
 * /uploads key が **(1) caller に読める**（authorizeUploadAccess === "ok"）かつ
 * **(2) `propertyId` に属する**（isUploadKeyOwnedByProperty）かを判定する共通ヘルパ。
 * 保存境界（assertDocumentImagesAuthorized＝NG は throw）と、サーバ生成の初期 document
 * の代表写真認可（NG は写真 drop）で共用する。key/URL は呼び出し側でログ・レスポンスに出さない。
 */
export async function isImageKeyAuthorizedForProperty(
  key: string,
  ctx: { session: ApiSession; permissions: PermissionEntry[]; propertyId: string },
): Promise<boolean> {
  const decision = await authorizeUploadAccess({
    key,
    session: ctx.session,
    permissions: ctx.permissions,
  });
  if (decision !== "ok") return false;
  return isUploadKeyOwnedByProperty(key, ctx.propertyId);
}
