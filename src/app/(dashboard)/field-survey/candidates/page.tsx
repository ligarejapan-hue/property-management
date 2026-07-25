import CandidateQueue from "@/components/field-survey/candidate-queue";
import { getApiSession } from "@/lib/api-helpers";

// server-side で確定したログイン userId を渡す (現地調査マップと同方針)。
// 「候補から外す」の表示ゲート (own 判定) に使う。client 側での推測はしない。
// 取得失敗時は null = ボタン非表示の fail-closed (一覧表示自体は従来どおり
// CandidateQueue 内の API 認可に委ねる)。
export default async function CandidatesPage() {
  let currentUserId: string | null = null;
  try {
    const session = await getApiSession();
    currentUserId = session.id;
  } catch {
    currentUserId = null;
  }
  return <CandidateQueue currentUserId={currentUserId} />;
}
