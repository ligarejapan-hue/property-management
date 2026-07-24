/**
 * 完成待ち一覧の「場所特定」改善: 各行に現地写真の cover サムネイルを出す。
 *
 * 設計方針:
 * - 座標(lat/lng/accuracy)・memo 本文は従来どおり返さない = PII 境界を広げない。
 * - 写真は upload 時に EXIF/GPS strip 済 + /uploads 配信が認可ゲート済 (own は
 *   field_survey:read、他人は read_all/manage) で一覧の可視スコープと一致するため
 *   追加してよい。cover の thumbnailUrl (無ければ fileUrl) と枚数のみ返す。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

function readSrc(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");
}

const ROUTE = readSrc(
  "src/app/api/field-survey/pins/candidates/route.ts",
);
const QUEUE = readSrc("src/components/field-survey/candidate-queue.tsx");
const API = readSrc("src/lib/api-client.ts");

describe("完成待ち: 現地写真サムネイル (場所特定)", () => {
  it("route は cover 写真 (sortOrder 昇順の先頭 1 件) と枚数を返す", () => {
    // photos join: sortOrder 昇順で 1 件だけ
    expect(ROUTE).toMatch(
      /photos:\s*\{[\s\S]*?orderBy:[\s\S]*?sortOrder:\s*"asc"[\s\S]*?take:\s*1/,
    );
    expect(ROUTE).toMatch(/_count:\s*\{\s*select:\s*\{\s*photos:\s*true/);
    // cover は thumbnailUrl ?? fileUrl を normalizeFileUrl で表示形へ
    expect(ROUTE).toMatch(/normalizeFileUrl\(/);
    expect(ROUTE).toMatch(/thumbnailUrl \?\? cover\.fileUrl/);
    expect(ROUTE).toMatch(/coverPhotoUrl/);
    expect(ROUTE).toMatch(/photoCount: r\._count\.photos/);
  });

  it("route の data map は座標・memo 本文を返さない (PII 境界維持)", () => {
    const dataMap = ROUTE.match(
      /const data = limited\.map\(\(r\) => \{[\s\S]*?return \{[\s\S]*?\};\s*\}\);/,
    );
    expect(dataMap).not.toBeNull();
    const m = dataMap?.[0] ?? "";
    // hasMemo (派生 boolean) のみ。memo 本文キーは返さない。
    expect(m).toMatch(/hasMemo:/);
    // 返却オブジェクトのキーとして lat/lng/accuracy/memo 本文を含めない
    expect(m).not.toMatch(/\blat:/);
    expect(m).not.toMatch(/\blng:/);
    expect(m).not.toMatch(/accuracy:/);
    expect(m).not.toMatch(/\bmemo:/);
  });

  it("CandidatePinRow に coverPhotoUrl / photoCount 型がある", () => {
    const iface = API.match(/export interface CandidatePinRow \{[\s\S]*?\}/);
    expect(iface).not.toBeNull();
    const m = iface?.[0] ?? "";
    expect(m).toMatch(/coverPhotoUrl\?:\s*string \| null/);
    expect(m).toMatch(/photoCount\?:\s*number/);
  });

  it("queue は写真をタップした時だけ読み込む (常時 <img> を置かない)", () => {
    // photoCount > 0 の行にトグルボタンを出す
    expect(QUEUE).toMatch(/data-testid="candidate-photo-toggle"/);
    expect(QUEUE).toMatch(/photoCount > 0 &&/);
    expect(QUEUE).toMatch(/onClick=\{\(\) => togglePhoto\(r\.id\)\}/);
    expect(QUEUE).toMatch(/aria-expanded=\{photoShown\}/);
    // 表示中の行 (photoShown) だけ <img> を DOM に入れる = on-demand 読込
    expect(QUEUE).toMatch(
      /\{photoShown && r\.coverPhotoUrl && !photoBroken &&[\s\S]{0,200}?data-testid="candidate-photo-view"/,
    );
    expect(QUEUE).toMatch(/src=\{r\.coverPhotoUrl\}/);
    expect(QUEUE).toMatch(/loading="lazy"/);
    expect(QUEUE).toMatch(/onError=\{\(\) => markThumbBroken\(r\.id\)\}/);
    // 表示状態は Set で管理し、読込のたびにリセット (前回の展開を持ち越さない)
    expect(QUEUE).toMatch(/shownPhotoIds/);
    expect(QUEUE).toMatch(/setShownPhotoIds\(new Set\(\)\)/);
    expect(QUEUE).toMatch(/setBrokenThumbIds\(new Set\(\)\)/);
  });

  it("トグルの文言に枚数を出し、複数枚は残枚数も示す", () => {
    expect(QUEUE).toMatch(/写真\{photoCount\}枚\{photoShown \? "を隠す" : "を見る"\}/);
    expect(QUEUE).toMatch(/photoCount > 1/);
    expect(QUEUE).toMatch(/ほか\{photoCount - 1\}枚/);
  });

  it("queue は座標・memo 本文・console を扱わない (継続ガード)", () => {
    expect(QUEUE).not.toMatch(/\.lat\b/);
    expect(QUEUE).not.toMatch(/\.lng\b/);
    expect(QUEUE).not.toMatch(/console\./);
  });
});
