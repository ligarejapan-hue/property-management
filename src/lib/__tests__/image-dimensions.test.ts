import { describe, it, expect } from "vitest";
import { readImageDimensions } from "../image-dimensions";

function jpeg(width: number, height: number, sof = 0xc0): Buffer {
  const sofSeg = Buffer.alloc(2 + 2 + 1 + 2 + 2 + 1);
  sofSeg[0] = 0xff; sofSeg[1] = sof;
  sofSeg.writeUInt16BE(sofSeg.length - 2, 2);
  sofSeg[4] = 8;
  sofSeg.writeUInt16BE(height, 5);
  sofSeg.writeUInt16BE(width, 7);
  sofSeg[9] = 3;
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sofSeg, Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.from([0xff, 0xd9])]);
}
function png(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(8 + 13 + 4);
  ihdr.writeUInt32BE(13, 0); ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8); ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([sig, ihdr]);
}
function webpVp8x(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(22, 4); b.write("WEBP", 8, "latin1");
  b.write("VP8X", 12, "latin1"); b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3); b.writeUIntLE(height - 1, 27, 3);
  return b;
}
function webpVp8l(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(22, 4); b.write("WEBP", 8, "latin1");
  b.write("VP8L", 12, "latin1"); b.writeUInt32LE(10, 16); b[20] = 0x2f;
  const bits = (width - 1) | ((height - 1) << 14);
  b.writeUInt32LE(bits >>> 0, 21);
  return b;
}
function webpVp8(width: number, height: number): Buffer {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(32, 4); b.write("WEBP", 8, "latin1");
  b.write("VP8 ", 12, "latin1"); b.writeUInt32LE(20, 16);
  b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a;
  b.writeUInt16LE(width & 0x3fff, 26); b.writeUInt16LE(height & 0x3fff, 28);
  return b;
}

describe("readImageDimensions", () => {
  it("JPEG(SOF0/SOF2)", () => {
    expect(readImageDimensions(jpeg(1600, 900), "image/jpeg")).toEqual({ width: 1600, height: 900 });
    expect(readImageDimensions(jpeg(640, 480, 0xc2), "image/jpeg")).toEqual({ width: 640, height: 480 });
  });
  it("PNG(IHDR)", () => {
    expect(readImageDimensions(png(1200, 1600), "image/png")).toEqual({ width: 1200, height: 1600 });
  });
  it("WebP(VP8X / VP8L / VP8)", () => {
    expect(readImageDimensions(webpVp8x(1024, 768), "image/webp")).toEqual({ width: 1024, height: 768 });
    expect(readImageDimensions(webpVp8l(300, 200), "image/webp")).toEqual({ width: 300, height: 200 });
    expect(readImageDimensions(webpVp8(320, 240), "image/webp")).toEqual({ width: 320, height: 240 });
  });
  it("壊れている・短い・対応外の mime は null(例外を投げない)", () => {
    expect(readImageDimensions(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg")).toBeNull();
    expect(readImageDimensions(Buffer.alloc(0), "image/png")).toBeNull();
    expect(readImageDimensions(png(1, 1).subarray(0, 12), "image/png")).toBeNull();
    expect(readImageDimensions(jpeg(10, 10), "image/heic")).toBeNull();
    expect(readImageDimensions(Buffer.from("RIFF....WEBPXXXX", "latin1"), "image/webp")).toBeNull();
  });
  it("JPEG は mime と中身が食い違えば null(PNG の中身に image/jpeg)", () => {
    expect(readImageDimensions(png(10, 10), "image/jpeg")).toBeNull();
  });
});
