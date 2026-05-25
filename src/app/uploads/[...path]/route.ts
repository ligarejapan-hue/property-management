import { NextRequest } from "next/server";
import { getStorage } from "@/lib/storage";
import { getApiSession, ApiError } from "@/lib/api-helpers";

/**
 * /uploads/[...path] 配信 proxy。
 *
 * Phase 2: 実体の取得は backend (Local / Server / S3) 共通の
 * StorageAdapter.read 経由に統一する。これにより `STORAGE_BACKEND` を
 * 切り替えても既存 DB レコードの `/uploads/...` URL を変えずに配信できる。
 *
 * セキュリティ:
 *  - Phase A: 未ログインは 401 を返す。ログイン済みなら続行。
 *  - path traversal (`..`, 絶対パス) は adapter 側で reject される。
 *    本ハンドラでは 403 に変換する。
 *  - 注: attachment / photo 単位の権限チェックは Phase B 以降。
 */

function isPathTraversalError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (/path traversal/i.test(err.message) ||
      /escapes upload root/i.test(err.message))
  );
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  try {
    await getApiSession();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return new Response("Unauthorized", { status: 401 });
    }
    throw err;
  }

  const { path: parts } = await params;
  if (!parts || parts.length === 0) {
    return new Response("Not Found", { status: 404 });
  }

  const key = parts.join("/");

  let result;
  try {
    result = await getStorage().read(key);
  } catch (err) {
    if (isPathTraversalError(err)) {
      return new Response("Forbidden", { status: 403 });
    }
    throw err;
  }

  if (!result) {
    return new Response("Not Found", { status: 404 });
  }

  // Node の Buffer / Uint8Array は generic 引数 (ArrayBufferLike) が DOM の
  // BodyInit 候補 (Uint8Array<ArrayBuffer>) と一致しないため TS が assignable
  // と認識しない。実体は BufferSource として正しく受け取られるので、
  // 安全側のキャストで通す（runtime は無加工で stream 化される）。
  return new Response(result.body as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": result.contentType,
      "Content-Length": String(result.size),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
