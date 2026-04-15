// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const updateViewState = vi.fn();
const invoke = vi.fn().mockResolvedValue(undefined);
const viewContext = {
  viewId: "view-1",
  viewState: { url: "https://persisted.example.com" },
  isActive: true,
};

vi.mock("../../src/renderer/src/core/app", () => ({
  useRendererApp: () => ({
    workbench: {
      contentPanel: {
        updateViewState,
      },
    },
  }),
  usePluginContext: () => ({
    orpcClient: {
      browser: {
        attachDevTools: vi.fn().mockResolvedValue(undefined),
        detachDevTools: vi.fn().mockResolvedValue(undefined),
      },
    },
  }),
}));

vi.mock("../../src/renderer/src/features/content-panel/components/view-context", () => ({
  useContentPanelViewContext: () => viewContext,
}));

vi.mock("../../src/renderer/src/plugins/browser/blank-page", () => ({
  BlankPage: () => <div>Blank Browser</div>,
}));

vi.mock("../../src/renderer/src/plugins/browser/inject-react-grab", () => ({
  INJECT_SCRIPT: "/* mock inject script */",
}));

vi.mock("../../src/renderer/src/plugins/browser/nav-bar", () => ({
  NavBar: (props: {
    onNavigate: (url: string) => void;
    onGoBack: () => void;
    onGoForward: () => void;
    onReload: () => void;
    onToggleDevTools: () => void;
    onToggleInspector: () => void;
  }) => (
    <div>
      <button onClick={() => props.onNavigate("https://next.example.com")}>navigate</button>
      <button onClick={props.onGoBack}>back</button>
      <button onClick={props.onGoForward}>forward</button>
      <button onClick={props.onReload}>reload</button>
      <button onClick={props.onToggleDevTools}>devtools</button>
      <button onClick={props.onToggleInspector}>inspector</button>
    </div>
  ),
}));

import BrowserView from "../../src/renderer/src/plugins/browser/browser-view";

describe("BrowserView", () => {
  beforeEach(() => {
    invoke.mockClear();
    updateViewState.mockClear();
    Object.assign(viewContext, {
      viewId: "view-1",
      viewState: { url: "https://persisted.example.com" },
      isActive: true,
    });

    Object.defineProperty(window, "electron", {
      value: {
        ipcRenderer: {
          invoke,
        },
      },
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("registers the webview on dom-ready, tracks the active view, and unregisters on unmount", async () => {
    const { unmount, container } = render(<BrowserView />);
    const webview = container.querySelector("webview") as HTMLElement & {
      getWebContentsId?: () => number;
      canGoBack?: () => boolean;
      canGoForward?: () => boolean;
      executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
    };

    webview.getWebContentsId = () => 42;
    webview.canGoBack = () => false;
    webview.canGoForward = () => false;
    webview.executeJavaScript = vi.fn();

    fireEvent(webview, new Event("dom-ready"));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("browser:registerWebContents", {
        viewId: "view-1",
        webContentsId: 42,
      });
    });

    expect(invoke).toHaveBeenCalledWith("browser:setActiveView", { viewId: "view-1" });

    unmount();

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("browser:unregisterWebContents", { viewId: "view-1" });
    });
  });

  it("injects scripts on dom-ready and navigates using React state", async () => {
    const { container } = render(<BrowserView />);
    const webview = container.querySelector("webview") as HTMLElement & {
      getWebContentsId?: () => number;
      canGoBack?: () => boolean;
      canGoForward?: () => boolean;
      goBack?: () => void;
      goForward?: () => void;
      reload?: () => void;
      executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
    };

    const goBack = vi.fn();
    const goForward = vi.fn();
    const reload = vi.fn();
    const executeJs = vi.fn();

    webview.getWebContentsId = () => 42;
    webview.canGoBack = () => true;
    webview.canGoForward = () => false;
    webview.goBack = goBack;
    webview.goForward = goForward;
    webview.reload = reload;
    webview.executeJavaScript = executeJs;

    // Verify scripts are injected on dom-ready
    fireEvent(webview, new Event("dom-ready"));

    await waitFor(() => {
      expect(executeJs).toHaveBeenCalledTimes(2);
    });

    // First call is INJECT_SCRIPT (react-grab), second is INJECT_NEW_WINDOW_HANDLER
    expect(executeJs).toHaveBeenCalledWith("/* mock inject script */", true);
    expect(executeJs).toHaveBeenCalledWith(expect.stringContaining('target="_blank"'), true);

    // Navigate via NavBar — uses React state (setCurrentUrl), not loadURL
    fireEvent.click(screen.getByText("navigate"));
    expect(updateViewState).toHaveBeenCalledWith("view-1", {
      url: "https://next.example.com",
    });

    // Navigation buttons
    fireEvent.click(screen.getByText("back"));
    expect(goBack).toHaveBeenCalled();

    fireEvent.click(screen.getByText("forward"));
    expect(goForward).toHaveBeenCalled();

    fireEvent.click(screen.getByText("reload"));
    expect(reload).toHaveBeenCalled();
  });
});
