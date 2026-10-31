/** 担当者が自分の LINE やメールで送る文面(システムからは送らない)。差し戻しの理由はここで伝える。 */

type RequestLike = { label: string; status: string; rejectReason: string | null };
const dateJa = (ymd: string) => `${Number(ymd.slice(0, 4))}年${Number(ymd.slice(5, 7))}月${Number(ymd.slice(8, 10))}日`;

/** 足りない書類の一覧(未提出と差し戻し)。無ければ null。 */
export function buildMissingDocsText(requests: readonly RequestLike[]): string | null {
  const lines = requests.flatMap((r) => {
    if (r.status === "pending") return [`・${r.label}`];
    if (r.status === "rejected") return [`・${r.label}(再提出:${r.rejectReason ?? "担当者よりご連絡します"})`];
    return [];
  });
  return lines.length ? lines.join("\n") : null;
}

export function buildDocLinkGuidance(input: { partyName: string | null; companyName: string; url: string; expiresOn: string; requests: readonly RequestLike[] }): string {
  const missing = buildMissingDocsText(input.requests);
  return [
    ...(input.partyName ? [`${input.partyName} 様`, ""] : []),
    `${input.companyName}です。決済に必要な書類のご提出をお願いします。`,
    "下のリンクを開き、書類ごとに写真を撮るかファイルを選んでください。",
    ...(missing ? ["", "【お願いしたい書類】", missing] : []),
    "",
    input.url,
    "",
    `リンクの期限:${dateJa(input.expiresOn)}`,
  ].join("\n");
}
