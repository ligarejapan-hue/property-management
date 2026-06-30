export interface SaleDmSender { senderName: string; senderContact: string }

export function resolveSender(): SaleDmSender {
  return {
    senderName: process.env.SALE_DM_SENDER_NAME ?? "(差出人名 未設定)",
    senderContact: process.env.SALE_DM_SENDER_CONTACT ?? "",
  };
}

// 差出人(差出人名・連絡先)が env で設定済みか。未設定だと resolveSender が
// "(差出人名 未設定)"/空 を返し、使えない手紙を有料生成してしまうため、生成前の fail-closed
// 判定に使う(印刷URL チェックと同方針)。空白のみも未設定として扱う。
export function isSenderConfigured(): boolean {
  return (
    !!process.env.SALE_DM_SENDER_NAME?.trim() &&
    !!process.env.SALE_DM_SENDER_CONTACT?.trim()
  );
}
