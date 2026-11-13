// 自動で外した宛先の件数を、理由ごとに1文の部品にする(宛名CSV・売却DM の通知で共用)。
// 例: 「拒否・宛先不明の反響が付いた 2 件と、所有者が業者と同じ名前の 1 件」。どちらも 0 なら null。
// 業者と同じ名前=業者の名簿・国交省の業者一覧と所有者の名前が同じ(住所に関係なく外す・2026-11-09)。
// 外字の名前=所有者の名前に謄本の外字(私用領域の字)がある(宛名が □ になる・2026-11-11)。
export function dmExclusionCountsText(terminal = 0, agentName = 0, gaijiName = 0): string | null {
  const parts = [
    ...(terminal > 0 ? [`拒否・宛先不明の反響が付いた ${terminal} 件`] : []),
    ...(agentName > 0 ? [`所有者が業者と同じ名前の ${agentName} 件`] : []),
    ...(gaijiName > 0 ? [`所有者の名前か住所に読めない字(外字)がある ${gaijiName} 件`] : []),
  ];
  return parts.length > 0 ? parts.join("と、") : null;
}
