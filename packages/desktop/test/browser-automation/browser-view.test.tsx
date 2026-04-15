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
}));

vi.mock("../../src/renderer/src/features/content-panel/components/view-context", () => ({
  useContentPanelViewContext: () => viewContext,
}));

vi.mock("../../src/renderer/src/plugins/browser/blank-page", () => ({
  BlankPage: () => <div>Blank Browser</div>,
}));

vi.mock("../../src/renderer/src/plugins/browser/nav-bar", () => ({
  NavBar: (props: {
    onNavigate: (url: string) => void;
    onGoBack: () => void;
    onGoForward: () => void;
    onReload: () => void;
    onOpenDevTools: () => void;
  }) => (
    <div>
      <button onClick={() => props.onNavigate("https://next.example.com")}>navigate</button>
      <button onClick={props.onGoBack}>back</button>
      <button onClick={props.onGoForward}>forward</button>
      <button onClick={props.onReload}>reload</button>
      <button onClick={props.onOpenDevTools}>devtools</button>
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
      loadURL?: (url: string) => void;
      goBack?: () => void;
      goForward?: () => void;
      reload?: () => void;
      openDevTools?: () => void;
      executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
    };

    webview.getWebContentsId = () => 42;
    webview.loadURL = vi.fn();
    webview.goBack = vi.fn();
    webview.goForward = vi.fn();
    webview.reload = vi.fn();
    webview.openDevTools = vi.fn();
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

  it("navigates with webview.loadURL instead of mutating the src attribute", async () => {
    const { container } = render(<BrowserView />);
    const webview = container.querySelector("webview") as HTMLElement & {
      loadURL?: (url: string) => void;
      goBack?: () => void;
      goForward?: () => void;
      reload?: () => void;
      openDevTools?: () => void;
      getWebContentsId?: () => number;
      executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
    };
    const loadURL = vi.fn();
    const goBack = vi.fn();
    const goForward = vi.fn();
    const reload = vi.fn();
    const openDevTools = vi.fn();

    webview.loadURL = loadURL;
    webview.goBack = goBack;
    webview.goForward = goForward;
    webview.reload = reload;
    webview.openDevTools = openDevTools;
    webview.getWebContentsId = () => 42;
    webview.executeJavaScript = vi.fn();

    expect(webview.getAttribute("src")).toBe("https://persisted.example.com");

    fireEvent.click(screen.getByText("navigate"));
    fireEvent.click(screen.getByText("back"));
    fireEvent.click(screen.getByText("forward"));
    fireEvent.click(screen.getByText("reload"));
    fireEvent.click(screen.getByText("devtools"));

    expect(loadURL).toHaveBeenCalledWith("https://next.example.com");
    expect(updateViewState).toHaveBeenCalledWith("view-1", {
      url: "https://next.example.com",
    });
    expect(goBack).toHaveBeenCalled();
    expect(goForward).toHaveBeenCalled();
    expect(reload).toHaveBeenCalled();
    expect(openDevTools).toHaveBeenCalled();
    expect(webview.getAttribute("src")).toBe("https://persisted.example.com");
  });
});
