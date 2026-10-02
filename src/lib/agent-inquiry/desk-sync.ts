/**
 * 受付の窓とメイン画面(同じブラウザの別の窓)の間の合図。受付の窓で反響を登録・変更したら、
 * 開きっぱなしのメイン画面(物件の反響欄・ホームの件数)が読み直す。
 * ⚠載せるのは「変わった」と窓ごとの乱数の印だけ(名前・電話・反響の id を載せない)。受けた側は自分の権限で
 *   API を読み直す。印は「同じ窓が出した合図を聞かない」ため(自分の保存の後は自分で読み直しているので、
 *   聞くと同じ窓が2回読み直す)。
 * ⚠使えないブラウザ・塞がれた環境では何もしない(画面は「読み直す」ボタンと窓に戻ったときの読み直しで追いつく)。
 */
import { safeRandomId } from "@/lib/random-id";

export const INQUIRY_SYNC_CHANNEL = "pm-agent-inquiry";
type SyncMessage = { type: "changed"; from: string };
/** この窓(ページ)の印。読み込むたびに変わる乱数で、人や反響とは結び付かない。 */
const WINDOW_TOKEN = safeRandomId();

export function notifyInquiryChanged(): void {
  try {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(INQUIRY_SYNC_CHANNEL);
    ch.postMessage({ type: "changed", from: WINDOW_TOKEN } satisfies SyncMessage);
    ch.close();
  } catch {
    // 合図は「あれば便利」なもの。出せなくても保存そのものは済んでいる。
  }
}

/** 合図を聞く。戻り値=やめる関数(effect の後片付けにそのまま渡せる)。 */
export function onInquiryChanged(cb: () => void): () => void {
  try {
    if (typeof BroadcastChannel === "undefined") return () => {};
    const ch = new BroadcastChannel(INQUIRY_SYNC_CHANNEL);
    ch.onmessage = (e: MessageEvent) => {
      const d = e.data as SyncMessage | null;
      // 同じ窓が出した合図は聞かない(自分の保存の後は自分で読み直している)。
      if (d?.type === "changed" && d.from !== WINDOW_TOKEN) cb();
    };
    return () => ch.close();
  } catch {
    return () => {};
  }
}
