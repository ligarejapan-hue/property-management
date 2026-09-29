import { describe, it, expect } from "vitest";
import { deflateRawSync } from "node:zlib";
import * as XLSX from "xlsx";
import { assertZipExpandsWithin, ZipGuardError } from "../xlsx-zip-guard";

/**
 * 最小の ZIP を組み立てる(テスト専用)。declaredSize を渡すと、中央ディレクトリに
 * **嘘の展開後サイズ**を書く(申告を信じない実装かを確かめるため)。
 */
function makeZip(entries: { name: string; data: Buffer; declaredSize?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const comp = deflateRawSync(e.data);
    const size = e.declaredSize ?? e.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const MB = 1024 * 1024;

describe("assertZipExpandsWithin — 展開後の大きさを、展開しながら上限で止める", () => {
  it("ふつうの Excel は通る", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["姓名"], ["山田"]]), "S");
    const buf = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    expect(() => assertZipExpandsWithin(buf, 50 * MB)).not.toThrow();
  });

  it("★小さく圧縮されていても、展開後が上限を超えれば止める", () => {
    const bomb = makeZip([{ name: "xl/worksheets/sheet1.xml", data: Buffer.alloc(60 * MB, 0x20) }]);
    expect(bomb.length).toBeLessThan(1 * MB);
    expect(() => assertZipExpandsWithin(bomb, 50 * MB)).toThrow(ZipGuardError);
  });

  it("★展開後サイズを小さく偽って申告していても、実際に展開した量で止める", () => {
    const liar = makeZip([{ name: "a.xml", data: Buffer.alloc(60 * MB, 0x20), declaredSize: 100 }]);
    expect(() => assertZipExpandsWithin(liar, 50 * MB)).toThrow(ZipGuardError);
  });

  it("★複数の中身の合計で数える(1つずつは上限未満でも)", () => {
    const many = makeZip([
      { name: "a.xml", data: Buffer.alloc(30 * MB, 0x20) },
      { name: "b.xml", data: Buffer.alloc(30 * MB, 0x20) },
    ]);
    expect(() => assertZipExpandsWithin(many, 50 * MB)).toThrow(ZipGuardError);
  });

  it("ZIP でなければ止める", () => {
    expect(() => assertZipExpandsWithin(Buffer.from("not a zip"), 50 * MB)).toThrow(ZipGuardError);
  });
});

describe("ZIP の見出し情報の食い違いで守りをすり抜けさせない(@codex PR#456 9巡目)", () => {
  const normal = () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["姓名"], ["山田"]]), "S");
    return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  };
  const eocdAt = (b: Buffer) => b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));

  it("★「全体の件数」だけを0に偽った ZIP は止める(読み手は別の件数欄を使って展開する)", () => {
    const b = normal();
    b.writeUInt16LE(0, eocdAt(b) + 10);
    expect(() => assertZipExpandsWithin(b, 1)).toThrow(ZipGuardError);
  });

  it("★「このディスクの件数」だけを偽った ZIP も止める", () => {
    const b = normal();
    b.writeUInt16LE(0, eocdAt(b) + 8);
    expect(() => assertZipExpandsWithin(b, 50 * MB)).toThrow(ZipGuardError);
  });

  it("★分割 ZIP(ディスク番号が0以外)は扱わずに止める", () => {
    const b = normal();
    b.writeUInt16LE(1, eocdAt(b) + 4);
    expect(() => assertZipExpandsWithin(b, 50 * MB)).toThrow(ZipGuardError);
  });
});

describe("中央ディレクトリとローカル見出しの食い違いを断る(@codex PR#456 10巡目)", () => {
  it("★中央では「無圧縮」、ローカルでは「deflate」と偽った中身は止める(読み手はローカルを信じて展開する)", () => {
    const zip = makeZip([{ name: "xl/worksheets/sheet1.xml", data: Buffer.alloc(60 * MB, 0x20) }]);
    const cd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt16LE(0, cd + 10); // 中央ディレクトリの圧縮方式だけ「無圧縮」に
    expect(() => assertZipExpandsWithin(zip, 50 * MB)).toThrow(ZipGuardError);
  });

  it("★ローカル見出しの圧縮後サイズが中央と違う中身は止める", () => {
    const zip = makeZip([{ name: "a.xml", data: Buffer.from("hello") }]);
    zip.writeUInt32LE(zip.readUInt32LE(18) + 100, 18);
    expect(() => assertZipExpandsWithin(zip, 50 * MB)).toThrow(ZipGuardError);
  });
});

describe("データ記述子(実物の Excel は全件これ)で圧縮後サイズを小さく偽っても通さない", () => {
  it("★中央の圧縮後サイズを小さく偽ると、実際の圧縮データを読み切れず止まる(読み手は圧縮データの終わりまで展開する)", () => {
    const zip = makeZip([{ name: "a.xml", data: Buffer.alloc(60 * MB, 0x20) }]);
    const cd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt16LE(0x08, cd + 8); // データ記述子あり
    zip.writeUInt16LE(0x08, 6); // ローカル見出しも
    zip.writeUInt32LE(0, 18); // ローカルの圧縮後サイズは0(記述子方式の書き方)
    zip.writeUInt32LE(16, cd + 20); // 中央の圧縮後サイズを16バイトと偽る
    expect(() => assertZipExpandsWithin(zip, 50 * MB)).toThrow(ZipGuardError);
  });
});

describe("申告された展開後サイズも上限と実際の大きさで確かめる(@codex PR#456 11巡目)", () => {
  it("★展開後サイズを巨大に申告した中身は止める(読み手は申告どおりに領域を確保する)", () => {
    const zip = makeZip([{ name: "a.xml", data: Buffer.from("tiny"), declaredSize: 0x7fffffff }]);
    expect(() => assertZipExpandsWithin(zip, 50 * MB)).toThrow(ZipGuardError);
  });

  it("★申告と実際の展開後サイズが違う中身は止める", () => {
    const zip = makeZip([{ name: "a.xml", data: Buffer.from("hello world"), declaredSize: 5 }]);
    expect(() => assertZipExpandsWithin(zip, 50 * MB)).toThrow(ZipGuardError);
  });

  it("★ZIP64 の拡張フィールドを持つ中身は扱わずに止める(申告サイズを別の場所で差し替えられる)", () => {
    const base = makeZip([{ name: "a.xml", data: Buffer.from("x") }]);
    // 中央ディレクトリの拡張フィールドに ZIP64(0x0001) を足した ZIP を組み直す
    const cd = base.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const eocd = base.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const extra = Buffer.alloc(12);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(8, 2);
    const nameLen = base.readUInt16LE(cd + 28);
    const central = Buffer.concat([base.subarray(cd, cd + 46 + nameLen), extra]);
    central.writeUInt16LE(extra.length, 30);
    const tail = Buffer.from(base.subarray(eocd));
    tail.writeUInt32LE(central.length, 12);
    const zip = Buffer.concat([base.subarray(0, cd), central, tail]);
    expect(() => assertZipExpandsWithin(zip, 50 * MB)).toThrow(ZipGuardError);
  });

  it("実物の Excel と同じ書き方(データ記述子・ローカルの申告は0)は通る", () => {
    const zip = makeZip([{ name: "a.xml", data: Buffer.from("hello") }]);
    const cd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt16LE(0x08, cd + 8);
    zip.writeUInt16LE(0x08, 6);
    zip.writeUInt32LE(0, 18);
    zip.writeUInt32LE(0, 22);
    expect(() => assertZipExpandsWithin(zip, 50 * MB)).not.toThrow();
  });
});

describe("データ記述子ありでも、ローカルの申告は0か中央と同じ値だけ(@codex PR#456 12巡目)", () => {
  const descriptorZip = () => {
    const zip = makeZip([{ name: "a.xml", data: Buffer.from("hello") }]);
    const cd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt16LE(0x08, cd + 8);
    zip.writeUInt16LE(0x08, 6);
    return zip;
  };

  it("★ローカルの圧縮後サイズが中央と違う(0でもない)なら止める(読み手はローカルの値で切り出す)", () => {
    const zip = descriptorZip();
    zip.writeUInt32LE(1024 * 1024, 18);
    expect(() => assertZipExpandsWithin(zip, 50 * MB)).toThrow(ZipGuardError);
  });

  it("★ローカルの展開後サイズが中央と違う(0でもない)なら止める", () => {
    const zip = descriptorZip();
    zip.writeUInt32LE(1024 * 1024, 22);
    expect(() => assertZipExpandsWithin(zip, 50 * MB)).toThrow(ZipGuardError);
  });

  it("ローカルが0(実物の Excel の書き方)、または中央と同じ値なら通る", () => {
    const a = descriptorZip();
    a.writeUInt32LE(0, 18);
    a.writeUInt32LE(0, 22);
    expect(() => assertZipExpandsWithin(a, 50 * MB)).not.toThrow();
    expect(() => assertZipExpandsWithin(descriptorZip(), 50 * MB)).not.toThrow();
  });
});
