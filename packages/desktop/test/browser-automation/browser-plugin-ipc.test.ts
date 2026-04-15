import { beforeEach, describe, expect, it, vi } from "vitest";

describe("browser automation main plugin IPC", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("registers IPC handlers and bridges browser tab commands through the main window", async () => {
    const handlers = new Map<string, Function>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: Function) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    };
    const wcFromId = vi.fn();
    const mainWindowSend = vi.fn();
    const attachDebugger = vi.fn();
    const detachDebugger = vi.fn();
    const setActiveView = vi.fn();
    const dispose = vi.fn();
    let tabBridge: ((method: string, args: unknown) => void) | null = null;

    vi.doMock("electron", () => ({
      ipcMain,
      webContents: { fromId: wcFromId },
    }));
    vi.doMock("../../src/main/plugins/browser-automation/browser-cdp-service", () => ({
      BrowserCdpService: class BrowserCdpService {
        constructor(callback: (method: string, args: unknown) => void) {
          tabBridge = callback;
        }

        resetSession = vi.fn();
        attachDebugger = attachDebugger;
        detachDebugger = detachDebugger;
        setActiveView = setActiveView;
        dispose = dispose;
      },
    }));
    vi.doMock("../../src/main/plugins/browser-automation/mcp-server", () => ({
      createBrowserMcpServer: vi.fn(() => ({
        type: "sdk",
        name: "browser-automation",
        instance: { id: Symbol("mcp") },
      })),
    }));

    const mod = await import("../../src/main/plugins/browser-automation/index");
    const plugin = mod.default;
    const ctx = {
      app: {
        windowManager: { mainWindow: { webContents: { send: mainWindowSend } } },
        subscriptions: { push: vi.fn() },
      },
    } as never;

    plugin.configContributions!(ctx);

    expect(mod.createFreshBrowserMcpServer()).toMatchObject({
      type: "sdk",
      name: "browser-automation",
    });

    tabBridge!("tabNew", { url: "https://example.com" });
    expect(mainWindowSend).toHaveBeenCalledWith("nv:browser-tab-cmd", {
      method: "tabNew",
      args: { url: "https://example.com" },
    });

    plugin.activate!(ctx);

    const fakeWebContents = { id: 99 };
    wcFromId.mockReturnValue(fakeWebContents);

    await handlers.get("browser:registerWebContents")?.({} as never, {
      viewId: "view-1",
      webContentsId: 99,
    });
    await handlers.get("browser:unregisterWebContents")?.({} as never, { viewId: "view-1" });
    await handlers.get("browser:setActiveView")?.({} as never, { viewId: "view-1" });

    expect(attachDebugger).toHaveBeenCalledWith("view-1", fakeWebContents);
    expect(detachDebugger).toHaveBeenCalledWith("view-1");
    expect(setActiveView).toHaveBeenCalledWith("view-1");

    plugin.deactivate?.();
    expect(dispose).toHaveBeenCalled();
  });
});

describe("browser renderer plugin tab routing", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("routes tabNew, tabSwitch, and tabClose commands to the content panel", async () => {
    const openView = vi.fn();
    const activateView = vi.fn();
    const closeView = vi.fn();
    const cleanup = vi.fn();
    let listener: ((cmd: { method: string; args: unknown }) => void) | undefined;

    Object.defineProperty(globalThis, "window", {
      value: {
        api: {
          onBrowserTabCommand: vi.fn((cb: typeof listener) => {
            listener = cb;
            return cleanup;
          }),
        },
      },
      configurable: true,
    });

    const browserPlugin = (await import("../../src/renderer/src/plugins/browser")).default;
    const plugin = browserPlugin();
    const ctx = {
      app: {
        workbench: {
          contentPanel: {
            openView,
            activateView,
            closeView,
          },
        },
      },
    } as never;

    plugin.activate?.(ctx);

    listener?.({ method: "tabNew", args: { url: "https://example.com" } });
    listener?.({ method: "tabSwitch", args: { viewId: "view-2" } });
    listener?.({ method: "tabClose", args: { viewId: "view-2" } });

    expect(openView).toHaveBeenCalledWith("browser", { state: { url: "https://example.com" } });
    expect(activateView).toHaveBeenCalledWith("view-2");
    expect(closeView).toHaveBeenCalledWith("view-2");

    plugin.deactivate?.();
    expect(cleanup).toHaveBeenCalled();
  });
});
