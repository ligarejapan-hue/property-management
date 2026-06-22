export interface SaleDmSender { senderName: string; senderContact: string }

export function resolveSender(): SaleDmSender {
  return {
    senderName: process.env.SALE_DM_SENDER_NAME ?? "(差出人名 未設定)",
    senderContact: process.env.SALE_DM_SENDER_CONTACT ?? "",
  };
}
