/**
 * 実況の**画面写真**は『全物件を見られる役割』にだけ渡す(@codex #394 R2 P1)。
 *
 * 背景: 自動操作は登記情報提供サービスのマイページ(口座全体の履歴)や請求リスト
 * (口座のカート)を開く。全画面の写真には**他の物件の所在・受付番号**まで写るため、
 * 担当分しか見られない役割(field_staff)に見せると、物件単位の認可を写真が素通りする。
 *
 * ⚠**走査型にする理由**: 同じ穴は1か所直しても再発する([[fix-all-call-sites-not-one]])。
 * 写真を配る route が将来増えても、ここで必ず引っかかるようにする。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isPropertyScopedRole } from "@/lib/property-access";

const CR = String.fromCharCode(13);

/** src 配下の .ts/.tsx を全部集める(手元CRLF/CIの差は取り除く)。 */
function collectSources(dir: string, out: Array<{ path: string; text: string }> = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      collectSources(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    out.push({ path: full, text: readFileSync(full, "utf8").split(CR).join("") });
  }
  return out;
}

const SOURCES = collectSources(join(process.cwd(), "src"));
const SHOT_CALLERS = SOURCES.filter(
  (f) =>
    f.text.includes("attachLiveShot(") &&
    !f.path.includes("live-view-store"),
);

describe("実況の画面写真を配る場所は、役割で必ず絞る", () => {
  it("写真を配る箇所が実在する(走査の空振りで緑にしない)", () => {
    expect(SHOT_CALLERS.length).toBeGreaterThanOrEqual(2);
  });

  it.each(SHOT_CALLERS.map((f) => [f.path, f.text] as const))(
    "%s は担当分しか見られない役割に写真を渡さない",
    (_path, text) => {
      // 判定は共有の純関数から導く(役割が増えたときに片方だけ直る事故を防ぐ)。
      expect(text).toContain("isPropertyScopedRole(session.role)");
      expect(text).toContain("if (!canSeeShots) return;");
      // 写真を止めたことは文字で伝える(黙って消さない)。
      expect(text).toContain("画面の写真は記録しません");
    },
  );
});

describe("担当分しか見られない役割の判定(認可と同じ根拠を使う)", () => {
  it("field_staff だけが担当分に絞られる", () => {
    expect(isPropertyScopedRole("field_staff")).toBe(true);
  });

  it.each(["admin", "manager", "viewer", ""])(
    "%s は全物件を見られる(=写真も見せてよい)",
    (role) => {
      expect(isPropertyScopedRole(role)).toBe(false);
    },
  );
});
