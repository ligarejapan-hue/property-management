import {
  getApiSession,
  getUserPermissions,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";

// ---------- GET /api/me/permissions ----------
// 現在ログイン中のユーザーの権限一覧を返す。
// クライアント側での表示制御（例: 案件ステータスドロップダウン）に使う。

export async function GET() {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    return apiResponse({ permissions });
  } catch (error) {
    return handleApiError(error);
  }
}
