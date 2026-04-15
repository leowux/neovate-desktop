import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SAMPLE_AX_TREE, SAMPLE_BOX_MODEL } from "./fixtures/browser-fixtures";
import { createBrowserCdpHarness } from "./harness/fake-browser";

/** Spy on a private method and return a properly-typed mock. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function spyOnPrivate<T>(service: T, method: string) {
  return vi.spyOn(service as any, method);
}

describe("BrowserCdpService actions and diagnostics", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens, goes back, goes forward, and reloads pages", async () => {
    const { service, webContents } = await createBrowserCdpHarness({
      initialUrl: "https://initial.example.com",
    });
    const invalidateRefs = vi.spyOn((service as any).refs, "invalidate");

    await expect(service.open("example.com")).resolves.toBe("Opened https://example.com");
    expect(webContents.loadURL).toHaveBeenCalledWith("https://example.com");

    await service.open("https://second.example.com");
    await expect(service.back()).resolves.toBe("Navigated back");
    await expect(service.forward()).resolves.toBe("Navigated forward");
    await expect(service.reload()).resolves.toBe("Reloaded page");

    expect(invalidateRefs).toHaveBeenCalled();
  });

  it("clicks refs and can open links in a new tab", async () => {
    const { service, debuggerClient } = await createBrowserCdpHarness();
    spyOnPrivate(service, "getA11yTree").mockResolvedValue([...SAMPLE_AX_TREE]);
    spyOnPrivate(service, "resolveRefPosition").mockResolvedValue({ x: 60, y: 40 });
    spyOnPrivate(service, "waitForPotentialNavigation").mockResolvedValue(undefined);
    spyOnPrivate(service, "getAttribute").mockResolvedValue("https://pay.example.com");
    const tabSpy = vi
      .spyOn(service, "tab")
      .mockResolvedValue("Opened new tab: https://pay.example.com");

    await service.snapshot();

    await expect(service.click("@e4")).resolves.toBe("Clicked @e4");
    expect(
      debuggerClient.calls.filter((call) => call.method === "Input.dispatchMouseEvent"),
    ).toHaveLength(2);

    await expect(service.click("@e4", true)).resolves.toBe("Opened @e4 in a new tab");
    expect(tabSpy).toHaveBeenCalledWith({ action: "new", url: "https://pay.example.com" });
  });

  it("fills and types via in-page editing without native keyboard injection", async () => {
    const { service, debuggerClient } = await createBrowserCdpHarness();
    vi.spyOn((service as any).refs, "getBackendNodeIdForRef").mockReturnValue(120);
    spyOnPrivate(service, "resolveObjectIdForBackendNode").mockResolvedValue("node-120");

    debuggerClient.setHandler("Runtime.callFunctionOn", (params) => ({
      result: { value: { ok: true, args: params?.arguments } },
    }));

    await expect(service.fill("e3", "first@example.com")).resolves.toBe("Filled @e3");
    await expect(service.type("@e3", " more")).resolves.toBe("Typed into @e3");

    const editCalls = debuggerClient.calls.filter(
      (call) => call.method === "Runtime.callFunctionOn",
    );
    expect(editCalls).toHaveLength(2);
    expect(editCalls[0]?.params).toMatchObject({
      objectId: "node-120",
      arguments: [{ value: "first@example.com" }, { value: "replace" }],
      awaitPromise: true,
      returnByValue: true,
    });
    expect(editCalls[1]?.params).toMatchObject({
      objectId: "node-120",
      arguments: [{ value: " more" }, { value: "insert" }],
      awaitPromise: true,
      returnByValue: true,
    });
    expect(debuggerClient.calls.some((call) => call.method === "Input.insertText")).toBe(false);
  });

  it("rejects fill when the target is not actually editable", async () => {
    const { service, debuggerClient } = await createBrowserCdpHarness();
    vi.spyOn((service as any).refs, "getBackendNodeIdForRef").mockReturnValue(999);
    spyOnPrivate(service, "resolveObjectIdForBackendNode").mockResolvedValue("node-999");

    debuggerClient.setHandler("Runtime.callFunctionOn", () => ({
      result: { value: { ok: false, error: "Element is not fillable" } },
    }));

    await expect(service.fill("@e9", "hello")).rejects.toThrow("Element is not fillable");
  });

  it("supports select, scroll, drag, upload, and scroll-into-view", async () => {
    const { service, debuggerClient } = await createBrowserCdpHarness();
    spyOnPrivate(service, "getA11yTree").mockResolvedValue([...SAMPLE_AX_TREE]);
    spyOnPrivate(service, "resolveObjectIdForBackendNode").mockResolvedValue("node-130");
    spyOnPrivate(service, "resolveRefPosition").mockImplementation(async (ref) => {
      if (ref === "e7") return { x: 100, y: 200 };
      return { x: 60, y: 40 };
    });
    spyOnPrivate(service, "getViewportCenter").mockResolvedValue({ x: 400, y: 300 });

    debuggerClient.setHandler("Runtime.callFunctionOn", (params) => {
      if (String(params?.functionDeclaration).includes("selectedOptions")) {
        return { result: { value: { ok: true, selected: ["Visa"] } } };
      }
      return { result: { value: true } };
    });
    debuggerClient.setHandler("DOM.scrollIntoViewIfNeeded", () => {
      throw new Error("fall back to scrollIntoView");
    });

    await service.snapshot();

    await expect(service.scroll()).resolves.toBe("Scrolled down by 300px");
    await expect(service.scrollIntoView("@e4")).resolves.toBe("Scrolled @e4 into view");
    await expect(service.select("@e4", ["visa"])).resolves.toBe("Selected Visa");
    await service.snapshot();
    await expect(service.drag("@e4", "@e7")).resolves.toBe("Dragged @e4 to @e7");
    await service.snapshot();
    await expect(service.upload("@e4", ["./package.json"])).resolves.toBe("Uploaded 1 file(s)");

    expect(debuggerClient.calls.some((call) => call.method === "DOM.setFileInputFiles")).toBe(true);
  });

  it("reads element and page state via browser_get and browser_is", async () => {
    const { service, webContents } = await createBrowserCdpHarness({
      initialUrl: "https://shop.example.com/checkout",
    });
    spyOnPrivate(service, "getA11yTree").mockResolvedValue([...SAMPLE_AX_TREE]);
    spyOnPrivate(service, "resolveSingleRefFromSelector").mockResolvedValue("e3");
    spyOnPrivate(service, "callOnRefNode").mockImplementation(async (_ref, fn) => {
      const code = String(fn);
      if (code.includes("innerText")) return "Checkout form";
      if (code.includes("innerHTML")) return "<span>Checkout</span>";
      if (code.includes("'value' in this")) return "user@example.com";
      if (code.includes("getAttribute")) return "https://pay.example.com";
      if (code.includes("getComputedStyle")) {
        return {
          display: "block",
          visibility: "visible",
          opacity: "1",
          color: "rgb(0, 0, 0)",
          backgroundColor: "rgb(255, 255, 255)",
          fontFamily: "sans-serif",
          fontSize: "14px",
          fontWeight: "400",
          width: "100px",
          height: "40px",
        };
      }
      if (code.includes('case "visible"')) return true;
      return false;
    });
    spyOnPrivate(service, "evaluateInCurrentFrame").mockImplementation(async (expression) => {
      if (String(expression).includes("querySelectorAll")) return 3;
      return undefined;
    });
    spyOnPrivate(service, "sendCommand").mockImplementation(async (method) => {
      if (method === "DOM.getBoxModel") return { model: SAMPLE_BOX_MODEL };
      return {};
    });

    await webContents.loadURL("https://shop.example.com/checkout");
    await service.snapshot();

    await expect(service.get({ kind: "title" })).resolves.toBe("shop.example.com");
    await expect(service.get({ kind: "url" })).resolves.toBe("https://shop.example.com/checkout");
    await expect(service.get({ kind: "text", selector: "h1" })).resolves.toBe("Checkout form");
    await expect(service.get({ kind: "html", ref: "@e3" })).resolves.toBe("<span>Checkout</span>");
    await expect(service.get({ kind: "value", ref: "@e3" })).resolves.toBe("user@example.com");
    await expect(service.get({ kind: "attr", ref: "@e4", name: "href" })).resolves.toBe(
      "https://pay.example.com",
    );
    await expect(service.get({ kind: "count", selector: ".item" })).resolves.toBe("3");
    await expect(service.get({ kind: "box", ref: "@e4" })).resolves.toContain('"width": 100');
    await expect(service.get({ kind: "styles", ref: "@e4" })).resolves.toContain(
      '"display": "block"',
    );
    await expect(service.is({ kind: "visible", ref: "@e4" })).resolves.toBe("true");
  });

  it("waits for milliseconds, url matches, load states, and JS predicates", async () => {
    const { service } = await createBrowserCdpHarness({
      initialUrl: "https://shop.example.com/dashboard",
    });
    await service.open("https://shop.example.com/dashboard");
    vi.useFakeTimers();
    spyOnPrivate(service, "resolveRefPosition").mockResolvedValue({ x: 10, y: 10 });
    spyOnPrivate(service, "waitForLoadState").mockResolvedValue(true);
    spyOnPrivate(service, "evaluateInCurrentFrame").mockImplementation(async (expression) => {
      if (expression === "window.__ready__ === true") return true;
      return undefined;
    });

    const msWait = service.wait({ ms: 250 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(msWait).resolves.toBe("Waited 250ms");

    vi.useRealTimers();
    spyOnPrivate(service, "pollUntil").mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (predicate: any) => predicate(),
    );

    await expect(service.wait({ ref: "@e4" })).resolves.toBe("Element @e4 is available");
    await expect(service.wait({ urlPattern: "**/dashboard" })).resolves.toBe(
      "URL matched **/dashboard",
    );
    await expect(service.wait({ loadState: "networkidle" })).resolves.toBe(
      "Load state reached: networkidle",
    );
    await expect(service.wait({ js: "window.__ready__ === true" })).resolves.toBe(
      "JavaScript condition satisfied",
    );
    await expect(service.wait({ ref: "@e4", ms: 1 })).rejects.toThrow(
      "browser_wait requires exactly one of ref, ms, text, urlPattern, loadState, or js",
    );
  });

  it("buffers console and page errors, highlights refs, evaluates code, and captures screenshots", async () => {
    const { service, webContents, debuggerClient } = await createBrowserCdpHarness();
    spyOnPrivate(service, "getA11yTree").mockResolvedValue([...SAMPLE_AX_TREE]);
    vi.spyOn((service as any).refs, "getBackendNodeIdForRef").mockReturnValue(130);
    spyOnPrivate(service, "evaluateInCurrentFrame").mockResolvedValue({ ok: true });
    spyOnPrivate(service, "captureScreenshot").mockResolvedValue(
      "data:image/png;base64,ZmFrZS1pbWFnZQ==",
    );

    await service.snapshot();
    debuggerClient.emit("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ value: "hello" }],
    });
    debuggerClient.emit("Runtime.exceptionThrown", {
      exceptionDetails: { text: "boom" },
    });

    expect(service.console({ action: "get" })).toContain("[LOG] hello");
    expect(service.errors({ action: "get" })).toContain("boom");
    expect(service.console({ action: "clear" })).toBe("Cleared console logs");
    expect(service.errors({ action: "clear" })).toBe("Cleared page errors");

    await expect(service.highlight("@e4")).resolves.toBe("Highlighted @e4");
    await expect(service.highlight(undefined, true)).resolves.toBe("Cleared highlight");
    await expect(service.eval("({ ok: true })")).resolves.toEqual({ ok: true });
    await expect(service.screenshot(true)).resolves.toBe("data:image/png;base64,ZmFrZS1pbWFnZQ==");
    expect(service.inspect()).toBe("Opened DevTools");
    expect(webContents.openDevTools).toHaveBeenCalled();
  });
});
