import { beforeEach, describe, expect, it, vi } from "vitest";

import { SAMPLE_AX_TREE } from "./fixtures/browser-fixtures";
import { createBrowserCdpHarness } from "./harness/fake-browser";

function spyOnPrivate<T>(service: T, method: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return vi.spyOn(service as any, method);
}

describe("BrowserCdpService snapshot and find", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the full accessibility tree by default", async () => {
    const { service } = createBrowserCdpHarness();
    spyOnPrivate(service, "getA11yTree").mockResolvedValue([...SAMPLE_AX_TREE]);

    const snapshot = await service.snapshot();

    expect(snapshot).toContain('@e1 [RootWebArea] "Checkout"');
    expect(snapshot).toContain('  @e2 [heading] "Checkout form"');
    expect(snapshot).toContain('  @e3 [textbox] "Email" value="user@example.com"');
    expect(snapshot).toContain('  @e4 [button] "Submit order"');
    expect(snapshot).toContain('  @e5 [Iframe] "payment-frame"');
    expect(snapshot).toContain('    @e6 [textbox] "Card number"');
    expect(snapshot).toContain('    @e7 [button] "Pay"');
  });

  it("returns the compact interactive-only view", async () => {
    const { service } = createBrowserCdpHarness();
    spyOnPrivate(service, "getA11yTree").mockResolvedValue([...SAMPLE_AX_TREE]);

    const snapshot = await service.snapshot({ interactiveOnly: true, compact: true });

    expect(snapshot).toBe(
      [
        '@e3 [textbox] "Email"',
        '@e4 [button] "Submit order"',
        '@e6 [textbox] "Card number"',
        '@e7 [button] "Pay"',
      ].join("\n"),
    );
  });

  it("supports scoped snapshots, depth limiting, and focused markers", async () => {
    const { service } = createBrowserCdpHarness();
    spyOnPrivate(service, "getA11yTree").mockResolvedValue([...SAMPLE_AX_TREE]);

    await service.snapshot();
    const scoped = await service.snapshot({
      scopeRef: "@e5",
      depth: 1,
      focused: true,
    });

    expect(scoped).toContain('@e5 [Iframe] "payment-frame"');
    expect(scoped).toContain('  @e6 [textbox] "Card number" (focused)');
    expect(scoped).toContain('  @e7 [button] "Pay"');
    expect(scoped).not.toContain("Checkout form");
  });

  it("rejects mutually exclusive scopeRef and scopeSelector", async () => {
    const { service } = createBrowserCdpHarness();
    spyOnPrivate(service, "getA11yTree").mockResolvedValue([...SAMPLE_AX_TREE]);

    await service.snapshot();

    await expect(
      service.snapshot({ scopeRef: "@e5", scopeSelector: "#payment-frame" }),
    ).rejects.toThrow("scopeRef and scopeSelector are mutually exclusive");
  });

  it("scopes snapshots to the active frame owner when a frame is selected", async () => {
    const { service } = createBrowserCdpHarness();
    spyOnPrivate(service, "getA11yTree").mockResolvedValue([...SAMPLE_AX_TREE]);
    spyOnPrivate(service, "getFrameTree").mockResolvedValue({
      frame: { id: "main-frame", url: "https://shop.example.com", name: "main" },
      childFrames: [
        {
          frame: {
            id: "payment-frame",
            url: "https://pay.example.com/frame",
            name: "payment-frame",
            parentId: "main-frame",
          },
        },
      ],
    });
    spyOnPrivate(service, "getFrameOwnerBackendNodeId").mockResolvedValue(140);

    await service.frame({ match: "payment-frame" });
    const snapshot = await service.snapshot();

    expect(snapshot).toContain('@e5 [Iframe] "payment-frame"');
    expect(snapshot).toContain('  @e6 [textbox] "Card number"');
    expect(snapshot).not.toContain("Checkout form");
  });

  it("returns refs and previews for find results", async () => {
    const { service } = createBrowserCdpHarness();
    spyOnPrivate(service, "getA11yTree").mockResolvedValue([...SAMPLE_AX_TREE]);
    spyOnPrivate(service, "findBackendNodeIds").mockResolvedValue([210, 220]);

    await service.snapshot();
    const result = await service.find({ by: "text", value: "Pay", all: true });

    expect(result).toBe(
      ["Found 2 match(es):", '@e6 [textbox] "Card number"', '@e7 [button] "Pay"'].join("\n"),
    );
  });

  it("returns a stable empty message when find misses", async () => {
    const { service } = createBrowserCdpHarness();
    spyOnPrivate(service, "getA11yTree").mockResolvedValue([...SAMPLE_AX_TREE]);
    spyOnPrivate(service, "findBackendNodeIds").mockResolvedValue([]);

    await expect(service.find({ by: "selector", value: ".missing" })).resolves.toBe(
      "No matching elements found",
    );
  });
});
