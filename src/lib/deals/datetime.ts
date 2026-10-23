/** 画面は日本時間・API は ISO(UTC)。端末の時間帯に左右されないよう、+09:00 を明示して変換する。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function jstParts(d: Date) {
  const j = new Date(d.getTime() + JST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    y: j.getUTCFullYear(), mo: p(j.getUTCMonth() + 1), d: p(j.getUTCDate()),
    h: p(j.getUTCHours()), mi: p(j.getUTCMinutes()),
  };
}

export function jstDateString(now: Date): string {
  const t = jstParts(now);
  return `${t.y}-${t.mo}-${t.d}`;
}

export function isoToJstLocal(iso: string | null): string {
  if (!iso) return "";
  const t = jstParts(new Date(iso));
  return `${t.y}-${t.mo}-${t.d}T${t.h}:${t.mi}`;
}

export function jstLocalToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(`${v}:00+09:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function formatJstDateTime(iso: string | null): string {
  if (!iso) return "";
  const t = jstParts(new Date(iso));
  return `${t.y}/${t.mo}/${t.d} ${t.h}:${t.mi}`;
}
