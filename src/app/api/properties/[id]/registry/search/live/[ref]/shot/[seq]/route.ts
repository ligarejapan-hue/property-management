import { NextRequest, NextResponse } from "next/server";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import {
  getLiveShot,
  isValidLiveRef,
} from "@/lib/registry-fetch/live-view-store";

// ---------- GET /api/properties/[id]/registry/search/live/[ref]/shot/[seq] ----------
// 実況パネルのステップスクショ (viewport JPEG) を配信する。
// - スクショには所在・地番等の秘匿情報が写るため、権限 (registry:auto_fetch +
//   property:read) に加えて **実行者本人のみ** (ストア key の userId 一致) に限定。
// - メモリ内 TTL の一時データ = no-store + nosniff。ディスク/DB には存在しない。
// - AuditLog は書かない: 本人が自分の実行を実行中に眺める「画面の鏡」であり、
//   永続資料の閲覧 (registry PDF preview 等) とは性質が異なる。検索実行自体の
//   監査は runRegistrySearch 側で記録済み (非PII)。
// - 座標等と同様、画像バイト列・秘匿情報は log に出さない。

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; ref: string; seq: string }> },
) {
  try {
    const { id, ref, seq } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "registry", "auto_fetch")) {
      throw new ApiError(403, "謄本所在検索の権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件閲覧の権限がありません", "FORBIDDEN");
    }
    const seqNum = Number(seq);
    if (
      !isValidLiveRef(ref) ||
      !Number.isInteger(seqNum) ||
      seqNum < 0 ||
      seqNum > 10_000
    ) {
      throw new ApiError(404, "スクリーンショットが見つかりません", "NOT_FOUND");
    }

    const shot = getLiveShot(session.id, id, ref, seqNum);
    if (!shot) {
      throw new ApiError(404, "スクリーンショットが見つかりません", "NOT_FOUND");
    }

    // Buffer ではなく Uint8Array を BodyInit に渡す (repo 既知の TS 制約)。
    return new NextResponse(new Uint8Array(shot), {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
