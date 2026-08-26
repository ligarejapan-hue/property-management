/**
 * 外部キー(査定ナンバー)の正規化は、**3ルートすべてが同じ関数を通る**。
 *
 * ⚠この作業で「正規化の1か所忘れ」が6回起きている(@codex PR#414 16巡目 ②)。
 *   直近は recheck だけが生値で引いており、
 *   「画面は重複なしと言うのに、登録すると409」という食い違いが出ていた。
 *   語彙や手順の申し送りでは防げないので、**通っていることを走査で固定**する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeExternalLinkKey } from "../normalize";

const here = dirname(fileURLToPath(import.meta.url));
const repoSrc = join(here, "../../..");

/**
 * ⚠**外部キーを書く／引く全経路**をここに並べる。
 *   17巡目で CSV取込(書込側)も加えた。これで**混在幅の行は今後生まれ得ない**。
 */
const ROUTES: { label: string; path: string }[] = [
  { label: "下書き(build-draft)", path: "lib/paste-import/build-draft.ts" },
  { label: "再判定(recheck)", path: "app/api/import/paste/recheck/route.ts" },
  { label: "確定(commit)", path: "app/api/import/paste/commit/route.ts" },
  { label: "CSV取込(書込)", path: "app/api/import/csv/route.ts" },
];

describe("normalizeExternalLinkKey（共通関数そのもの）", () => {
  it("★全角を半角へ畳む", () => {
    expect(normalizeExternalLinkKey("ＳＡ２６０８－１２３４５６７")).toBe("SA2608-1234567");
  });

  it("★**混在幅**（一部だけ全角）も同じ形に畳む", () => {
    // 2表記の列挙では拾えなかった形。書込側を通すことで今後生まれ得なくなる。
    for (const raw of [
      "SA2608－1234567",
      "ＳＡ2608-1234567",
      "SA２６０８-1234567",
      "ＳＡ２６０８-１２３４５６７",
    ]) {
      expect(normalizeExternalLinkKey(raw), raw).toBe("SA2608-1234567");
    }
  });

  it("★半角はそのまま（保存される文字列を変えない）", () => {
    expect(normalizeExternalLinkKey("SA2608-1234567")).toBe("SA2608-1234567");
  });

  it("★前後の空白を落とし、空になったら null", () => {
    expect(normalizeExternalLinkKey("  SA2608-1234567  ")).toBe("SA2608-1234567");
    expect(normalizeExternalLinkKey("   ")).toBeNull();
    expect(normalizeExternalLinkKey("")).toBeNull();
    expect(normalizeExternalLinkKey(null)).toBeNull();
    expect(normalizeExternalLinkKey(undefined)).toBeNull();
  });

  it("★同じ入力に同じ結果（経路ごとに結果が割れない）", () => {
    for (const raw of ["ＳＡ２６０８－１２３４５６７", "SA2608-1234567", " sa-1 "]) {
      expect(normalizeExternalLinkKey(raw)).toBe(normalizeExternalLinkKey(raw));
    }
  });
});

describe("外部キーを扱う全経路が共通関数を通っている（走査）", () => {
  for (const route of ROUTES) {
    it(`★${route.label} が normalizeExternalLinkKey を使っている`, () => {
      const src = readFileSync(join(repoSrc, route.path), "utf8");
      // ⚠**import 行だけでは通っていることにならない**。呼び出しが消えても
      //   import が残っていれば緑になる空振りを踏んだので、
      //   import 以外の行に**実際の呼び出し**があることを見る。
      const callSites = src
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("import"))
        .filter((line) => !line.trimStart().startsWith("*"))
        .filter((line) => line.includes("normalizeExternalLinkKey("));
      expect(
        callSites.length,
        `${route.path} が共通の正規化を呼んでいない（import だけでは不可）`,
      ).toBeGreaterThan(0);
    });
  }

  it("★どのルートも独自の正規化を書いていない（toHalfWidth を直に使わない）", () => {
    // ⚠共通関数の中身を写した「もう1つの正規化」を作らせない。
    //   写した瞬間に、片方だけ直る食い違いが生まれる。
    const offenders: string[] = [];
    for (const route of ROUTES) {
      const src = readFileSync(join(repoSrc, route.path), "utf8");
      // 外部キーの近くで toHalfWidth を直接呼んでいないこと。
      for (const line of src.split("\n")) {
        if (line.includes("toHalfWidth(") && line.includes("externalLinkKey")) {
          offenders.push(`${route.path}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, `独自の正規化が残っている:\n${offenders.join("\n")}`).toEqual([]);
  });
});
