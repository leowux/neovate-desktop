import { useCallback, useEffect, useRef, useState } from "react";

import { useRendererApp } from "../../core/app";
import { BrowserAutomationService } from "../../features/browser-automation/service";
import { useContentPanelViewContext } from "../../features/content-panel/components/view-context";
import { BlankPage } from "./blank-page";
import { INJECT_SCRIPT } from "./inject-react-grab";
import { NavBar } from "./nav-bar";

export default function BrowserView() {
  const { viewId, viewState } = useContentPanelViewContext();
  const app = useRendererApp();
  const contentPanel = app.workbench.contentPanel;

  const webviewRef = useRef<WebviewElement>(null);

  const persistedUrl = (viewState.url as string) ?? "";

  // Use a ref for the initial src so React never changes the src attribute after
  // mount. All subsequent navigation goes through webview.loadURL() imperatively,
  // preventing React reconciliation from triggering unintended re-navigations.
  const initialSrcRef = useRef(persistedUrl || "about:blank");

  // inputUrl: what the address bar shows
  const [inputUrl, setInputUrl] = useState(persistedUrl);
  // hasNavigated: truthy once we've visited a real URL — controls BlankPage overlay
  const [hasNavigated, setHasNavigated] = useState(!!persistedUrl);
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isInspecting, setIsInspecting] = useState(false);

  const navigate = useCallback(
    (url: string) => {
      const normalized = url.startsWith("http") ? url : `https://${url}`;
      setInputUrl(normalized);
      // Navigate imperatively — do NOT update React's src prop to avoid
      // triggering a second navigation via attribute reconciliation.
      webviewRef.current?.loadURL(normalized);
      contentPanel.updateViewState(viewId, { url: normalized });
    },
    [viewId, contentPanel],
  );

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const automation = BrowserAutomationService.getInstance();
    automation.registerView(viewId, webview);
    return () => {
      automation.unregisterView(viewId);
    };
  }, [viewId]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const INJECT_NEW_WINDOW_HANDLER = `
      (function() {
        // Redirect target=_blank links to navigate in-place
        document.addEventListener('click', function(e) {
          var a = e.target && e.target.closest && e.target.closest('a[target="_blank"]');
          if (a && a.href) { e.preventDefault(); window.location.href = a.href; }
        }, true);
        // Redirect window.open() to navigate in-place
        window.open = function(url) {
          if (url && url !== 'about:blank') { window.location.href = String(url); }
          return null;
        };
      })();
    `;
    const onDomReady = () => {
      webview.executeJavaScript(INJECT_SCRIPT, true);
      webview.executeJavaScript(INJECT_NEW_WINDOW_HANDLER, true);
      BrowserAutomationService.getInstance().notifyDomReady(viewId);
    };
    const onStartLoading = () => {
      setIsLoading(true);
    };
    const onStopLoading = () => {
      setIsLoading(false);
      setCanGoBack(webview.canGoBack());
      setCanGoForward(webview.canGoForward());
    };
    const onNavigate = (e: Event & { url: string }) => {
      if (e.url !== "about:blank") {
        setHasNavigated(true);
        setInputUrl(e.url);
        contentPanel.updateViewState(viewId, { url: e.url });
      }
      setCanGoBack(webview.canGoBack());
      setCanGoForward(webview.canGoForward());
    };
    const onNavigateInPage = (e: Event & { url: string }) => {
      if (e.url !== "about:blank") {
        setHasNavigated(true);
        setInputUrl(e.url);
        contentPanel.updateViewState(viewId, { url: e.url });
      }
    };
    const GRAB_PREFIX = "BROWSER_PLUGIN:";
    const onConsoleMessage = (e: Event & { level: number; message: string }) => {
      BrowserAutomationService.getInstance().addConsoleLog(viewId, {
        level: e.level,
        message: e.message,
        ts: Date.now(),
      });
      if (!e.message.startsWith(GRAB_PREFIX)) return;
      try {
        const { active } = JSON.parse(e.message.slice(GRAB_PREFIX.length));
        if (active !== undefined) setIsInspecting(active);
      } catch {
        // ignore parse errors
      }
    };

    webview.addEventListener("dom-ready", onDomReady);
    webview.addEventListener("did-start-loading", onStartLoading);
    webview.addEventListener("did-stop-loading", onStopLoading);
    webview.addEventListener("did-navigate", onNavigate as EventListener);
    webview.addEventListener("did-navigate-in-page", onNavigateInPage as EventListener);
    webview.addEventListener("console-message", onConsoleMessage as EventListener);

    return () => {
      webview.removeEventListener("dom-ready", onDomReady);
      webview.removeEventListener("did-start-loading", onStartLoading);
      webview.removeEventListener("did-stop-loading", onStopLoading);
      webview.removeEventListener("did-navigate", onNavigate as EventListener);
      webview.removeEventListener("did-navigate-in-page", onNavigateInPage as EventListener);
      webview.removeEventListener("console-message", onConsoleMessage as EventListener);
    };
  }, [viewId, contentPanel]);

  const goBack = useCallback(() => webviewRef.current?.goBack(), []);
  const goForward = useCallback(() => webviewRef.current?.goForward(), []);
  const reload = useCallback(() => webviewRef.current?.reload(), []);
  const openDevTools = useCallback(() => webviewRef.current?.openDevTools(), []);
  const toggleInspector = useCallback(() => {
    webviewRef.current?.executeJavaScript(
      "window.__REACT_GRAB__ && window.__REACT_GRAB__.toggle()",
      true,
    );
  }, []);

  return (
    <div className="flex h-full flex-col">
      <NavBar
        url={inputUrl}
        isLoading={isLoading}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        isInspecting={isInspecting}
        onNavigate={navigate}
        onGoBack={goBack}
        onGoForward={goForward}
        onReload={reload}
        onOpenDevTools={openDevTools}
        onToggleInspector={toggleInspector}
      />
      <div className="relative flex-1 overflow-hidden">
        <webview
          ref={webviewRef}
          src={initialSrcRef.current}
          style={{ width: "100%", height: "100%" }}
        />
        {!hasNavigated && (
          <div className="absolute inset-0">
            <BlankPage />
          </div>
        )}
      </div>
    </div>
  );
}
