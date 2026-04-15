import { beforeEach, describe, expect, it, vi } from "vitest";

import { SAMPLE_AX_TREE } from "./fixtures/browser-fixtures";
import { createBrowserCdpHarness } from "./harness/fake-browser";

/** Spy on a private method and return a properly-typed mock. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function spyOnPrivate<T>(service: T, method: string) {
  return vi.spyOn(service as any, method);
}

describe("BrowserCdpService keyboard and mouse interactions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("double-clicks a ref with clickCount=2 on second dispatch", async () => {
    const { service, debuggerClient } = await createBrowserCdpHarness();
    spyOnPrivate(service, "getA11yTree").mockResolvedValue([...SAMPLE_AX_TREE]);
    spyOnPrivate(service, "resolveRefPosition").mockResolvedValue({ x: 60, y: 40 });
    spyOnPrivate(service, "waitForPotentialNavigation").mockResolvedValue(undefined);

    await service.snapshot();

    await expect(service.dblclick("@e4")).resolves.toBe("Double-clicked @e4");

    const mouseCalls = debuggerClient.calls.filter(
      (call) => call.method === "Input.dispatchMouseEvent",
    );
    // dblclick dispatches 4 mouse events: clickCount=1 pressed+released, clickCount=2 pressed+released
    expect(mouseCalls).toHaveLength(4);
    expect(mouseCalls[0]?.params).toMatchObject({ type: "mousePressed", clickCount: 1 });
    expect(mouseCalls[1]?.params).toMatchObject({ type: "mouseReleased", clickCount: 1 });
    expect(mouseCalls[2]?.params).toMatchObject({ type: "mousePressed", clickCount: 2 });
    expect(mouseCalls[3]?.params).toMatchObject({ type: "mouseReleased", clickCount: 2 });
  });

  it("focuses a ref via callOnRefNode", async () => {
    const { service, debuggerClient } = await createBrowserCdpHarness();
    vi.spyOn((service as any).refs, "getBackendNodeIdForRef").mockReturnValue(130);
    spyOnPrivate(service, "resolveObjectIdForBackendNode").mockResolvedValue("node-130");
    debuggerClient.setHandler("Runtime.callFunctionOn", () => ({
      result: { value: true },
    }));

    await expect(service.focus("@e4")).resolves.toBe("Focused @e4");

    const callCall = debuggerClient.calls.find((call) => call.method === "Runtime.callFunctionOn");
    expect(callCall?.params).toMatchObject({
      objectId: "node-130",
      functionDeclaration: expect.stringContaining("this.focus()"),
      returnByValue: true,
      awaitPromise: true,
    });
  });

  it("presses a key combo via Input.dispatchKeyEvent", async () => {
    const { service, debuggerClient } = await createBrowserCdpHarness();
    spyOnPrivate(service, "grantWebviewFocus").mockReturnValue(undefined);

    await expect(service.press("Enter")).resolves.toBe("Pressed Enter");

    const keyCalls = debuggerClient.calls.filter(
      (call) => call.method === "Input.dispatchKeyEvent",
    );
    expect(keyCalls).toHaveLength(2);
    expect(keyCalls[0]?.params).toMatchObject({ type: "keyDown", key: "Enter" });
    expect(keyCalls[1]?.params).toMatchObject({ type: "keyUp", key: "Enter" });
  });

  it("presses a modifier combo (e.g. Control+a)", async () => {
    const { service, debuggerClient } = await createBrowserCdpHarness();
    spyOnPrivate(service, "grantWebviewFocus").mockReturnValue(undefined);

    await expect(service.press("Control+a")).resolves.toBe("Pressed Control+a");

    const keyCalls = debuggerClient.calls.filter(
      (call) => call.method === "Input.dispatchKeyEvent",
    );
    expect(keyCalls).toHaveLength(2);
    // modifierFlag("control") = 2
    expect(keyCalls[0]?.params).toMatchObject({ type: "keyDown", key: "a", modifiers: 2 });
    expect(keyCalls[1]?.params).toMatchObject({ type: "keyUp", key: "a", modifiers: 2 });
  });

  it("holds and releases a key with keyDown/keyUp", async () => {
    const { service, debuggerClient } = await createBrowserCdpHarness();
    spyOnPrivate(service, "grantWebviewFocus").mockReturnValue(undefined);

    await expect(service.keyDown("Shift")).resolves.toBe("Held Shift");

    let keyCalls = debuggerClient.calls.filter((call) => call.method === "Input.dispatchKeyEvent");
    expect(keyCalls).toHaveLength(1);
    expect(keyCalls[0]?.params).toMatchObject({ type: "keyDown", key: "Shift" });

    // heldKeys should be tracked in session
    const _session = spyOnPrivate(service, "getViewSession").mock.results[0]?.value;
    // The session is accessed internally; verify keyUp clears the held key
    void _session;

    await expect(service.keyUp("Shift")).resolves.toBe("Released Shift");

    keyCalls = debuggerClient.calls.filter((call) => call.method === "Input.dispatchKeyEvent");
    expect(keyCalls).toHaveLength(2);
    expect(keyCalls[1]?.params).toMatchObject({ type: "keyUp", key: "Shift" });
  });

  it("hovers over a ref via Input.dispatchMouseEvent mouseMoved", async () => {
    const { service, debuggerClient } = await createBrowserCdpHarness();
    spyOnPrivate(service, "getA11yTree").mockResolvedValue([...SAMPLE_AX_TREE]);
    spyOnPrivate(service, "resolveRefPosition").mockResolvedValue({ x: 100, y: 200 });

    await service.snapshot();

    await expect(service.hover("@e4")).resolves.toBe("Hovered @e4");

    const mouseCalls = debuggerClient.calls.filter(
      (call) => call.method === "Input.dispatchMouseEvent",
    );
    expect(mouseCalls).toHaveLength(1);
    expect(mouseCalls[0]?.params).toMatchObject({
      type: "mouseMoved",
      x: 100,
      y: 200,
    });
  });

  it("checks a checkbox by clicking when unchecked", async () => {
    const { service } = await createBrowserCdpHarness();
    vi.spyOn((service as any).refs, "getBackendNodeIdForRef").mockReturnValue(130);
    spyOnPrivate(service, "resolveObjectIdForBackendNode").mockResolvedValue("node-130");
    spyOnPrivate(service, "callOnRefNode").mockResolvedValue(false); // currently unchecked
    const clickSpy = vi.spyOn(service, "click").mockResolvedValue("Clicked @e4");

    await expect(service.check("@e4")).resolves.toBe("Checked @e4");
    expect(clickSpy).toHaveBeenCalledWith("e4", false, "view-1");
  });

  it("unchecks a checkbox by clicking when checked", async () => {
    const { service } = await createBrowserCdpHarness();
    vi.spyOn((service as any).refs, "getBackendNodeIdForRef").mockReturnValue(130);
    spyOnPrivate(service, "resolveObjectIdForBackendNode").mockResolvedValue("node-130");
    spyOnPrivate(service, "callOnRefNode").mockResolvedValue(true); // currently checked
    const clickSpy = vi.spyOn(service, "click").mockResolvedValue("Clicked @e4");

    await expect(service.uncheck("@e4")).resolves.toBe("Unchecked @e4");
    expect(clickSpy).toHaveBeenCalledWith("e4", false, "view-1");
  });

  it("skips click when check state already matches", async () => {
    const { service } = await createBrowserCdpHarness();
    vi.spyOn((service as any).refs, "getBackendNodeIdForRef").mockReturnValue(130);
    spyOnPrivate(service, "resolveObjectIdForBackendNode").mockResolvedValue("node-130");
    spyOnPrivate(service, "callOnRefNode").mockResolvedValue(true); // already checked
    const clickSpy = vi.spyOn(service, "click").mockResolvedValue("Clicked @e4");

    await expect(service.check("@e4")).resolves.toBe("Checked @e4");
    // Already checked → no click needed
    expect(clickSpy).not.toHaveBeenCalled();
  });
});
