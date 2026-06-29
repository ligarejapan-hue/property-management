import { getStorage } from "@/lib/storage";
import { authorizeUploadAccess } from "@/lib/uploads-authorization";
import type { SalesSheetDocument, SalesSheetElement } from "./document-schema";
import type { ApiSession, PermissionEntry } from "@/lib/api-helpers";

// 1×1 透明 GIF: 認可外画像のプレースホルダ。レイアウト（z-order）を保つため
// 要素は削除せず src のみ安全な data: URL に差し替える。
const TRANSPARENT_PLACEHOLDER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function dropImage(el: Extract<SalesSheetElement, { type: "image" }>): SalesSheetElement {
  return { ...el, src: TRANSPARENT_PLACEHOLDER };
}

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

  const elements = await Promise.all(
    doc.elements.map(async (el): Promise<SalesSheetElement> => {
      if (el.type !== "image") return el;
      if (el.src.startsWith("data:")) return el;

      const key = storage.keyFromUrl(el.src);
      if (!key) return dropImage(el);

      const decision = await authorizeUploadAccess({
        key,
        session: ctx.session,
        permissions: ctx.permissions,
      });
      if (decision !== "ok") return dropImage(el);

      const result = await storage.read(key).catch(() => null);
      if (!result) return dropImage(el);
      // 非画像 MIME（拡張子推定で application/octet-stream 等）は `data:image/` 検証を通らず、
      // 出力の再 parse で図面全体が 422 になる。該当画像だけプレースホルダ化して全体破綻を防ぐ。
      if (!result.contentType.startsWith("image/")) return dropImage(el);

      const b64 = result.body.toString("base64");
      return { ...el, src: `data:${result.contentType};base64,${b64}` };
    }),
  );

  return { ...doc, elements };
}
