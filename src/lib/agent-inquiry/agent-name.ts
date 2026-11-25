/**
 * 反響の業者の呼び名(2026-11-25)。名簿の業者があれば会社名(支店名まで)、名簿に入れずに受け付けた反響は
 * 受付で打った名前。どちらも無い行は DB の CHECK で作れないが、念のため「業者不明」にする。
 */
export function inquiryAgentName(r: {
  agent: { companyName: string; branchName?: string | null } | null;
  agentNameText?: string | null;
}): string {
  if (r.agent) return r.agent.branchName ? `${r.agent.companyName} ${r.agent.branchName}` : r.agent.companyName;
  const t = r.agentNameText?.trim();
  return t ? t : "業者不明";
}

/** 名簿に入れずに受け付けた反響か(名簿の業者に付け替えられる)。 */
export function isNameOnlyInquiry(r: { agent: unknown | null }): boolean {
  return r.agent == null;
}
