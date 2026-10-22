import DmLogsView from "@/components/properties/dm-logs-view";
import { BackLink } from "@/components/ui/back-link";

// /properties/[id]/dm-logs — 物件の DM 送付履歴（read-only）。
// 認可・PII マスク・監査は GET /api/properties/[id]/dm-logs（サーバ側）が担う。
export default async function PropertyDmLogsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <>
      {/* 実機確認 2026-10-23: この画面だけ元の物件へ戻る導線が無かった(「その他 ▾」から来るため)。 */}
      <BackLink href={`/properties/${id}`} to="物件" className="mb-3" />
      <DmLogsView propertyId={id} />
    </>
  );
}
