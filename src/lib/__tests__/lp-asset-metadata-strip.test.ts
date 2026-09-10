import { describe, it, expect } from "vitest";
import { stripLpAssetMetadata } from "../lp-asset-metadata-strip";
import { readImageDimensions } from "../image-dimensions";

// ---------------------------------------------------------------
// 合成バイト列(実画像は使わない)。許可リストの枝を1本ずつ通す。
// ---------------------------------------------------------------

/** 長さフィールドを持つ JPEG segment。 */
function seg(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
/** SOF0: precision(1) + height(2) + width(2) + ncomp(1) + 成分1つ(3)。 */
function sof0(width: number, height: number): Buffer {
  const p = Buffer.alloc(9);
  p[0] = 8;
  p.writeUInt16BE(height, 1);
  p.writeUInt16BE(width, 3);
  p[5] = 1;
  p[6] = 1; p[7] = 0x11; p[8] = 0;
  return seg(0xc0, p);
}
/** DQT: Pq/Tq(上位4bit=0 なので 8bit 表 = 64 byte)。 */
function dqt(payload: Buffer = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 0x10)])): Buffer {
  return seg(0xdb, payload);
}
/** DHT: Tc/Th(1) + 符号長ごとの個数(16) + 個数の合計ぶんの値。 */
function dht(counts: number[] = [1], values = 1): Buffer {
  const c = Buffer.alloc(16);
  counts.forEach((n, i) => { c[i] = n; });
  return seg(0xc4, Buffer.concat([Buffer.from([0x00]), c, Buffer.alloc(values, 0x0a)]));
}
const DQT = dqt();
const DHT = dht();
const DRI = seg(0xdd, Buffer.from([0x00, 0x04]));
const DNL = seg(0xdc, Buffer.from([0x00, 0x30]));
const SOS = seg(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]));
/** entropy-coded data(0xFF00 スタッフと RST0 を含める)。 */
const ENTROPY = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0x78]);

const APP0 = seg(0xe0, Buffer.from("JFIF\0\x01\x02\x00\x00\x01\x00\x01\x00\x00", "latin1"));
const APP1 = seg(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from("II*\0\x08\0\0\0\0\0", "latin1")]));
const COM = seg(0xfe, Buffer.from("撮影者 山田太郎 / 東京都千代田区1-1-1", "utf8"));
const APP13 = seg(0xed, Buffer.from("Photoshop 3.0\0IPTC-payload", "latin1"));

const CLEAN_JPEG = Buffer.concat([SOI, DQT, DHT, sof0(1600, 900), DRI, SOS, ENTROPY, EOI]);
const DIRTY_JPEG = Buffer.concat([SOI, APP0, APP1, COM, DQT, APP13, DHT, sof0(1600, 900), DRI, SOS, ENTROPY, EOI]);

/** 1本の segment を差し込んだ最小 JPEG(構造検査の枝を1本ずつ通すため)。 */
function jpegWith(extra: Buffer): Buffer {
  return Buffer.concat([SOI, extra, sof0(64, 48), SOS, ENTROPY, EOI]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** PNG chunk。CRC は検証しないので固定値を入れる(残す chunk は原文のまま出る確認に使う)。 */
function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(0xdeadbeef, 8 + data.length);
  return out;
}
function ihdr(width: number, height: number): Buffer {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(width, 0);
  d.writeUInt32BE(height, 4);
  d[8] = 8; d[9] = 6;
  return chunk("IHDR", d);
}
const PNG_IDAT = chunk("IDAT", Buffer.from([0x78, 0x9c, 0x01, 0x00]));
const PNG_IEND = chunk("IEND", Buffer.alloc(0));
const CLEAN_PNG = Buffer.concat([PNG_SIG, ihdr(800, 600), chunk("sRGB", Buffer.from([0])), PNG_IDAT, PNG_IEND]);
const DIRTY_PNG = Buffer.concat([
  PNG_SIG,
  ihdr(800, 600),
  chunk("tEXt", Buffer.from("Author\0山田太郎", "utf8")),
  chunk("iTXt", Buffer.from("Comment\0\0\0\0東京都千代田区1-1-1", "utf8")),
  chunk("eXIf", Buffer.from("II*\0\x08\0\0\0\0\0", "latin1")),
  chunk("tIME", Buffer.from([0x07, 0xe9, 0x01, 0x02, 0x03, 0x04, 0x05])),
  chunk("iCCP", Buffer.from("profile\0\0payload", "latin1")),
  chunk("prVt", Buffer.from("private", "latin1")),
  chunk("sRGB", Buffer.from([0])),
  PNG_IDAT,
  PNG_IEND,
]);
/** 1本の chunk を差し込んだ最小 PNG。 */
function pngWith(extra: Buffer): Buffer {
  return Buffer.concat([PNG_SIG, ihdr(8, 8), extra, PNG_IDAT, PNG_IEND]);
}

/** RIFF chunk(奇数 size は 1 byte pad)。 */
function riffChunk(fourcc: string, data: Buffer): Buffer {
  const pad = data.length % 2;
  const out = Buffer.alloc(8 + data.length + pad);
  out.write(fourcc, 0, "latin1");
  out.writeUInt32LE(data.length, 4);
  data.copy(out, 8);
  return out;
}
function riff(body: Buffer): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(4 + body.length, 4);
  out.write("WEBP", 8, "latin1");
  body.copy(out, 12);
  return out;
}
/** VP8X: flags(1) + reserved(3) + canvas幅-1(3) + canvas高-1(3)。 */
function vp8x(flags: number): Buffer {
  const d = Buffer.alloc(10);
  d[0] = flags;
  d.writeUIntLE(1599, 4, 3);
  d.writeUIntLE(899, 7, 3);
  return riffChunk("VP8X", d);
}
const VP8_ODD = riffChunk("VP8 ", Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05])); // size 5 = 奇数
const CLEAN_WEBP = riff(Buffer.concat([vp8x(0x10), riffChunk("ALPH", Buffer.from([0x01, 0x02])), VP8_ODD]));
const DIRTY_WEBP = riff(Buffer.concat([
  vp8x(0x2c), // ICC(0x20) + EXIF(0x08) + XMP(0x04)
  riffChunk("ICCP", Buffer.from("icc-profile-bytes", "latin1")),
  VP8_ODD,
  riffChunk("EXIF", Buffer.from("II*\0\x08\0\0\0\0\0", "latin1")),
  riffChunk("XMP ", Buffer.from("<x:xmpmeta>山田太郎</x:xmpmeta>", "utf8")),
]));

const ok = (r: ReturnType<typeof stripLpAssetMetadata>) => {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r;
};
const malformed = { ok: false, reason: "malformed" } as const;

describe("stripLpAssetMetadata: JPEG", () => {
  it("APP0/APP1/COM/APP13 を全て落とし、デコードに要る segment は1バイトも変えない", () => {
    const r = ok(stripLpAssetMetadata(DIRTY_JPEG, "image/jpeg"));
    expect(r.changed).toBe(true);
    expect(r.buffer.equals(CLEAN_JPEG)).toBe(true);
    // marker 単位の確認(APPn = 0xFFE0-0xFFEF / COM = 0xFFFE が SOS より前に残っていない)
    const sosAt = r.buffer.indexOf(Buffer.from([0xff, 0xda]));
    expect(sosAt).toBeGreaterThan(0);
    const head = r.buffer.subarray(0, sosAt);
    for (let m = 0xe0; m <= 0xef; m += 1) {
      expect(head.includes(Buffer.from([0xff, m]))).toBe(false);
    }
    expect(head.includes(Buffer.from([0xff, 0xfe]))).toBe(false);
    // 中身の文字列としても残っていない
    expect(r.buffer.includes(Buffer.from("Exif\0\0", "latin1"))).toBe(false);
    expect(r.buffer.includes(Buffer.from("山田太郎", "utf8"))).toBe(false);
    expect(r.buffer.includes(Buffer.from("Photoshop", "latin1"))).toBe(false);
    expect(r.buffer.includes(Buffer.from("JFIF", "latin1"))).toBe(false);
  });
  it("落とした後も寸法が読める(SOF が残っている)", () => {
    const r = ok(stripLpAssetMetadata(DIRTY_JPEG, "image/jpeg"));
    expect(readImageDimensions(r.buffer, "image/jpeg")).toEqual({ width: 1600, height: 900 });
  });
  it("既にきれいな JPEG は changed:false で原本をそのまま返す", () => {
    const r = ok(stripLpAssetMetadata(CLEAN_JPEG, "image/jpeg"));
    expect(r.changed).toBe(false);
    expect(r.buffer).toBe(CLEAN_JPEG);
  });
  it("複数スキャン(progressive)の途中に紛れた APPn も落ちる", () => {
    const input = Buffer.concat([
      SOI, DQT, DHT, sof0(64, 48), SOS, ENTROPY,
      APP1, DHT, SOS, ENTROPY, EOI,
    ]);
    const r = ok(stripLpAssetMetadata(input, "image/jpeg"));
    expect(r.buffer.equals(Buffer.concat([SOI, DQT, DHT, sof0(64, 48), SOS, ENTROPY, DHT, SOS, ENTROPY, EOI]))).toBe(true);
  });
  it("構造不正は malformed(SOI 無し・長さ超過・SOS 無し・EOI 無し)", () => {
    expect(stripLpAssetMetadata(Buffer.from([0x00, 0x01, 0x02, 0x03]), "image/jpeg")).toEqual(malformed);
    expect(stripLpAssetMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0xff]), "image/jpeg")).toEqual(malformed);
    expect(stripLpAssetMetadata(Buffer.concat([SOI, DQT, EOI]), "image/jpeg")).toEqual(malformed);
    expect(stripLpAssetMetadata(Buffer.concat([SOI, DQT, sof0(8, 8), SOS, ENTROPY]), "image/jpeg")).toEqual(malformed);
  });
});

describe("stripLpAssetMetadata: JPEG 残す segment の中身も検査する(ruling R9)", () => {
  it("DQT: 表を数え切って余りが出るもの・Pq が 0/1 以外は malformed", () => {
    // 64byte 表のうしろに情報を隠した DQT
    const smuggled = dqt(Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 0x10), Buffer.from("SECRET-PAYLOAD", "latin1")]));
    expect(stripLpAssetMetadata(jpegWith(smuggled), "image/jpeg")).toEqual(malformed);
    // 16bit 表(Pq=1)を名乗るのに 64byte しかない
    expect(stripLpAssetMetadata(jpegWith(dqt(Buffer.alloc(65, 0x10))), "image/jpeg")).toEqual(malformed);
    // Pq = 2(仕様外)
    expect(stripLpAssetMetadata(jpegWith(dqt(Buffer.alloc(65, 0x20))), "image/jpeg")).toEqual(malformed);
    // 空の DQT
    expect(stripLpAssetMetadata(jpegWith(dqt(Buffer.alloc(0))), "image/jpeg")).toEqual(malformed);
    // 正しい DQT は通る
    expect(ok(stripLpAssetMetadata(jpegWith(dqt()), "image/jpeg")).buffer.includes(dqt())).toBe(true);
  });
  it("DHT: 個数の合計と値の数が合わないものは malformed", () => {
    expect(stripLpAssetMetadata(jpegWith(dht([1], 0)), "image/jpeg")).toEqual(malformed); // 値が足りない
    expect(stripLpAssetMetadata(jpegWith(dht([1], 5)), "image/jpeg")).toEqual(malformed); // 値が余る
    expect(stripLpAssetMetadata(jpegWith(dht([2, 3], 5)), "image/jpeg")).not.toEqual(malformed); // 合計5でぴったり
    expect(stripLpAssetMetadata(jpegWith(dht([2, 3], 6)), "image/jpeg")).toEqual(malformed);
  });
  it("SOFn: 成分数(Nf)と segment 長が合わないものは malformed", () => {
    const bad = Buffer.concat([Buffer.from([8]), Buffer.from([0, 48, 0, 64]), Buffer.from([2]), Buffer.alloc(3), Buffer.from("hidden", "latin1")]);
    expect(stripLpAssetMetadata(Buffer.concat([SOI, DQT, seg(0xc0, bad), SOS, ENTROPY, EOI]), "image/jpeg")).toEqual(malformed);
    const nfZero = Buffer.concat([Buffer.from([8]), Buffer.from([0, 48, 0, 64]), Buffer.from([0])]);
    expect(stripLpAssetMetadata(Buffer.concat([SOI, DQT, seg(0xc0, nfZero), SOS, ENTROPY, EOI]), "image/jpeg")).toEqual(malformed);
  });
  it("DRI / SOS: 長さが仕様どおりでないものは malformed", () => {
    expect(stripLpAssetMetadata(jpegWith(seg(0xdd, Buffer.from([0, 4, 0, 0]))), "image/jpeg")).toEqual(malformed);
    const fatSos = Buffer.concat([SOI, DQT, sof0(64, 48), seg(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x99])), ENTROPY, EOI]);
    expect(stripLpAssetMetadata(fatSos, "image/jpeg")).toEqual(malformed);
  });
  it("DNL(0xDC)はスキャンの後ろに来ても残す(隣の COM は落ちる)", () => {
    const input = Buffer.concat([SOI, DQT, DHT, sof0(64, 48), SOS, ENTROPY, DNL, COM, EOI]);
    const r = ok(stripLpAssetMetadata(input, "image/jpeg"));
    expect(r.buffer.equals(Buffer.concat([SOI, DQT, DHT, sof0(64, 48), SOS, ENTROPY, DNL, EOI]))).toBe(true);
    expect(r.buffer.includes(Buffer.from([0xff, 0xdc, 0x00, 0x04]))).toBe(true);
    expect(r.buffer.includes(Buffer.from("山田太郎", "utf8"))).toBe(false);
    // 長さが 4 でない DNL は malformed
    expect(stripLpAssetMetadata(
      Buffer.concat([SOI, DQT, sof0(64, 48), SOS, ENTROPY, seg(0xdc, Buffer.from("0123", "latin1")), EOI]),
      "image/jpeg",
    )).toEqual(malformed);
  });
});

describe("stripLpAssetMetadata: PNG", () => {
  it("tEXt/iTXt/eXIf/tIME/iCCP/未知 chunk を落とし、許可した chunk だけを原文のまま残す", () => {
    const r = ok(stripLpAssetMetadata(DIRTY_PNG, "image/png"));
    expect(r.changed).toBe(true);
    expect(r.buffer.equals(CLEAN_PNG)).toBe(true);
    for (const t of ["tEXt", "iTXt", "eXIf", "tIME", "iCCP", "prVt"]) {
      expect(r.buffer.includes(Buffer.from(t, "latin1"))).toBe(false);
    }
    expect(r.buffer.includes(Buffer.from("山田太郎", "utf8"))).toBe(false);
    // IHDR が先頭・IEND が末尾
    expect(r.buffer.toString("latin1", 12, 16)).toBe("IHDR");
    expect(r.buffer.toString("latin1", r.buffer.length - 8, r.buffer.length - 4)).toBe("IEND");
    expect(readImageDimensions(r.buffer, "image/png")).toEqual({ width: 800, height: 600 });
  });
  it("既にきれいな PNG は changed:false", () => {
    const r = ok(stripLpAssetMetadata(CLEAN_PNG, "image/png"));
    expect(r.changed).toBe(false);
    expect(r.buffer).toBe(CLEAN_PNG);
  });
  it("構造不正は malformed(署名違い・IEND 無し・長さ超過・先頭が IHDR でない)", () => {
    const badSig = Buffer.from(CLEAN_PNG);
    badSig[1] = 0x00;
    expect(stripLpAssetMetadata(badSig, "image/png")).toEqual(malformed);
    expect(stripLpAssetMetadata(Buffer.concat([PNG_SIG, ihdr(8, 8), PNG_IDAT]), "image/png")).toEqual(malformed);
    const overflow = Buffer.concat([PNG_SIG, ihdr(8, 8), chunk("IDAT", Buffer.alloc(4))]);
    overflow.writeUInt32BE(0x0fffffff, PNG_SIG.length + 25);
    expect(stripLpAssetMetadata(overflow, "image/png")).toEqual(malformed);
    expect(stripLpAssetMetadata(Buffer.concat([PNG_SIG, PNG_IDAT, PNG_IEND]), "image/png")).toEqual(malformed);
  });
});

describe("stripLpAssetMetadata: PNG 残す chunk の長さも検査する(ruling R9)", () => {
  it("固定長の chunk に余りバイトが付いていたら malformed(pHYs/gAMA/cHRM/sRGB)", () => {
    // pHYs は 9 byte。うしろに情報を足した器は通さない
    expect(stripLpAssetMetadata(pngWith(chunk("pHYs", Buffer.concat([Buffer.alloc(9), Buffer.from("SECRET", "latin1")]))), "image/png")).toEqual(malformed);
    expect(stripLpAssetMetadata(pngWith(chunk("gAMA", Buffer.alloc(8))), "image/png")).toEqual(malformed);
    expect(stripLpAssetMetadata(pngWith(chunk("cHRM", Buffer.alloc(31))), "image/png")).toEqual(malformed);
    expect(stripLpAssetMetadata(pngWith(chunk("sRGB", Buffer.alloc(2))), "image/png")).toEqual(malformed);
    // 正しい長さなら残る
    const good = ok(stripLpAssetMetadata(pngWith(chunk("pHYs", Buffer.alloc(9, 0x01))), "image/png"));
    expect(good.buffer.includes(Buffer.from("pHYs", "latin1"))).toBe(true);
  });
  it("IHDR の長さが 13 でなければ malformed", () => {
    const bad = Buffer.concat([PNG_SIG, chunk("IHDR", Buffer.alloc(14)), PNG_IDAT, PNG_IEND]);
    expect(stripLpAssetMetadata(bad, "image/png")).toEqual(malformed);
  });
  it("可変長の chunk も刻みと上限を守らせる(PLTE/tRNS/hIST/sBIT/bKGD)", () => {
    expect(stripLpAssetMetadata(pngWith(chunk("PLTE", Buffer.alloc(10))), "image/png")).toEqual(malformed); // 3の倍数でない
    expect(stripLpAssetMetadata(pngWith(chunk("PLTE", Buffer.alloc(771))), "image/png")).toEqual(malformed); // 768 超え
    expect(stripLpAssetMetadata(pngWith(chunk("tRNS", Buffer.alloc(257))), "image/png")).toEqual(malformed);
    expect(stripLpAssetMetadata(pngWith(chunk("hIST", Buffer.alloc(9))), "image/png")).toEqual(malformed); // 奇数
    expect(stripLpAssetMetadata(pngWith(chunk("hIST", Buffer.alloc(514))), "image/png")).toEqual(malformed); // 512 超え
    expect(stripLpAssetMetadata(pngWith(chunk("sBIT", Buffer.alloc(5))), "image/png")).toEqual(malformed);
    expect(stripLpAssetMetadata(pngWith(chunk("bKGD", Buffer.alloc(7))), "image/png")).toEqual(malformed);
    // 上限内は通る
    expect(ok(stripLpAssetMetadata(pngWith(chunk("PLTE", Buffer.alloc(768))), "image/png")).ok).toBe(true);
    expect(ok(stripLpAssetMetadata(pngWith(chunk("tRNS", Buffer.alloc(256))), "image/png")).ok).toBe(true);
    // IDAT は任意長のまま(画素そのもの)
    expect(ok(stripLpAssetMetadata(pngWith(chunk("IDAT", Buffer.alloc(4096))), "image/png")).ok).toBe(true);
  });
});

describe("stripLpAssetMetadata: WebP", () => {
  it("EXIF/XMP/ICCP を落とし、VP8X の flag を消し、RIFF size を数え直す(奇数 size の pad 込み)", () => {
    const r = ok(stripLpAssetMetadata(DIRTY_WEBP, "image/webp"));
    expect(r.changed).toBe(true);
    for (const t of ["EXIF", "XMP ", "ICCP"]) {
      expect(r.buffer.includes(Buffer.from(t, "latin1"))).toBe(false);
    }
    expect(r.buffer.includes(Buffer.from("山田太郎", "utf8"))).toBe(false);
    expect(r.buffer.readUInt32LE(4)).toBe(r.buffer.length - 8);
    expect(r.buffer.toString("latin1", 0, 4)).toBe("RIFF");
    expect(r.buffer.toString("latin1", 8, 12)).toBe("WEBP");
    expect(r.buffer.toString("latin1", 12, 16)).toBe("VP8X");
    expect(r.buffer[20]).toBe(0x00); // flags: 0x2C(ICC+EXIF+XMP)が全て落ちる
    // 残った chunk = VP8X + VP8 (奇数 size 5 → pad 1 byte)
    expect(r.buffer.length).toBe(12 + (8 + 10) + (8 + 6));
    expect(r.buffer.toString("latin1", 30, 34)).toBe("VP8 ");
    expect(readImageDimensions(r.buffer, "image/webp")).toEqual({ width: 1600, height: 900 });
  });
  it("Alpha flag のような残すべき flag は消さない", () => {
    const input = riff(Buffer.concat([vp8x(0x1c), riffChunk("ALPH", Buffer.from([1, 2])), VP8_ODD, riffChunk("XMP ", Buffer.from("x", "latin1"))]));
    const r = ok(stripLpAssetMetadata(input, "image/webp"));
    expect(r.buffer[20]).toBe(0x10); // Alpha(0x10)だけ残る
    expect(r.buffer.includes(Buffer.from("XMP ", "latin1"))).toBe(false);
  });
  it("既にきれいな WebP は changed:false", () => {
    const r = ok(stripLpAssetMetadata(CLEAN_WEBP, "image/webp"));
    expect(r.changed).toBe(false);
    expect(r.buffer).toBe(CLEAN_WEBP);
  });
  it("構造不正は malformed(RIFF size が実長と違う・chunk が入り切らない)", () => {
    const lying = Buffer.from(DIRTY_WEBP);
    lying.writeUInt32LE(lying.length, 4); // 本来は length-8
    expect(stripLpAssetMetadata(lying, "image/webp")).toEqual(malformed);
    const overflow = riff(riffChunk("VP8 ", Buffer.from([1, 2, 3, 4])));
    overflow.writeUInt32LE(0x0fffffff, 16);
    expect(stripLpAssetMetadata(overflow, "image/webp")).toEqual(malformed);
    expect(stripLpAssetMetadata(Buffer.from("RIFX0000WEBP", "latin1"), "image/webp")).toEqual(malformed);
  });
  it("アニメーション WebP は受け付けない(ANIM/ANMF chunk・VP8X の Anim flag)", () => {
    // ANMF は subchunk を入れ子で持てる = 許可リストの抜け道になるので丸ごと拒否
    const anmfInner = Buffer.concat([Buffer.alloc(16), riffChunk("XMP ", Buffer.from("山田太郎", "utf8"))]);
    const withAnim = riff(Buffer.concat([vp8x(0x10), riffChunk("ANIM", Buffer.alloc(6)), VP8_ODD]));
    const withAnmf = riff(Buffer.concat([vp8x(0x10), riffChunk("ANMF", anmfInner), VP8_ODD]));
    expect(stripLpAssetMetadata(withAnim, "image/webp")).toEqual(malformed);
    expect(stripLpAssetMetadata(withAnmf, "image/webp")).toEqual(malformed);
    // VP8X の Anim flag(0x02)だけが立っている場合も拒否
    expect(stripLpAssetMetadata(riff(Buffer.concat([vp8x(0x12), VP8_ODD])), "image/webp")).toEqual(malformed);
  });
  it("VP8X の payload が 10 byte でなければ malformed", () => {
    expect(stripLpAssetMetadata(riff(Buffer.concat([riffChunk("VP8X", Buffer.alloc(12)), VP8_ODD])), "image/webp")).toEqual(malformed);
    expect(stripLpAssetMetadata(riff(Buffer.concat([riffChunk("VP8X", Buffer.alloc(4)), VP8_ODD])), "image/webp")).toEqual(malformed);
    expect(stripLpAssetMetadata(riff(Buffer.concat([riffChunk("VP8X", Buffer.alloc(0)), VP8_ODD])), "image/webp")).toEqual(malformed);
  });
});

describe("stripLpAssetMetadata: 共通", () => {
  it("対応外の MIME は unsupported_mime(HEIC・SVG・空文字)", () => {
    for (const m of ["image/heic", "image/heif", "image/svg+xml", "application/pdf", ""]) {
      expect(stripLpAssetMetadata(CLEAN_JPEG, m)).toEqual({ ok: false, reason: "unsupported_mime" });
    }
  });
  it("MIME の大文字小文字は問わない", () => {
    expect(ok(stripLpAssetMetadata(CLEAN_JPEG, "IMAGE/JPEG")).changed).toBe(false);
  });
  it("でたらめなバイト列でも例外を投げない", () => {
    for (const mime of ["image/jpeg", "image/png", "image/webp"]) {
      for (const len of [0, 1, 3, 11, 40]) {
        expect(() => stripLpAssetMetadata(Buffer.alloc(len, 0xff), mime)).not.toThrow();
        expect(stripLpAssetMetadata(Buffer.alloc(len, 0xff), mime).ok).toBe(false);
      }
    }
  });
  it("入力 buffer を書き換えない", () => {
    const copy = Buffer.from(DIRTY_WEBP);
    stripLpAssetMetadata(DIRTY_WEBP, "image/webp");
    expect(DIRTY_WEBP.equals(copy)).toBe(true);
    const jcopy = Buffer.from(DIRTY_JPEG);
    stripLpAssetMetadata(DIRTY_JPEG, "image/jpeg");
    expect(DIRTY_JPEG.equals(jcopy)).toBe(true);
  });
});
