import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import { getLocalUploadRoot, resolveSafeUploadPath } from "../local-paths";

describe("getLocalUploadRoot", () => {
  const originalEnv = process.env.LOCAL_UPLOAD_ROOT;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.LOCAL_UPLOAD_ROOT;
    else process.env.LOCAL_UPLOAD_ROOT = originalEnv;
  });

  it("LOCAL_UPLOAD_ROOT 未設定なら process.cwd()/public/uploads", () => {
    delete process.env.LOCAL_UPLOAD_ROOT;
    expect(getLocalUploadRoot()).toBe(path.join(process.cwd(), "public", "uploads"));
  });

  it("空文字も未設定扱い", () => {
    process.env.LOCAL_UPLOAD_ROOT = "";
    expect(getLocalUploadRoot()).toBe(path.join(process.cwd(), "public", "uploads"));
  });

  it("LOCAL_UPLOAD_ROOT を絶対パスとして優先する", () => {
    const custom = path.resolve("/tmp/test-uploads-root");
    process.env.LOCAL_UPLOAD_ROOT = custom;
    expect(getLocalUploadRoot()).toBe(custom);
  });

  it("前後空白は trim される", () => {
    const custom = path.resolve("/tmp/test-uploads-root");
    process.env.LOCAL_UPLOAD_ROOT = `  ${custom}  `;
    expect(getLocalUploadRoot()).toBe(custom);
  });
});

describe("resolveSafeUploadPath", () => {
  const originalEnv = process.env.LOCAL_UPLOAD_ROOT;

  beforeEach(() => {
    process.env.LOCAL_UPLOAD_ROOT = path.resolve("/tmp/test-uploads-root");
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.LOCAL_UPLOAD_ROOT;
    else process.env.LOCAL_UPLOAD_ROOT = originalEnv;
  });

  it("正常な key は root 配下の絶対パスを返す", () => {
    const out = resolveSafeUploadPath("properties/abc/photos/x.jpg");
    expect(out).toBe(
      path.resolve("/tmp/test-uploads-root", "properties/abc/photos/x.jpg"),
    );
  });

  it("foo/../bar のように内部で打ち消される ../ は OK（最終的に root 配下）", () => {
    const out = resolveSafeUploadPath("foo/../bar");
    expect(out).toBe(path.resolve("/tmp/test-uploads-root", "bar"));
  });

  it("../foo は reject", () => {
    expect(() => resolveSafeUploadPath("../foo")).toThrow(/path traversal/);
  });

  it("../../etc/passwd は reject", () => {
    expect(() => resolveSafeUploadPath("../../etc/passwd")).toThrow(/path traversal/);
  });

  it("絶対パス /etc/passwd は reject", () => {
    expect(() => resolveSafeUploadPath("/etc/passwd")).toThrow(/path traversal/);
  });

  it("バックスラッシュ混じりの ..\\foo も reject", () => {
    expect(() => resolveSafeUploadPath("..\\foo")).toThrow(/path traversal/);
  });

  it("ルート自体を指す key は reject", () => {
    expect(() => resolveSafeUploadPath(".")).toThrow(/escapes upload root/);
  });
});
