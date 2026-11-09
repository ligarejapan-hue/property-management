// 自動で外した宛先の件数を、理由ごとに1文の部品にする(宛名CSV・売却DM の通知で共用)。
// 例: 「拒否・宛先不明の反響が付いた 2 件と、所有者が業者と同じ名前の 1 件」。どちらも 0 なら null。
// 業者と同じ名前=業者の名簿・国交省の業者一覧と所有者の名前が同じ(住所に関係なく外す・2026-11-09)。
export function dmExclusionCountsText(terminal = 0, agentName = 0): string | null {
  const parts = [
    ...(terminal > 0 ? [`拒否・宛先不明の反響が付いた ${terminal} 件`] : []),
    ...(agentName > 0 ? [`所有者が業者と同じ名前の ${agentName} 件`] : []),
  ];
  return parts.length > 0 ? parts.join("と、") : null;
}
