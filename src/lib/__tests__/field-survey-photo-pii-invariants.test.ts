/**
 * field-survey 写真の PII 非保存 invariant（回帰防止・source assertion）。
 *
 * 設計意図（schema コメント prisma/schema.prisma の FieldSurveyPinPhoto 参照）:
 *   「物件化前の候補地点を含む pin の写真。… EXIF / GPS 列は作らない (PII 蓄積回避)。
 *    fileUrl は /uploads/... 相対パスのみ保持し、public URL / storageKey 列は持たない。」
 *
 * この設計が将来の列追加で silent に崩れるのを防ぐため、schema 定義と
 * API レスポンス projection (SELECT_PHOTO) を文字列レベルで固定する。
 *
 * 実挙動（GET 応答が storageKey 非返却 / POST・DELETE audit が URL・座標・fileName 非含 等）は
 * 既存の field-survey-pin-photos-route.test.ts が runtime で担保しており、本ファイルは
 * 「PII を持たない／露出しないデータモデルである」という構造不変条件を補完する。
 *
 * 本プロジェクトの vitest は environment: "node"。schema / route ソースを文字列で検証する。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

function read(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");
}

/** `model <name> { ... }` ブロックを抽出する（先頭 model 宣言から最初の行頭 `}` まで）。 */
function modelBlock(schema: string, name: string): string {
  const start = schema.indexOf(`model ${name} {`);
  expect(start, `model ${name} が schema に存在する`).toBeGreaterThanOrEqual(0);
  const end = schema.indexOf("\n}", start);
  expect(end, `model ${name} の閉じ括弧が見つかる`).toBeGreaterThan(start);
  return schema.slice(start, end);
}

const SCHEMA_PATH = "prisma/schema.prisma";
const PHOTOS_ROUTE_PATH =
  "src/app/api/field-survey/pins/[id]/photos/route.ts";

// PII / 座標 / EXIF / メタデータ / storage key を表す列名（camelCase と @map snake_case 両形）。
const FORBIDDEN_PII_TOKENS = [
  "gpsLat",
  "gps_lat",
  "gpsLng",
  "gps_lng",
  "latitude",
  "longitude",
  "takenAt",
  "taken_at",
  "metadata",
  "exif",
  "storageKey",
  "storage_key",
];

describe("FieldSurveyPinPhoto schema: PII 非保存 invariant", () => {
  const schema = read(SCHEMA_PATH);
  const block = modelBlock(schema, "FieldSurveyPinPhoto");

  it.each(FORBIDDEN_PII_TOKENS)(
    "FieldSurveyPinPhoto に %s 列を持たない（EXIF/GPS/metadata/storageKey 非蓄積）",
    (token) => {
      expect(block.toLowerCase()).not.toContain(token.toLowerCase());
    },
  );

  it("FieldSurveyPinPhoto の列集合は PII を含まない既定の形のまま（列追加の silent 拡大を検知）", () => {
    // @id / @map / @relation 行などからフィールド名（行頭トークン）を抽出する。
    const fieldNames = block
      .split("\n")
      .map((l) => l.trim())
      .filter(
        (l) =>
          l.length > 0 &&
          !l.startsWith("model ") &&
          !l.startsWith("//") &&
          !l.startsWith("@@") &&
          /^[a-zA-Z]/.test(l),
      )
      .map((l) => l.split(/\s+/)[0]);
    // relation フィールド (pin / uploader) を除いたスカラ列。
    const scalar = fieldNames.filter((f) => f !== "pin" && f !== "uploader");
    expect(new Set(scalar)).toEqual(
      new Set([
        "id",
        "pinId",
        "fileUrl",
        "thumbnailUrl",
        "fileName",
        "fileSize",
        "mimeType",
        "uploadedByUserId",
        "sortOrder",
        "createdAt",
      ]),
    );
  });

  it("PII 回避の設計意図がコメントで明示されている", () => {
    expect(schema).toMatch(/EXIF \/ GPS 列は作らない/);
  });
});

describe("PropertyPhoto schema: 既存挙動を変えない（非回帰ガード）", () => {
  const schema = read(SCHEMA_PATH);
  const block = modelBlock(schema, "PropertyPhoto");

  it("PropertyPhoto は gpsLat / gpsLng / takenAt を引き続き保持する（field-survey 用の禁止を誤って全体適用しない）", () => {
    expect(block).toMatch(/gpsLat\s+Decimal\?/);
    expect(block).toMatch(/gpsLng\s+Decimal\?/);
    expect(block).toMatch(/takenAt\s+DateTime\?/);
  });
});

describe("field-survey photos API: レスポンス projection が PII を露出しない", () => {
  const routeSrc = read(PHOTOS_ROUTE_PATH);
  // `const SELECT_PHOTO = { ... } as const;` ブロックを抽出。
  const selStart = routeSrc.indexOf("const SELECT_PHOTO");
  const selEnd = routeSrc.indexOf("} as const", selStart);
  const selectBlock =
    selStart >= 0 && selEnd > selStart
      ? routeSrc.slice(selStart, selEnd)
      : "";

  it("SELECT_PHOTO ブロックが存在する", () => {
    expect(selStart).toBeGreaterThanOrEqual(0);
    expect(selEnd).toBeGreaterThan(selStart);
  });

  it.each([...FORBIDDEN_PII_TOKENS, "uploadedByUserId"])(
    "SELECT_PHOTO は %s を select しない（座標 / metadata / アップロード者 ID を露出しない）",
    (token) => {
      expect(selectBlock.toLowerCase()).not.toContain(token.toLowerCase());
    },
  );

  it("SELECT_PHOTO は表示に必要な非PII列のみを含む", () => {
    for (const key of ["id", "pinId", "fileUrl", "fileName", "mimeType"]) {
      expect(selectBlock).toMatch(new RegExp(`\\b${key}:\\s*true`));
    }
  });

  it("座標 / EXIF / storageKey をレスポンス・監査に出さない方針がコメントで明示されている", () => {
    expect(routeSrc).toMatch(/storageKey は API レスポンスに出さない/);
    expect(routeSrc).toMatch(/座標 \/ memo \/ EXIF は本テーブルに無い/);
  });
});
