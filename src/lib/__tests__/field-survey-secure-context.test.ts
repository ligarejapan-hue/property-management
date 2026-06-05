import { describe, it, expect } from "vitest";
import {
  isLocalHostname,
  shouldWarnInsecureContext,
} from "../field-survey-secure-context";

describe("isLocalHostname", () => {
  it.each(["localhost", "127.0.0.1", "::1", "[::1]", "LOCALHOST", " 127.0.0.1 "])(
    "%s は loopback として扱う",
    (h) => {
      expect(isLocalHostname(h)).toBe(true);
    },
  );

  it.each(["192.168.0.10", "10.0.0.5", "172.16.1.1", "example.com", "", null, undefined])(
    "%s は loopback ではない",
    (h) => {
      expect(isLocalHostname(h as string)).toBe(false);
    },
  );
});

describe("shouldWarnInsecureContext", () => {
  it("https の通常ドメインは警告しない", () => {
    expect(
      shouldWarnInsecureContext({
        isSecureContext: true,
        protocol: "https:",
        hostname: "survey.example.com",
      }),
    ).toBe(false);
  });

  it("http の localhost は警告しない（ブラウザが secure 扱い）", () => {
    expect(
      shouldWarnInsecureContext({
        isSecureContext: true,
        protocol: "http:",
        hostname: "localhost",
      }),
    ).toBe(false);
  });

  it("http の 127.0.0.1 は警告しない", () => {
    expect(
      shouldWarnInsecureContext({
        // isSecureContext が取れない/false でも loopback なら警告しない。
        isSecureContext: false,
        protocol: "http:",
        hostname: "127.0.0.1",
      }),
    ).toBe(false);
  });

  it("http の ::1 / [::1] は警告しない", () => {
    expect(
      shouldWarnInsecureContext({ protocol: "http:", hostname: "::1" }),
    ).toBe(false);
    expect(
      shouldWarnInsecureContext({ protocol: "http:", hostname: "[::1]" }),
    ).toBe(false);
  });

  it("http の LAN IP は警告する", () => {
    expect(
      shouldWarnInsecureContext({
        isSecureContext: false,
        protocol: "http:",
        hostname: "192.168.0.10",
      }),
    ).toBe(true);
  });

  it("http の通常ドメインは警告する", () => {
    expect(
      shouldWarnInsecureContext({
        isSecureContext: false,
        protocol: "http:",
        hostname: "survey.example.com",
      }),
    ).toBe(true);
  });

  it("isSecureContext=true なら http でも（loopback以外でも）警告しない（防御的）", () => {
    expect(
      shouldWarnInsecureContext({
        isSecureContext: true,
        protocol: "http:",
        hostname: "192.168.0.10",
      }),
    ).toBe(false);
  });

  it("https は isSecureContext 未指定でも警告しない", () => {
    expect(
      shouldWarnInsecureContext({ protocol: "https:", hostname: "example.com" }),
    ).toBe(false);
  });
});
