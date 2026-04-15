import { describe, expect, it, vi } from "vitest";

import type { AXNode } from "../../src/main/plugins/browser-automation/browser-cdp-service";

import { BrowserRefCache } from "../../src/main/plugins/browser-automation/browser-cdp-service";
import { SAMPLE_AX_TREE } from "./fixtures/browser-fixtures";

describe("BrowserRefCache", () => {
  it("reset initializes empty caches for a view", () => {
    const cache = new BrowserRefCache();
    cache.reset("v1");
    // After reset, getRefEntry returns undefined
    expect(cache.getRefEntry("v1", "e1")).toBeUndefined();
  });

  it("ensureRef assigns sequential refs", () => {
    const cache = new BrowserRefCache();
    cache.reset("v1");

    const ref1 = cache.ensureRef("v1", 100, { role: "RootWebArea", name: "Home" });
    const ref2 = cache.ensureRef("v1", 200, { role: "button", name: "Click" });

    expect(ref1).toBe("e1");
    expect(ref2).toBe("e2");
  });

  it("ensureRef returns existing ref for the same backendNodeId", () => {
    const cache = new BrowserRefCache();
    cache.reset("v1");

    const ref1 = cache.ensureRef("v1", 100, { role: "button", name: "Click" });
    const ref2 = cache.ensureRef("v1", 100, { role: "button", name: "Click updated" });

    // Same backendNodeId → same ref, but entry is updated
    expect(ref1).toBe(ref2);
    expect(cache.getRefEntry("v1", ref1)?.name).toBe("Click updated");
  });

  it("ensureRef auto-creates view caches if not explicitly reset", () => {
    const cache = new BrowserRefCache();
    // No reset() call — should work anyway
    const ref = cache.ensureRef("v1", 100, { role: "button", name: "Auto" });
    expect(ref).toBe("e1");
  });

  it("getBackendNodeIdForRef returns the mapped backendNodeId", () => {
    const cache = new BrowserRefCache();
    cache.reset("v1");
    cache.ensureRef("v1", 42, { role: "textbox", name: "Email" });

    expect(cache.getBackendNodeIdForRef("e1", "v1")).toBe(42);
  });

  it("getBackendNodeIdForRef throws for unknown ref", () => {
    const cache = new BrowserRefCache();
    cache.reset("v1");

    expect(() => cache.getBackendNodeIdForRef("e999", "v1")).toThrow("Unknown ref @e999");
  });

  it("invalidate is an alias for reset", () => {
    const cache = new BrowserRefCache();
    cache.reset("v1");
    cache.ensureRef("v1", 100, { role: "button", name: "Before" });

    cache.invalidate("v1");

    expect(cache.getRefEntry("v1", "e1")).toBeUndefined();
  });

  it("seedFromAXTree creates refs from AX nodes", () => {
    const cache = new BrowserRefCache();
    cache.reset("v1");

    cache.seedFromAXTree("v1", [...SAMPLE_AX_TREE] as AXNode[]);

    // SAMPLE_AX_TREE has 7 nodes with backendDOMNodeId
    // backendDOMNodeId values: 100, 110, 120, 130, 140, 210, 220
    const ref = cache.getBackendNodeIdForRef("e1", "v1");
    expect(ref).toBe(100); // First node (RootWebArea)
  });

  it("seedFromAXTree skips nodes without backendDOMNodeId", () => {
    const cache = new BrowserRefCache();
    cache.reset("v1");

    const nodes: AXNode[] = [
      { nodeId: "a", role: { value: "button" }, name: { value: "Click" }, backendDOMNodeId: 10 },
      { nodeId: "b", role: { value: "generic" } }, // no backendDOMNodeId
      { nodeId: "c", role: { value: "link" }, name: { value: "Go" }, backendDOMNodeId: 30 },
    ];

    cache.seedFromAXTree("v1", nodes);

    // Only nodes a and c get refs
    expect(cache.getBackendNodeIdForRef("e1", "v1")).toBe(10);
    expect(cache.getBackendNodeIdForRef("e2", "v1")).toBe(30);
    expect(() => cache.getBackendNodeIdForRef("e3", "v1")).toThrow();
  });

  it("ensureRefsForBackendNodeIds resolves refs via getA11yTree", async () => {
    const cache = new BrowserRefCache();
    cache.reset("v1");

    const getA11yTree = vi.fn().mockResolvedValue([...SAMPLE_AX_TREE] as AXNode[]);
    const refs = await cache.ensureRefsForBackendNodeIds("v1", [120, 130], getA11yTree);

    expect(refs).toHaveLength(2);
    expect(getA11yTree).toHaveBeenCalledOnce();

    // Verify the refs map back correctly
    const backendId1 = cache.getBackendNodeIdForRef(refs[0], "v1");
    const backendId2 = cache.getBackendNodeIdForRef(refs[1], "v1");
    expect(backendId1).toBe(120);
    expect(backendId2).toBe(130);
  });

  it("view caches are isolated from each other", () => {
    const cache = new BrowserRefCache();
    cache.reset("v1");
    cache.reset("v2");

    cache.ensureRef("v1", 100, { role: "button", name: "V1 Button" });
    cache.ensureRef("v2", 200, { role: "link", name: "V2 Link" });

    expect(cache.getBackendNodeIdForRef("e1", "v1")).toBe(100);
    expect(cache.getBackendNodeIdForRef("e1", "v2")).toBe(200);

    // Invalidate v1 should not affect v2
    cache.invalidate("v1");
    expect(() => cache.getBackendNodeIdForRef("e1", "v1")).toThrow();
    expect(cache.getBackendNodeIdForRef("e1", "v2")).toBe(200);
  });

  it("getRefEntry returns full entry with metadata", () => {
    const cache = new BrowserRefCache();
    cache.reset("v1");

    cache.ensureRef("v1", 100, {
      role: "textbox",
      name: "Email",
      value: "test@example.com",
      disabled: false,
    });

    const entry = cache.getRefEntry("v1", "e1");
    expect(entry).toEqual({
      backendNodeId: 100,
      role: "textbox",
      name: "Email",
      value: "test@example.com",
      disabled: false,
    });
  });
});
