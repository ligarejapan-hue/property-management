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
