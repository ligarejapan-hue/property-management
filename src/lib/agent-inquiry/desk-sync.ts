/**
 * 受付の窓とメイン画面(同じブラウザの別の窓)の間の合図。受付の窓で反響を登録・変更したら、
 * 開きっぱなしのメイン画面(物件の反響欄・ホームの件数)が読み直す。
 * ⚠載せるのは「変わった」の一言だけ(名前・電話・id を載せない)。受けた側は自分の権限で API を読み直す。
 * ⚠使えないブラウザ・塞がれた環境では何もしない(画面は「読み直す」ボタンと窓に戻ったときの読み直しで追いつく)。
 */
export const INQUIRY_SYNC_CHANNEL = "pm-agent-inquiry";
type SyncMessage = { type: "changed" };

export function notifyInquiryChanged(): void {
  try {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(INQUIRY_SYNC_CHANNEL);
    ch.postMessage({ type: "changed" } satisfies SyncMessage);
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
      if ((e.data as SyncMessage | null)?.type === "changed") cb();
    };
    return () => ch.close();
  } catch {
    return () => {};
  }
}
