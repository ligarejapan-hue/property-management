import CandidateQueue from "@/components/field-survey/candidate-queue";
import { getApiSession } from "@/lib/api-helpers";

// ?back= は UUID のみ受け付ける (@codex #408 R3 P2)。不正な値(例: "]. など)を
// そのまま querySelector のセレクタへ渡すと SyntaxError で一覧ごと落ちるため、
// map-client の focusPin 検証と同じ規則で入口で捨てる。
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(v: string | null): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

// server-side で確定したログイン userId を渡す (現地調査マップと同方針)。
// 「候補から外す」の表示ゲート (own 判定) に使う。client 側での推測はしない。
// 取得失敗時は null = ボタン非表示の fail-closed (一覧表示自体は従来どおり
// CandidateQueue 内の API 認可に委ねる)。
export default async function CandidatesPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string; back?: string }>;
}) {
  // 地図の「一覧へ戻る」からの復元(?order= / ?back=)。server で読んで props で
  // 渡す=SSR とクライアントの初期表示が一致し hydration が食い違わない。
  const sp = await searchParams;
  const initialOrder = sp.order === "oldest" ? ("oldest" as const) : ("newest" as const);
  const rawBack = sp.back ?? null;
  const backPinId = isValidUuid(rawBack) ? rawBack : null;
  let currentUserId: string | null = null;
  try {
    const session = await getApiSession();
    currentUserId = session.id;
  } catch {
    currentUserId = null;
  }
  return (
    <CandidateQueue
      currentUserId={currentUserId}
      initialOrder={initialOrder}
      backPinId={backPinId}
    />
  );
}
