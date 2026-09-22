import { describe, expect, it } from "vitest";
import { redactContentClasses } from "./content-class.ts";
import { redactSecretsInText } from "./redact.ts";

describe("content-class classification", () => {
  it("masks personal data spans with the shared marker", () => {
    const text = "Email jane.doe@example.com or call 416-555-0142 / +1 (416) 555-0143, ssn 123-45-6789, card 4111 1111 1111 1111";
    const { text: out, passed } = redactContentClasses(text, ["personal"]);
    expect(passed).toEqual([]);
    expect(out).not.toContain("jane.doe@example.com");
    expect(out).not.toContain("416-555-0142");
    expect(out).not.toContain("555-0143");
    expect(out).not.toContain("123-45-6789");
    expect(out).not.toContain("4111 1111 1111 1111");
    expect((out.match(/«redacted \d+ chars»/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it("masks internal infrastructure but never a public address", () => {
    const text = "ssh 10.0.7.24 or db.internal or fd00::1 or fe80::1 or 192.168.1.10 or ::1; public 8.8.8.8 and example.com stay";
    const { text: out, passed } = redactContentClasses(text, ["internal"]);
    expect(passed).toEqual([]);
    expect(out).toContain("8.8.8.8");
    expect(out).toContain("example.com");
    expect(out).not.toContain("10.0.7.24");
    expect(out).not.toContain("db.internal");
    expect(out).not.toContain("fd00::1");
    expect(out).not.toContain("fe80::1");
    expect(out).not.toContain("192.168.1.10");
    expect(out).not.toContain("::1");
  });

  it("leaves ordinary text untouched: dates, versions, ids, times", () => {
    const text = "On 2026-09-22 v1.2.3 build 8675309 task #12345 ran at 12:30 for 3.5 hours in region eu-west-1";
    expect(redactContentClasses(text, ["personal", "internal"]).text).toBe(text);
  });

  it("reports loosened classes without masking their spans", () => {
    const text = "jane@example.com on 10.0.0.5";
    expect(redactContentClasses(text, ["internal"])).toEqual({ text: "jane@example.com on «redacted 8 chars»", passed: ["personal"] });
    expect(redactContentClasses(text, ["personal"])).toEqual({ text: "«redacted 16 chars» on 10.0.0.5", passed: ["internal"] });
    expect(redactContentClasses(text, [])).toEqual({ text, passed: ["personal", "internal"] });
    expect(redactContentClasses("plain prose", ["personal"])).toEqual({ text: "plain prose", passed: [] });
  });

  it("is stable across re-application", () => {
    const once = redactContentClasses("card 4111111111111111 ends", ["personal"]).text;
    expect(redactContentClasses(once, ["personal"]).text).toBe(once);
  });
  it("masks with markers byte-identical to the credential scrub", () => {
    const mixed = "token sk-ant-api03-1234567890abcdef1234567890abcdef for jane@example.com";
    const creds = redactSecretsInText(mixed);
    expect(creds).toContain("«redacted ");
    expect(creds).not.toContain("sk-ant-api03-1234567890abcdef1234567890abcdef");
    const both = redactContentClasses(creds, ["personal"]).text;
    expect(both).not.toContain("jane@example.com");
    expect(both).toContain("«redacted 16 chars»");
    // a payload can pass through both scrubs; neither may re-mask a marker
    expect(redactSecretsInText(both)).toBe(both);
    expect(redactContentClasses(both, ["personal", "internal"]).text).toBe(both);
  });
});

