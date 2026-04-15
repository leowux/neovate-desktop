import { describe, expect, it } from "vitest";

import {
  formatBrowserRef,
  matchesBrowserPattern,
  normalizeBrowserRef,
  normalizeBrowserUrl,
} from "../../src/main/plugins/browser-automation/browser-cdp-service";

describe("browser-cdp-service helpers", () => {
  it("normalizes and formats refs", () => {
    expect(normalizeBrowserRef("@e12")).toBe("e12");
    expect(normalizeBrowserRef("e12")).toBe("e12");
    expect(formatBrowserRef("e12")).toBe("@e12");
    expect(formatBrowserRef("@e12")).toBe("@e12");
  });

  it("normalizes URLs the AgentBrowser way", () => {
    expect(normalizeBrowserUrl("example.com")).toBe("https://example.com");
    expect(normalizeBrowserUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeBrowserUrl("file:///tmp/demo.html")).toBe("file:///tmp/demo.html");
  });

  it("matches wildcard URL patterns", () => {
    expect(matchesBrowserPattern("https://app.example.com/dashboard", "**/dashboard")).toBe(true);
    expect(matchesBrowserPattern("https://app.example.com/dashboard", "**/settings")).toBe(false);
  });
});
