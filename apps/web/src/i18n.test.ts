import { describe, expect, it } from "vitest";
import { messages, resolveLocale, translate, type MessageKey } from "./i18n.tsx";

describe("resolveLocale", () => {
  it("prefers the stored choice", () => {
    expect(resolveLocale("zh", ["en-US"])).toBe("zh");
    expect(resolveLocale("en", ["zh-CN"])).toBe("en");
  });

  it("follows the browser languages", () => {
    expect(resolveLocale(null, ["zh-CN", "en"])).toBe("zh");
    expect(resolveLocale(null, ["zh-Hant-TW"])).toBe("zh");
    expect(resolveLocale(null, ["en-GB"])).toBe("en");
    expect(resolveLocale(null, ["fr-FR", "en-US"])).toBe("en");
  });

  it("falls back to English", () => {
    expect(resolveLocale(null, [])).toBe("en");
    expect(resolveLocale(null, ["de-DE", "ja-JP"])).toBe("en");
    expect(resolveLocale("bogus", ["fr"])).toBe("en");
  });
});

describe("translate", () => {
  it("interpolates parameters", () => {
    expect(translate("en", "files.deleteConfirm", { path: "/a.txt" })).toBe("Delete /a.txt?");
    expect(translate("zh", "files.deleteConfirm", { path: "/a.txt" })).toBe("删除 /a.txt？");
  });

  it("keeps the placeholder when a parameter is missing", () => {
    expect(translate("en", "files.deleteConfirm")).toBe("Delete {path}?");
  });

  it("keeps both dictionaries in sync", () => {
    const keys = Object.keys(messages.en) as MessageKey[];
    expect(Object.keys(messages.zh).sort()).toEqual(Object.keys(messages.en).sort());
    for (const key of keys) {
      expect(messages.zh[key]).toBeTruthy();
    }
  });

  it("uses the same placeholders in both languages", () => {
    const placeholders = (value: string): string[] =>
      [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "").sort();
    for (const key of Object.keys(messages.en) as MessageKey[]) {
      expect(placeholders(messages.zh[key])).toEqual(placeholders(messages.en[key]));
    }
  });
});
