/**
 * 添付から「それが付いている先」への行き先を決める。
 *
 * 添付ファイル検索の一覧は、これまで対象を「物件 #a1b2c3d4」と文字で出すだけで、
 * そこから物件へ移動できなかった（IDを控えて別画面で探す必要があった）。
 * 行き先の決め方は画面に書かず、ここに集約して総当たりで検査する。
 *
 * ⚠行き先が無い種別（コメント等）は null を返し、**リンクにしない**。
 *   「押せそうなのに 404」を作らないため、知っている種別だけを通す許可リスト方式。
 */
const TARGET_HREF_BUILDERS: Readonly<Record<string, (id: string) => string>> = {
  property: (id) => `/properties/${id}`,
  owner: (id) => `/admin/owners/${id}`,
};

export function attachmentTargetHref(
  targetType?: string | null,
  targetId?: string | null,
): string | null {
  if (!targetType) return null;
  const build = TARGET_HREF_BUILDERS[targetType];
  if (!build) return null;
  const id = (targetId ?? "").trim();
  if (!id) return null;
  // ⚠生のIDをそのまま繋がない。想定外の文字が来ても、経路や検索条件に化けさせない。
  return build(encodeURIComponent(id));
}
