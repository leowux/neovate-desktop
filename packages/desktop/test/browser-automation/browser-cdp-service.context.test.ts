import { beforeEach, describe, expect, it, vi } from "vitest";

import { SAMPLE_AX_TREE, SAMPLE_FRAME_TREE } from "./fixtures/browser-fixtures";
import { FakeWebContents, createBrowserCdpHarness } from "./harness/fake-browser";

function spyOnPrivate<T>(service: T, method: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return vi.spyOn(service as any, method);
}

describe("BrowserCdpService context, environment, and network state", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("lists, opens, switches, and closes tabs", async () => {
    const sendTabCommand = vi.fn(
      (method: string, args: unknown, service: { attachDebugger: Function }) => {
        if (method === "tabNew") {
          queueMicrotask(async () => {
            await service.attachDebugger(
              "view-2",
              new FakeWebContents("https://second.example.com") as never,
            );
          });
        }
      },
    );
    const { service } = await createBrowserCdpHarness({ sendTabCommand });

    const listBefore = await service.tab({ action: "list" });
    expect(listBefore).toContain("[0]");
    expect(listBefore).toContain("about:blank");

    await expect(service.tab({ action: "new", url: "second.example.com" })).resolves.toBe(
      "Opened new tab: https://second.example.com",
    );

    const listAfter = await service.tab({ action: "list" });
    expect(listAfter).toContain("[1]");
    expect(listAfter).toContain("https://second.example.com");

    await expect(service.tab({ action: "switch", index: 0 })).resolves.toBe("Switched to tab 0");
    await expect(service.tab({ action: "close", index: 1 })).resolves.toBe("Closed tab 1");
  });

  it("switches frame contexts via main, ref, selector, and match", async () => {
    const { service } = await createBrowserCdpHarness();
    spyOnPrivate(service, "getA11yTree").mockResolvedValue([...SAMPLE_AX_TREE]);
    spyOnPrivate(service, "getFrameIdFromRef").mockResolvedValue("payment-frame");
    spyOnPrivate(service, "resolveSelectorToBackendNodeId").mockResolvedValue(140);
    spyOnPrivate(service, "getFrameIdFromBackendNode").mockResolvedValue("payment-frame");
    spyOnPrivate(service, "getFrameTree").mockResolvedValue(SAMPLE_FRAME_TREE);

    await service.snapshot();

    await expect(service.frame({ ref: "@e5" })).resolves.toBe("Switched to frame payment-frame");
    await expect(service.frame({ selector: "#payment-frame" })).resolves.toBe(
      "Switched to frame payment-frame",
    );
    await expect(service.frame({ match: "pay.example.com" })).resolves.toBe(
      "Switched to frame payment-frame",
    );
    await expect(service.frame({ target: "main" })).resolves.toBe("Switched to main frame");
  });

  it("tracks dialogs, including auto-accept for alerts", async () => {
    const { service, debuggerClient } = await createBrowserCdpHarness();
    const sendCommand = spyOnPrivate(service, "sendCommand").mockResolvedValue({});

    debuggerClient.emit("Page.javascriptDialogOpening", {
      type: "alert",
      message: "Heads up",
      url: "https://shop.example.com",
    });
    await Promise.resolve();
    expect(sendCommand).toHaveBeenCalledWith(
      "Page.handleJavaScriptDialog",
      { accept: true },
      "view-1",
    );
    await expect(service.dialog({ action: "status" })).resolves.toBe("(no dialog open)");

    debuggerClient.emit("Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Delete?",
      url: "https://shop.example.com",
    });

    await expect(service.dialog({ action: "status" })).resolves.toContain('"message": "Delete?"');
    await expect(service.dialog({ action: "accept", text: "yes" })).resolves.toBe(
      "Accepted dialog",
    );
    expect(sendCommand).toHaveBeenLastCalledWith(
      "Page.handleJavaScriptDialog",
      { accept: true, promptText: "yes" },
      "view-1",
    );
  });

  it("updates viewport, media, cookies, and localStorage", async () => {
    const { service } = await createBrowserCdpHarness({ initialUrl: "https://shop.example.com" });
    const sendCommand = spyOnPrivate(service, "sendCommand").mockImplementation(async (method) => {
      if (method === "Network.getCookies") {
        return { cookies: [{ name: "sid", value: "123" }] };
      }
      return {};
    });
    spyOnPrivate(service, "evaluateInCurrentFrame").mockImplementation(async (expression) => {
      if (expression === "Object.fromEntries(Object.entries(localStorage))") {
        return { theme: "dark" };
      }
      if (String(expression).includes("localStorage.getItem")) return "dark";
      return undefined;
    });

    await expect(service.set({ kind: "viewport", width: 1280, height: 720 })).resolves.toBe(
      "Viewport set to 1280x720",
    );
    await expect(
      service.set({ kind: "media", colorScheme: "dark", reducedMotion: true }),
    ).resolves.toBe("Media emulation updated");
    await expect(service.cookies({ action: "get" })).resolves.toContain('"sid"');
    await expect(service.cookies({ action: "set", name: "sid", value: "456" })).resolves.toBe(
      "Cookie set: sid",
    );
    await expect(service.storage({ action: "getAll" })).resolves.toContain('"theme": "dark"');
    await expect(service.storage({ action: "get", key: "theme" })).resolves.toBe("dark");
    await expect(service.storage({ action: "set", key: "theme", value: "light" })).resolves.toBe(
      "Stored theme",
    );
    await expect(service.storage({ action: "clear" })).resolves.toBe("Cleared localStorage");

    expect(sendCommand).toHaveBeenCalled();
  });

  it("records network requests and applies route rules", async () => {
    const { service, debuggerClient } = await createBrowserCdpHarness();
    const sendCommand = spyOnPrivate(service, "sendCommand").mockResolvedValue({});

    debuggerClient.emit("Network.requestWillBeSent", {
      requestId: "req-1",
      type: "XHR",
      request: { url: "https://api.example.com/orders", method: "GET" },
    });
    debuggerClient.emit("Network.responseReceived", {
      requestId: "req-1",
      response: { status: 200 },
    });
    debuggerClient.emit("Network.loadingFinished", {
      requestId: "req-1",
    });

    await expect(service.network({ action: "requests" })).resolves.toContain(
      "GET https://api.example.com/orders 200",
    );
    await expect(
      service.network({ action: "route", pattern: "https://api.example.com/orders", abort: true }),
    ).resolves.toBe("Added route for https://api.example.com/orders");

    debuggerClient.emit("Fetch.requestPaused", {
      requestId: "paused-1",
      request: { url: "https://api.example.com/orders" },
    });
    await Promise.resolve();

    expect(sendCommand).toHaveBeenCalledWith(
      "Fetch.failRequest",
      { requestId: "paused-1", errorReason: "Aborted" },
      "view-1",
    );

    await expect(
      service.network({ action: "unroute", pattern: "https://api.example.com/orders" }),
    ).resolves.toBe("Removed route for https://api.example.com/orders");
  });
});
