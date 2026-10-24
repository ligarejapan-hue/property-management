import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireDriveAdmin } from "@/lib/drive/admin-access";
import { clearDriveConnection, loadDriveConnectionStatus } from "@/lib/drive/connection";

const noStore = { headers: { "Cache-Control": "no-store" } };

/** GET: 接続の状態(トークンは返さない=アカウントのメールと時刻・設定の有無だけ)。 */
export async function GET() {
  try {
    await requireDriveAdmin();
    return NextResponse.json({ data: await loadDriveConnectionStatus() }, noStore);
  } catch (e) {
    return handleApiError(e);
  }
}

/** DELETE: 接続を切る(保存したトークンを消す)。紐づけは残す(接続し直せばそのまま使える)。 */
export async function DELETE() {
  try {
    const session = await requireDriveAdmin();
    await clearDriveConnection();
    await writeAuditLog({ userId: session.id, action: "drive_disconnect", targetTable: "drive_connection" });
    return NextResponse.json({ data: await loadDriveConnectionStatus() }, noStore);
  } catch (e) {
    return handleApiError(e);
  }
}
