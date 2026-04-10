import type { ContentPanel } from "../content-panel";

import {
  BrowserState,
  formatBrowserState,
  INJECT_ELEMENT_INDEXER,
} from "../../plugins/browser/inject-element-indexer";

export interface ConsoleLogEntry {
  level: number;
  message: string;
  ts: number;
}

interface RegisteredView {
  ref: WebviewElement;
  consoleLogs: ConsoleLogEntry[];
  /** Resolves once dom-ready has fired for this webview (at least once). */
  domReadyPromise: Promise<void>;
  resolveDomReady: () => void;
}

const LOG_CAP = 1000;
const WAIT_FOR_LOAD_TIMEOUT = 15_000;
const WAIT_FOR_VIEW_TIMEOUT = 8_000;

export class BrowserAutomationService {
  private static _instance: BrowserAutomationService | null = null;

  static getInstance(): BrowserAutomationService {
    if (!this._instance) this._instance = new BrowserAutomationService();
    return this._instance;
  }

  private views = new Map<string, RegisteredView>();
  private activeViewId: string | null = null;
  private contentPanel: ContentPanel | null = null;
  private pendingViewRegistrations: Array<(ref: WebviewElement) => void> = [];
  private ipcCleanup: (() => void) | null = null;

  init(): void {
    if (!window.browserIpc) return;
    this.ipcCleanup = window.browserIpc.onBrowserCommand((cmd) => this.handleCommand(cmd));
  }

  setContentPanel(panel: ContentPanel): void {
    this.contentPanel = panel;
  }

  registerView(viewId: string, ref: WebviewElement): void {
    let resolveDomReady!: () => void;
    const domReadyPromise = new Promise<void>((res) => {
      resolveDomReady = res;
    });
    this.views.set(viewId, { ref, consoleLogs: [], domReadyPromise, resolveDomReady });
    this.activeViewId = viewId;
    // Resolve any waiters
    const waiters = this.pendingViewRegistrations.splice(0);
    for (const resolve of waiters) resolve(ref);
  }

  /** Called by browser-view.tsx whenever dom-ready fires — marks the view as JS-executable. */
  notifyDomReady(viewId: string): void {
    this.views.get(viewId)?.resolveDomReady();
  }

  unregisterView(viewId: string): void {
    this.views.delete(viewId);
    if (this.activeViewId === viewId) {
      // Pick the last registered view as the new active
      const ids = Array.from(this.views.keys());
      this.activeViewId = ids.length > 0 ? ids[ids.length - 1] : null;
    }
  }

  addConsoleLog(viewId: string, entry: ConsoleLogEntry): void {
    const view = this.views.get(viewId);
    if (!view) return;
    view.consoleLogs.push(entry);
    if (view.consoleLogs.length > LOG_CAP) view.consoleLogs.shift();
  }

  dispose(): void {
    this.ipcCleanup?.();
    this.ipcCleanup = null;
  }

  // ─── Command Dispatcher ─────────────────────────────────────────────────

  private async handleCommand(cmd: {
    requestId: string;
    method: string;
    args: unknown;
  }): Promise<void> {
    try {
      const result = await this.dispatch(cmd.method, cmd.args as Record<string, unknown>);
      window.browserIpc.sendBrowserResult(cmd.requestId, result);
    } catch (err) {
      window.browserIpc.sendBrowserResult(
        cmd.requestId,
        undefined,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async dispatch(method: string, args: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "getState":
        return this.getState(args.screenshot as boolean | undefined);
      case "navigate":
        return this.navigate(args.url as string);
      case "click":
        return this.click(
          args.index as number | undefined,
          args.x as number | undefined,
          args.y as number | undefined,
        );
      case "input":
        return this.input(
          args.index as number,
          args.text as string,
          args.clear as boolean | undefined,
        );
      case "scroll":
        return this.scroll(
          args.direction as "up" | "down" | "left" | "right",
          args.amount as number | undefined,
          args.target as number | undefined,
        );
      case "screenshot":
        return this.screenshot(args.fullPage as boolean | undefined);
      case "goBack":
        return this.goBack();
      case "wait":
        return this.wait(
          args.seconds as number | undefined,
          args.selector as string | undefined,
          args.text as string | undefined,
          args.timeout as number | undefined,
        );
      case "evaluate":
        return this.evaluate(args.code as string);
      case "sendKeys":
        return this.sendKeys(args.keys as string);
      case "getConsoleLogs":
        return this.getConsoleLogs(args.clear as boolean | undefined);
      case "hover":
        return this.hover(args.index as number);
      case "dblclick":
        return this.dblclick(args.index as number);
      case "select":
        return this.selectOption(
          args.index as number,
          args.value as string | undefined,
          args.label as string | undefined,
        );
      case "getText":
        return this.getText(args.index as number | undefined, args.selector as string | undefined);
      case "getHtml":
        return this.getHtml(args.selector as string | undefined, args.inner as boolean | undefined);
      case "getAttribute":
        return this.getAttribute(args.index as number, args.name as string);
      case "tabList":
        return this.tabList();
      case "tabNew":
        return this.tabNew(args.url as string | undefined);
      case "tabSwitch":
        return this.tabSwitch(args.index as number);
      case "tabClose":
        return this.tabClose(args.index as number | undefined);
      default:
        throw new Error(`Unknown browser method: ${method}`);
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  private async ensureWebview(): Promise<WebviewElement> {
    // If we have an active view, wait for its dom-ready (required by Electron before
    // executeJavaScript or loadURL can be called) then return the ref.
    if (this.activeViewId) {
      const view = this.views.get(this.activeViewId);
      if (view) {
        await view.domReadyPromise;
        return view.ref;
      }
    }

    // No active view — open a browser tab and wait for registration.
    if (this.contentPanel) {
      this.contentPanel.openView("browser", {});
    } else {
      throw new Error("No browser view is open. Open a browser tab first.");
    }

    const ref = await new Promise<WebviewElement>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingViewRegistrations = this.pendingViewRegistrations.filter((r) => r !== wrapped);
        reject(new Error("Timeout waiting for browser view to open"));
      }, WAIT_FOR_VIEW_TIMEOUT);

      const wrapped = (r: WebviewElement) => {
        clearTimeout(timer);
        resolve(r);
      };
      this.pendingViewRegistrations.push(wrapped);
    });

    // Also wait for the new view's dom-ready before returning.
    const view = this.activeViewId ? this.views.get(this.activeViewId) : undefined;
    if (view) await view.domReadyPromise;
    return ref;
  }

  private async waitForNavigation(webview: WebviewElement, url: string): Promise<void> {
    // dom-ready is already guaranteed by ensureWebview() before this is called.
    // Register { once: true } for the NEXT dom-ready (the target page), then loadURL.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, WAIT_FOR_LOAD_TIMEOUT);
      webview.addEventListener(
        "dom-ready",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      webview.loadURL(url);
    });
  }

  private waitForLoad(webview: WebviewElement): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        webview.removeEventListener("did-stop-loading", onStop as EventListener);
        resolve();
      }, WAIT_FOR_LOAD_TIMEOUT);

      const onStop = () => {
        clearTimeout(timer);
        resolve();
      };
      webview.addEventListener("did-stop-loading", onStop as EventListener, { once: true });
    });
  }

  // ─── Tool Implementations ───────────────────────────────────────────────

  private async getState(screenshot?: boolean): Promise<{ text: string; image?: string }> {
    const webview = await this.ensureWebview();
    const json = (await webview.executeJavaScript(INJECT_ELEMENT_INDEXER, true)) as string;
    const state = JSON.parse(json) as BrowserState;
    const text = formatBrowserState(state);

    if (screenshot) {
      const image = await this.captureScreenshot(webview);
      return { text, image };
    }
    return { text };
  }

  private async navigate(url: string): Promise<string> {
    const webview = await this.ensureWebview();
    // Normalize URL
    const normalized = url.startsWith("http") ? url : `https://${url}`;
    await this.waitForNavigation(webview, normalized);
    const json = (await webview.executeJavaScript(INJECT_ELEMENT_INDEXER, true)) as string;
    const state = JSON.parse(json) as BrowserState;
    return formatBrowserState(state);
  }

  private async click(index?: number, x?: number, y?: number): Promise<string> {
    const webview = await this.ensureWebview();
    if (x != null && y != null) {
      // Coordinate-based click
      await webview.executeJavaScript(
        `(function() {
          var el = document.elementFromPoint(${x}, ${y});
          if (el) el.click();
        })()`,
        true,
      );
      await this.waitForLoad(webview);
      const json = (await webview.executeJavaScript(INJECT_ELEMENT_INDEXER, true)) as string;
      const state = JSON.parse(json) as BrowserState;
      return formatBrowserState(state);
    }
    if (index == null) throw new Error("Either index or x/y coordinates are required");
    const result = await webview.executeJavaScript(
      `(function() {
        var el = document.querySelector('[data-nv-index="${index}"]');
        if (!el) return { ok: false, error: 'Element not found: index ' + ${index} };
        el.click();
        return { ok: true };
      })()`,
      true,
    );
    const r = result as { ok: boolean; error?: string };
    if (!r.ok) throw new Error(r.error);
    await this.waitForLoad(webview);
    const json = (await webview.executeJavaScript(INJECT_ELEMENT_INDEXER, true)) as string;
    const state = JSON.parse(json) as BrowserState;
    return formatBrowserState(state);
  }

  private async input(index: number, text: string, clear?: boolean): Promise<string> {
    const webview = await this.ensureWebview();
    const result = await webview.executeJavaScript(
      `(function() {
        var el = document.querySelector('[data-nv-index="${index}"]');
        if (!el) return { ok: false, error: 'Element not found: index ' + ${index} };
        el.focus();
        if (${clear ?? false}) {
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        var nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value') ||
          Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
        if (nativeInputValueSetter && nativeInputValueSetter.set) {
          nativeInputValueSetter.set.call(el, (el.value || '') + ${JSON.stringify(text)});
        } else {
          el.value = (el.value || '') + ${JSON.stringify(text)};
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      })()`,
      true,
    );
    const r = result as { ok: boolean; error?: string };
    if (!r.ok) throw new Error(r.error);
    return `Typed "${text}" into element [${index}]`;
  }

  private async scroll(
    direction: "up" | "down" | "left" | "right",
    amount?: number,
    target?: number,
  ): Promise<string> {
    const webview = await this.ensureWebview();
    const pages = amount ?? 1;
    const px = pages * 600;
    const isVertical = direction === "up" || direction === "down";
    const sign = direction === "down" || direction === "right" ? 1 : -1;
    const top = isVertical ? sign * px : 0;
    const left = isVertical ? 0 : sign * px;

    if (target != null) {
      await webview.executeJavaScript(
        `(function() {
          var el = document.querySelector('[data-nv-index="${target}"]');
          if (el) el.scrollBy({ top: ${top}, left: ${left}, behavior: 'smooth' });
        })()`,
        true,
      );
      return `Scrolled element [${target}] ${direction} by ${pages} page(s)`;
    }
    await webview.executeJavaScript(
      `window.scrollBy({ top: ${top}, left: ${left}, behavior: 'smooth' })`,
      true,
    );
    return `Scrolled ${direction} by ${pages} page(s)`;
  }

  private async screenshot(fullPage?: boolean): Promise<string> {
    const webview = await this.ensureWebview();
    if (fullPage) {
      return this.captureFullPageScreenshot(webview);
    }
    return this.captureScreenshot(webview);
  }

  private async captureScreenshot(webview: WebviewElement): Promise<string> {
    const image = await webview.capturePage();
    return image.toDataURL("image/png");
  }

  private async captureFullPageScreenshot(webview: WebviewElement): Promise<string> {
    // Scroll-and-stitch approach: capture visible viewport, scroll, repeat
    const dims = (await webview.executeJavaScript(
      `JSON.stringify({
        scrollHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        scrollTop: window.scrollY,
      })`,
      true,
    )) as string;
    const { scrollHeight, viewportHeight, scrollTop } = JSON.parse(dims);

    // If page fits in one viewport, just capture normally
    if (scrollHeight <= viewportHeight) {
      return this.captureScreenshot(webview);
    }

    // Create canvas via JS, scroll through page taking screenshots
    const segments: string[] = [];
    const steps = Math.ceil(scrollHeight / viewportHeight);
    for (let i = 0; i < steps; i++) {
      const y = i * viewportHeight;
      await webview.executeJavaScript(`window.scrollTo(0, ${y})`, true);
      // Brief pause for render
      await new Promise<void>((r) => setTimeout(r, 100));
      const image = await webview.capturePage();
      segments.push(image.toDataURL("image/png"));
    }
    // Restore scroll position
    await webview.executeJavaScript(`window.scrollTo(0, ${scrollTop})`, true);

    // Return last segment if stitching is not available (canvas API not in main)
    // For now, return all segments as a composite — the last full capture is most useful
    // TODO: implement proper stitching if needed
    return segments[segments.length - 1];
  }

  private async goBack(): Promise<string> {
    const webview = await this.ensureWebview();
    if (!webview.canGoBack()) return "Cannot go back — no history";
    webview.goBack();
    await this.waitForLoad(webview);
    const json = (await webview.executeJavaScript(INJECT_ELEMENT_INDEXER, true)) as string;
    const state = JSON.parse(json) as BrowserState;
    return formatBrowserState(state);
  }

  private async wait(
    seconds?: number,
    selector?: string,
    text?: string,
    timeout?: number,
  ): Promise<string> {
    const webview = await this.ensureWebview();
    const timeoutMs = timeout ?? 5000;

    if (selector) {
      const found = await this.pollCondition(
        webview,
        `!!document.querySelector(${JSON.stringify(selector)})`,
        timeoutMs,
      );
      return found
        ? `Element matching "${selector}" appeared`
        : `Timeout: element matching "${selector}" not found after ${timeoutMs}ms`;
    }

    if (text) {
      const found = await this.pollCondition(
        webview,
        `document.body.innerText.includes(${JSON.stringify(text)})`,
        timeoutMs,
      );
      return found
        ? `Text "${text}" appeared`
        : `Timeout: text "${text}" not found after ${timeoutMs}ms`;
    }

    const ms = Math.min((seconds ?? 3) * 1000, 10_000);
    await new Promise<void>((res) => setTimeout(res, ms));
    return `Waited ${ms / 1000}s`;
  }

  private async pollCondition(
    webview: WebviewElement,
    condition: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const start = Date.now();
    const interval = 200;
    while (Date.now() - start < timeoutMs) {
      const result = await webview.executeJavaScript(`(${condition})`, true);
      if (result) return true;
      await new Promise<void>((r) => setTimeout(r, interval));
    }
    return false;
  }

  private async evaluate(code: string): Promise<unknown> {
    const webview = await this.ensureWebview();
    return webview.executeJavaScript(code, true);
  }

  private async sendKeys(keys: string): Promise<string> {
    const webview = await this.ensureWebview();
    // Map common key names to KeyboardEvent key values
    const keyMap: Record<string, string> = {
      Enter: "Enter",
      Return: "Enter",
      Tab: "Tab",
      Escape: "Escape",
      Esc: "Escape",
      Space: " ",
      Backspace: "Backspace",
      Delete: "Delete",
      ArrowUp: "ArrowUp",
      ArrowDown: "ArrowDown",
      ArrowLeft: "ArrowLeft",
      ArrowRight: "ArrowRight",
    };

    // Parse modifier combos like "Control+a", "Shift+Enter", "Mod+c"
    const parts = keys.split("+");
    const modifiers = new Set<string>();
    let mainKey = parts[parts.length - 1];
    for (let i = 0; i < parts.length - 1; i++) {
      const mod = parts[i].toLowerCase();
      if (mod === "mod") {
        // Platform-adaptive: Meta on macOS, Control elsewhere
        modifiers.add("meta"); // Electron renderer runs in Chromium on macOS
      } else {
        modifiers.add(mod);
      }
    }
    mainKey = keyMap[mainKey] ?? mainKey;

    const ctrlKey = modifiers.has("control") || modifiers.has("ctrl");
    const shiftKey = modifiers.has("shift");
    const altKey = modifiers.has("alt");
    const metaKey = modifiers.has("meta") || modifiers.has("command") || modifiers.has("cmd");

    await webview.executeJavaScript(
      `(function() {
        var el = document.activeElement || document.body;
        var opts = {
          key: ${JSON.stringify(mainKey)},
          bubbles: true,
          ctrlKey: ${ctrlKey},
          shiftKey: ${shiftKey},
          altKey: ${altKey},
          metaKey: ${metaKey},
        };
        el.dispatchEvent(new KeyboardEvent('keydown', opts));
        el.dispatchEvent(new KeyboardEvent('keypress', opts));
        el.dispatchEvent(new KeyboardEvent('keyup', opts));
        if (${JSON.stringify(mainKey)} === 'Enter') {
          var form = el.closest('form');
          if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }
      })()`,
      true,
    );
    return `Sent key: ${keys}`;
  }

  private async getConsoleLogs(clear?: boolean): Promise<ConsoleLogEntry[]> {
    if (!this.activeViewId) return [];
    const view = this.views.get(this.activeViewId);
    if (!view) return [];
    const logs = [...view.consoleLogs];
    if (clear) view.consoleLogs.length = 0;
    return logs;
  }

  // ─── Phase 2: Interaction Tools ───────────────────────────────────────────

  private async hover(index: number): Promise<string> {
    const webview = await this.ensureWebview();
    const result = await webview.executeJavaScript(
      `(function() {
        var el = document.querySelector('[data-nv-index="${index}"]');
        if (!el) return { ok: false, error: 'Element not found: index ' + ${index} };
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        return { ok: true };
      })()`,
      true,
    );
    const r = result as { ok: boolean; error?: string };
    if (!r.ok) throw new Error(r.error);
    return `Hovered over element [${index}]`;
  }

  private async dblclick(index: number): Promise<string> {
    const webview = await this.ensureWebview();
    const result = await webview.executeJavaScript(
      `(function() {
        var el = document.querySelector('[data-nv-index="${index}"]');
        if (!el) return { ok: false, error: 'Element not found: index ' + ${index} };
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return { ok: true };
      })()`,
      true,
    );
    const r = result as { ok: boolean; error?: string };
    if (!r.ok) throw new Error(r.error);
    await this.waitForLoad(webview);
    const json = (await webview.executeJavaScript(INJECT_ELEMENT_INDEXER, true)) as string;
    const state = JSON.parse(json) as BrowserState;
    return formatBrowserState(state);
  }

  private async selectOption(index: number, value?: string, label?: string): Promise<string> {
    const webview = await this.ensureWebview();
    const result = await webview.executeJavaScript(
      `(function() {
        var el = document.querySelector('[data-nv-index="${index}"]');
        if (!el) return { ok: false, error: 'Element not found: index ' + ${index} };
        if (el.tagName !== 'SELECT') return { ok: false, error: 'Element [${index}] is not a <select>' };
        var opts = el.options;
        var found = false;
        for (var i = 0; i < opts.length; i++) {
          var match = ${value != null} ? opts[i].value === ${JSON.stringify(value ?? "")}
                      : opts[i].textContent.trim() === ${JSON.stringify(label ?? "")};
          if (match) {
            el.selectedIndex = i;
            found = true;
            break;
          }
        }
        if (!found) return { ok: false, error: 'Option not found' };
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, selected: el.options[el.selectedIndex].textContent.trim() };
      })()`,
      true,
    );
    const r = result as { ok: boolean; error?: string; selected?: string };
    if (!r.ok) throw new Error(r.error);
    return `Selected "${r.selected}" in element [${index}]`;
  }

  // ─── Phase 3: Data Extraction Tools ───────────────────────────────────────

  private async getText(index?: number, selector?: string): Promise<string> {
    const webview = await this.ensureWebview();
    if (index != null) {
      const text = (await webview.executeJavaScript(
        `(function() {
          var el = document.querySelector('[data-nv-index="${index}"]');
          return el ? el.textContent.trim() : null;
        })()`,
        true,
      )) as string | null;
      return text ?? `Element [${index}] not found`;
    }
    if (selector) {
      const text = (await webview.executeJavaScript(
        `(function() {
          var el = document.querySelector(${JSON.stringify(selector)});
          return el ? el.textContent.trim() : null;
        })()`,
        true,
      )) as string | null;
      return text ?? `No element matching "${selector}"`;
    }
    throw new Error("Either index or selector is required");
  }

  private async getHtml(selector?: string, inner?: boolean): Promise<string> {
    const webview = await this.ensureWebview();
    const prop = inner ? "innerHTML" : "outerHTML";
    if (selector) {
      const html = (await webview.executeJavaScript(
        `(function() {
          var el = document.querySelector(${JSON.stringify(selector)});
          return el ? el.${prop} : null;
        })()`,
        true,
      )) as string | null;
      return html ?? `No element matching "${selector}"`;
    }
    return (await webview.executeJavaScript(`document.documentElement.${prop}`, true)) as string;
  }

  private async getAttribute(index: number, name: string): Promise<string> {
    const webview = await this.ensureWebview();
    const val = (await webview.executeJavaScript(
      `(function() {
        var el = document.querySelector('[data-nv-index="${index}"]');
        return el ? el.getAttribute(${JSON.stringify(name)}) : null;
      })()`,
      true,
    )) as string | null;
    return val ?? `Element [${index}] not found or attribute "${name}" not set`;
  }

  // ─── Phase 4: Tab Management ──────────────────────────────────────────────

  private getViewIds(): string[] {
    return Array.from(this.views.keys());
  }

  private async tabList(): Promise<string> {
    const viewIds = this.getViewIds();
    if (viewIds.length === 0) return "No browser tabs open";

    const lines: string[] = [];
    for (let i = 0; i < viewIds.length; i++) {
      const vid = viewIds[i];
      const view = this.views.get(vid)!;
      const isActive = vid === this.activeViewId;
      let url = "about:blank";
      let title = "";
      try {
        const info = (await view.ref.executeJavaScript(
          `JSON.stringify({ url: window.location.href, title: document.title })`,
          true,
        )) as string;
        const parsed = JSON.parse(info);
        url = parsed.url;
        title = parsed.title;
      } catch {
        // webview may not be ready
      }
      const marker = isActive ? " (active)" : "";
      lines.push(`[${i}] ${title || "(untitled)"} — ${url}${marker}`);
    }
    return lines.join("\n");
  }

  private async tabNew(url?: string): Promise<string> {
    if (!this.contentPanel) throw new Error("ContentPanel not available");
    const state = url ? { url: url.startsWith("http") ? url : `https://${url}` } : {};
    this.contentPanel.openView("browser", { state });
    // Wait for the new view to register
    await new Promise<WebviewElement>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingViewRegistrations = this.pendingViewRegistrations.filter((r) => r !== wrapped);
        reject(new Error("Timeout waiting for new tab to open"));
      }, WAIT_FOR_VIEW_TIMEOUT);
      const wrapped = (r: WebviewElement) => {
        clearTimeout(timer);
        resolve(r);
      };
      this.pendingViewRegistrations.push(wrapped);
    });
    // Wait for dom-ready
    const view = this.activeViewId ? this.views.get(this.activeViewId) : undefined;
    if (view) await view.domReadyPromise;
    if (url) {
      const normalized = url.startsWith("http") ? url : `https://${url}`;
      return `Opened new tab: ${normalized}`;
    }
    return "Opened new blank tab";
  }

  private async tabSwitch(index: number): Promise<string> {
    const viewIds = this.getViewIds();
    if (index < 0 || index >= viewIds.length) {
      throw new Error(`Invalid tab index ${index}. ${viewIds.length} tab(s) open.`);
    }
    const targetId = viewIds[index];
    this.activeViewId = targetId;
    if (this.contentPanel) {
      this.contentPanel.activateView(targetId);
    }
    return `Switched to tab [${index}]`;
  }

  private async tabClose(index?: number): Promise<string> {
    const viewIds = this.getViewIds();
    let targetId: string;
    if (index != null) {
      if (index < 0 || index >= viewIds.length) {
        throw new Error(`Invalid tab index ${index}. ${viewIds.length} tab(s) open.`);
      }
      targetId = viewIds[index];
    } else {
      if (!this.activeViewId) throw new Error("No active tab to close");
      targetId = this.activeViewId;
    }
    if (this.contentPanel) {
      this.contentPanel.closeView(targetId);
    }
    return `Closed tab [${index ?? "active"}]`;
  }
}
