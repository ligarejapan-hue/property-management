import DmLogsView from "@/components/properties/dm-logs-view";

// /properties/[id]/dm-logs — 物件の DM 送付履歴（read-only）。
// 認可・PII マスク・監査は GET /api/properties/[id]/dm-logs（サーバ側）が担う。
export default async function PropertyDmLogsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DmLogsView propertyId={id} />;
}
