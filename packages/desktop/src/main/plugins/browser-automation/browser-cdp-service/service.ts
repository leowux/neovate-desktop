import type { WebContents } from "electron";

import debug from "debug";
import { resolve } from "node:path";

import type { EnsureRefFn } from "./ax-helpers";

import {
  axNodeMatchesQuery,
  buildFindQuery,
  collectDescendantNodeIds,
  collectFullSnapshotLines,
  collectInteractiveSnapshotLines,
  findScopedNodes,
} from "./ax-helpers";
import {
  DEVICE_PRESETS,
  ERROR_CAP,
  LOCATOR_HELPERS_JS,
  LOG_CAP,
  NETWORK_IDLE_QUIET_MS,
  REQUEST_CAP,
  WAIT_FOR_LOAD_TIMEOUT,
  WAIT_FOR_VIEW_TIMEOUT,
} from "./constants";
import { modifierFlag, parseKey } from "./keyboard-helpers";
import { BrowserRefCache } from "./ref-cache";
import {
  type AXNode,
  type BrowserConsoleAction,
  type BrowserCookieOptions,
  type BrowserDialogOptions,
  type BrowserErrorEntry,
  type BrowserFindOptions,
  type BrowserFrameOptions,
  type BrowserGetOptions,
  type BrowserIsOptions,
  type BrowserNetworkOptions,
  type BrowserSetOptions,
  type BrowserStorageOptions,
  type BrowserTabOptions,
  type BrowserWaitOptions,
  type CDPBoxModel,
  type ConsoleLogEntry,
  type DebuggerEvent,
  type LoadState,
  type NetworkRequestEntry,
  type PageFrame,
  type PageFrameTree,
  type SnapshotOptions,
  type TabInfo,
  type ViewSession,
} from "./types";
import {
  formatBrowserRef,
  matchesBrowserPattern,
  normalizeBrowserRef,
  normalizeBrowserUrl,
} from "./utils";

const log = debug("neovate:browser-cdp");

export class BrowserCdpService {
  private views = new Map<string, ViewSession>();
  private refs = new BrowserRefCache();
  private activeViewId: string | null = null;
  private sendTabCommand: (method: string, args: unknown) => void;
  private pendingViewRegistrations: Array<(viewId: string) => void> = [];

  constructor(sendTabCommand: (method: string, args: unknown) => void) {
    this.sendTabCommand = sendTabCommand;
  }

  async attachDebugger(viewId: string, webContents: WebContents): Promise<void> {
    if (this.views.has(viewId)) {
      return;
    }

    const dbg = webContents.debugger;
    try {
      dbg.attach("1.3");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("already attached")) {
        throw error;
      }
    }

    const session: ViewSession = {
      webContents,
      consoleLogs: [],
      errorLogs: [],
      requestLogs: [],
      requestById: new Map(),
      inflightRequests: new Set(),
      networkRoutes: [],
      dialogState: null,
      activeFrameId: null,
      frameContexts: new Map(),
      mainWorldContexts: new Map(),
      heldKeys: new Set(),
      onDebuggerMessage: (_event, method, params) => {
        this.handleDebuggerMessage(viewId, method, params);
      },
    };

    dbg.on("message", session.onDebuggerMessage);

    // Await CDP domain enables so that events like Page.loadEventFired are
    // guaranteed to be dispatched before any navigation triggered by tools
    // (e.g. browser_open → loadURL).  Without this, Page.enable may still be
    // in-flight when loadURL fires, causing loadEventFired to be silently
    // dropped and waitForLoadEvent to time out.
    await Promise.all([
      dbg.sendCommand("Runtime.enable").catch((error) => log("Runtime.enable error: %s", error)),
      dbg.sendCommand("Page.enable").catch((error) => log("Page.enable error: %s", error)),
      dbg
        .sendCommand("Accessibility.enable")
        .catch((error) => log("Accessibility.enable error: %s", error)),
      dbg.sendCommand("DOM.enable").catch((error) => log("DOM.enable error: %s", error)),
      dbg.sendCommand("Network.enable").catch((error) => log("Network.enable error: %s", error)),
      dbg
        .sendCommand("Fetch.enable", { patterns: [{ urlPattern: "*" }] })
        .catch((error) => log("Fetch.enable error: %s", error)),
      dbg.sendCommand("Overlay.enable").catch((error) => log("Overlay.enable error: %s", error)),
    ]);

    webContents.setWindowOpenHandler(({ url }) => {
      webContents.loadURL(url).catch((error) => log("window open redirect failed: %s", error));
      return { action: "deny" };
    });

    this.views.set(viewId, session);
    this.activeViewId = viewId;
    this.refs.reset(viewId);
    this.resolvePendingViewRegistrations(viewId);
  }

  detachDebugger(viewId: string): void {
    const session = this.views.get(viewId);
    if (!session) return;
    try {
      session.webContents.debugger.removeListener("message", session.onDebuggerMessage);
      session.webContents.debugger.detach();
    } catch {
      // Ignore detach errors.
    }
    this.views.delete(viewId);
    this.refs.reset(viewId);
    if (this.activeViewId === viewId) {
      this.activeViewId = Array.from(this.views.keys()).at(-1) ?? null;
    }
  }

  setActiveView(viewId: string): void {
    if (this.views.has(viewId)) {
      this.activeViewId = viewId;
    }
  }

  async open(url: string, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? (await this.ensureOpenView());
    const session = this.getViewSession(targetViewId);
    const normalized = normalizeBrowserUrl(url);
    await this.waitForLoadEvent(targetViewId, () => {
      session.webContents.loadURL(normalized).catch(() => {});
    });
    this.refs.invalidate(targetViewId);
    return `Opened ${normalized}`;
  }

  async back(viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const session = this.getViewSession(targetViewId);
    if (!session.webContents.canGoBack()) {
      return "No back history";
    }
    await this.waitForLoadEvent(targetViewId, () => {
      session.webContents.goBack();
    });
    this.refs.invalidate(targetViewId);
    return "Navigated back";
  }

  async forward(viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const session = this.getViewSession(targetViewId);
    if (!session.webContents.canGoForward()) {
      return "No forward history";
    }
    await this.waitForLoadEvent(targetViewId, () => {
      session.webContents.goForward();
    });
    this.refs.invalidate(targetViewId);
    return "Navigated forward";
  }

  async reload(viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const session = this.getViewSession(targetViewId);
    await this.waitForLoadEvent(targetViewId, () => {
      session.webContents.reload();
    });
    this.refs.invalidate(targetViewId);
    return "Reloaded page";
  }

  async snapshot(options: SnapshotOptions = {}, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const nodes = await this.getA11yTree(targetViewId);
    this.refs.seedFromAXTree(targetViewId, nodes);

    const nodeMap = new Map<string, AXNode>();
    const childIds = new Set<string>();
    for (const node of nodes) {
      nodeMap.set(node.nodeId, node);
      for (const childId of node.childIds ?? []) {
        childIds.add(childId);
      }
    }

    const depth = options.depth;
    const scopeBackendId = await this.resolveSnapshotScopeBackendNodeId(options, targetViewId);
    const frameScopeBackendId =
      scopeBackendId ?? (await this.getImplicitFrameScopeBackendNodeId(targetViewId));

    const roots = frameScopeBackendId
      ? findScopedNodes(nodes, frameScopeBackendId)
      : nodes.filter((node) => !childIds.has(node.nodeId));

    if (roots.length === 0) {
      return "(empty accessibility tree)";
    }

    const ensureRef = this.refs.ensureRef.bind(this.refs) as EnsureRefFn;

    if (options.interactiveOnly) {
      const lines: string[] = [];
      for (const root of roots) {
        collectInteractiveSnapshotLines(
          lines,
          root,
          nodeMap,
          ensureRef,
          targetViewId,
          options.compact ?? false,
          depth,
          0,
        );
      }
      return lines.length > 0 ? lines.join("\n") : "(no interactive elements found)";
    }

    const lines: string[] = [];
    for (const root of roots) {
      collectFullSnapshotLines(
        lines,
        root,
        nodeMap,
        ensureRef,
        targetViewId,
        options.compact ?? false,
        depth,
        0,
        options.focused ?? false,
      );
    }
    return lines.join("\n");
  }

  async find(options: BrowserFindOptions, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const backendIds = await this.findBackendNodeIds(options, targetViewId);
    const refs = await this.refs.ensureRefsForBackendNodeIds(targetViewId, backendIds, () =>
      this.getA11yTree(targetViewId),
    );
    if (refs.length === 0) {
      return "No matching elements found";
    }
    const lines = [`Found ${refs.length} match(es):`];
    for (const ref of refs) {
      lines.push(await this.describeRef(ref, targetViewId));
    }
    return lines.join("\n");
  }

  async click(ref: string, newTab?: boolean, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const normalizedRef = normalizeBrowserRef(ref);
    if (newTab) {
      const href = await this.getAttribute(normalizedRef, "href", targetViewId);
      if (href && !href.startsWith("Attribute ")) {
        await this.tab({ action: "new", url: href });
        return `Opened ${formatBrowserRef(normalizedRef)} in a new tab`;
      }
    }

    const { x, y } = await this.resolveRefPosition(normalizedRef, targetViewId);
    await this.dispatchMouseClick(x, y, 1, targetViewId);
    await this.waitForPotentialNavigation(targetViewId);
    this.refs.invalidate(targetViewId);
    return `Clicked ${formatBrowserRef(normalizedRef)}`;
  }

  async dblclick(ref: string, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const normalizedRef = normalizeBrowserRef(ref);
    const { x, y } = await this.resolveRefPosition(normalizedRef, targetViewId);
    // A real dblclick requires two consecutive click sequences:
    // first click (clickCount=1), then second click (clickCount=2) which fires the dblclick event.
    await this.dispatchMouseClick(x, y, 1, targetViewId);
    await this.dispatchMouseClick(x, y, 2, targetViewId);
    await this.waitForPotentialNavigation(targetViewId);
    this.refs.invalidate(targetViewId);
    return `Double-clicked ${formatBrowserRef(normalizedRef)}`;
  }

  async focus(ref: string, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const normalizedRef = normalizeBrowserRef(ref);
    await this.callOnRefNode(
      normalizedRef,
      "function() { this.focus(); return true; }",
      targetViewId,
    );
    return `Focused ${formatBrowserRef(normalizedRef)}`;
  }

  async fill(ref: string, text: string, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const normalizedRef = normalizeBrowserRef(ref);
    await this.editTextTarget(normalizedRef, text, "replace", targetViewId);
    // Filling an input does not alter DOM structure — backendNodeIds remain stable.
    // Page.frameNavigated auto-invalidates refs if the action triggers navigation.
    return `Filled ${formatBrowserRef(normalizedRef)}`;
  }

  async type(ref: string, text: string, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const normalizedRef = normalizeBrowserRef(ref);
    // Insert text inside the page context so typing does not depend on native
    // host-window focus and cannot leak into the chat input.
    await this.editTextTarget(normalizedRef, text, "insert", targetViewId);
    // Typing into an input does not alter DOM structure — refs remain valid.
    // Page.frameNavigated auto-invalidates refs if the action triggers navigation.
    return `Typed into ${formatBrowserRef(normalizedRef)}`;
  }

  async press(keys: string, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    this.grantWebviewFocus(targetViewId);
    await this.sendKeySequence(keys, targetViewId);
    this.refs.invalidate(targetViewId);
    return `Pressed ${keys}`;
  }

  async keyDown(key: string, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const session = this.getViewSession(targetViewId);
    const parsed = parseKey(key);
    this.grantWebviewFocus(targetViewId);
    await this.sendKeyEvent("keyDown", parsed, targetViewId);
    session.heldKeys.add(parsed.key.toLowerCase());
    return `Held ${key}`;
  }

  async keyUp(key: string, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const session = this.getViewSession(targetViewId);
    const parsed = parseKey(key);
    this.grantWebviewFocus(targetViewId);
    await this.sendKeyEvent("keyUp", parsed, targetViewId);
    session.heldKeys.delete(parsed.key.toLowerCase());
    return `Released ${key}`;
  }

  async hover(ref: string, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const normalizedRef = normalizeBrowserRef(ref);
    const { x, y } = await this.resolveRefPosition(normalizedRef, targetViewId);
    await this.sendCommand(
      "Input.dispatchMouseEvent",
      {
        type: "mouseMoved",
        x,
        y,
      },
      targetViewId,
    );
    return `Hovered ${formatBrowserRef(normalizedRef)}`;
  }

  async check(ref: string, viewId?: string): Promise<string> {
    return this.setCheckedState(ref, true, viewId);
  }

  async uncheck(ref: string, viewId?: string): Promise<string> {
    return this.setCheckedState(ref, false, viewId);
  }

  async select(ref: string, values: string[], viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const normalizedRef = normalizeBrowserRef(ref);
    const backendNodeId = this.refs.getBackendNodeIdForRef(normalizedRef, targetViewId);
    const objectId = await this.resolveObjectIdForBackendNode(backendNodeId, targetViewId);
    const { result } = await this.sendCommand<{
      result: { value?: { ok: boolean; selected?: string[]; error?: string } };
    }>(
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: `function(values) {
          if (!(this instanceof HTMLSelectElement)) {
            return { ok: false, error: "Element is not a select" };
          }
          const want = new Set(values);
          let matched = 0;
          for (const option of Array.from(this.options)) {
            const shouldSelect = want.has(option.value) || want.has(option.textContent.trim());
            option.selected = shouldSelect;
            if (shouldSelect) matched++;
          }
          if (matched === 0) {
            return { ok: false, error: "No matching options" };
          }
          this.dispatchEvent(new Event("input", { bubbles: true }));
          this.dispatchEvent(new Event("change", { bubbles: true }));
          return {
            ok: true,
            selected: Array.from(this.selectedOptions).map((option) => option.textContent.trim()),
          };
        }`,
        arguments: [{ value: values }],
        returnByValue: true,
        awaitPromise: true,
      },
      targetViewId,
    );
    if (!result.value?.ok) {
      throw new Error(result.value?.error ?? "Select failed");
    }
    this.refs.invalidate(targetViewId);
    return `Selected ${result.value.selected?.join(", ") ?? ""}`;
  }

  async scroll(
    direction: "up" | "down" | "left" | "right" = "down",
    amount: number = 300,
    targetRef?: string,
    viewId?: string,
  ): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const deltaY = direction === "down" ? amount : direction === "up" ? -amount : 0;
    const deltaX = direction === "right" ? amount : direction === "left" ? -amount : 0;
    const point = targetRef
      ? await this.resolveRefPosition(normalizeBrowserRef(targetRef), targetViewId)
      : await this.getViewportCenter(targetViewId);
    await this.sendCommand(
      "Input.dispatchMouseEvent",
      {
        type: "mouseWheel",
        x: point.x,
        y: point.y,
        deltaX,
        deltaY,
      },
      targetViewId,
    );
    return `Scrolled ${direction} by ${amount}px`;
  }

  async scrollIntoView(ref: string, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const normalizedRef = normalizeBrowserRef(ref);
    const backendNodeId = this.refs.getBackendNodeIdForRef(normalizedRef, targetViewId);
    await this.sendCommand("DOM.scrollIntoViewIfNeeded", { backendNodeId }, targetViewId).catch(
      async () => {
        await this.callOnRefNode(
          normalizedRef,
          "function() { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); return true; }",
          targetViewId,
        );
      },
    );
    return `Scrolled ${formatBrowserRef(normalizedRef)} into view`;
  }

  async drag(fromRef: string, toRef: string, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const from = await this.resolveRefPosition(normalizeBrowserRef(fromRef), targetViewId);
    const to = await this.resolveRefPosition(normalizeBrowserRef(toRef), targetViewId);
    await this.sendCommand(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 },
      targetViewId,
    );
    for (let step = 1; step <= 5; step++) {
      await this.sendCommand(
        "Input.dispatchMouseEvent",
        {
          type: "mouseMoved",
          x: Math.round(from.x + ((to.x - from.x) * step) / 5),
          y: Math.round(from.y + ((to.y - from.y) * step) / 5),
          button: "left",
          buttons: 1,
        },
        targetViewId,
      );
    }
    await this.sendCommand(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 },
      targetViewId,
    );
    this.refs.invalidate(targetViewId);
    return `Dragged ${formatBrowserRef(normalizeBrowserRef(fromRef))} to ${formatBrowserRef(normalizeBrowserRef(toRef))}`;
  }

  async upload(ref: string, files: string[], viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const backendNodeId = this.refs.getBackendNodeIdForRef(normalizeBrowserRef(ref), targetViewId);
    await this.sendCommand(
      "DOM.setFileInputFiles",
      { backendNodeId, files: files.map((file) => resolve(file)) },
      targetViewId,
    );
    this.refs.invalidate(targetViewId);
    return `Uploaded ${files.length} file(s)`;
  }

  async get(options: BrowserGetOptions, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    switch (options.kind) {
      case "title":
        return this.getViewSession(targetViewId).webContents.getTitle() || "";
      case "url":
        return this.getViewSession(targetViewId).webContents.getURL() || "about:blank";
      case "count": {
        if (!options.selector) throw new Error("selector is required for kind=count");
        const count = await this.evaluateInCurrentFrame<number>(
          `(function() { return document.querySelectorAll(${JSON.stringify(options.selector)}).length; })()`,
          targetViewId,
        );
        return String(count ?? 0);
      }
      case "attr": {
        if (!options.name) throw new Error("name is required for kind=attr");
        const ref = options.ref
          ? normalizeBrowserRef(options.ref)
          : await this.resolveSingleRefFromSelector(options.selector, targetViewId);
        return this.getAttribute(ref, options.name, targetViewId);
      }
      case "text": {
        const ref = options.ref
          ? normalizeBrowserRef(options.ref)
          : await this.resolveSingleRefFromSelector(options.selector, targetViewId);
        return this.callOnRefNode(
          ref,
          "function() { return (this.innerText || this.textContent || '').trim(); }",
          targetViewId,
        );
      }
      case "html": {
        const ref = options.ref
          ? normalizeBrowserRef(options.ref)
          : await this.resolveSingleRefFromSelector(options.selector, targetViewId);
        return this.callOnRefNode(ref, "function() { return this.innerHTML ?? ''; }", targetViewId);
      }
      case "value": {
        const ref = options.ref
          ? normalizeBrowserRef(options.ref)
          : await this.resolveSingleRefFromSelector(options.selector, targetViewId);
        return this.callOnRefNode(
          ref,
          "function() { return 'value' in this ? String(this.value ?? '') : ''; }",
          targetViewId,
        );
      }
      case "box": {
        if (!options.ref) throw new Error("ref is required for kind=box");
        const ref = normalizeBrowserRef(options.ref);
        const backendNodeId = this.refs.getBackendNodeIdForRef(ref, targetViewId);
        const { model } = await this.sendCommand<{ model: CDPBoxModel }>(
          "DOM.getBoxModel",
          { backendNodeId },
          targetViewId,
        );
        const box = this.boxModelToRect(model);
        return JSON.stringify(box, null, 2);
      }
      case "styles": {
        const ref = options.ref
          ? normalizeBrowserRef(options.ref)
          : await this.resolveSingleRefFromSelector(options.selector, targetViewId);
        const styles = await this.callOnRefNode<Record<string, string>>(
          ref,
          `function() {
            const style = getComputedStyle(this);
            return {
              display: style.display,
              visibility: style.visibility,
              opacity: style.opacity,
              color: style.color,
              backgroundColor: style.backgroundColor,
              fontFamily: style.fontFamily,
              fontSize: style.fontSize,
              fontWeight: style.fontWeight,
              width: style.width,
              height: style.height,
            };
          }`,
          targetViewId,
        );
        return JSON.stringify(styles, null, 2);
      }
    }
  }

  async is(options: BrowserIsOptions, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const ref = normalizeBrowserRef(options.ref);
    const result = await this.callOnRefNode<boolean>(
      ref,
      `function() {
        switch (${JSON.stringify(options.kind)}) {
          case "visible": {
            const style = getComputedStyle(this);
            const rect = this.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width > 0 && rect.height > 0;
          }
          case "enabled":
            return !this.disabled;
          case "checked":
            return !!this.checked;
          default:
            return false;
        }
      }`,
      targetViewId,
    );
    return String(Boolean(result));
  }

  async wait(options: BrowserWaitOptions, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const modeCount = [
      options.ref !== undefined,
      options.ms !== undefined,
      options.text !== undefined,
      options.urlPattern !== undefined,
      options.loadState !== undefined,
      options.js !== undefined,
    ].filter(Boolean).length;
    if (modeCount !== 1) {
      throw new Error(
        "browser_wait requires exactly one of ref, ms, text, urlPattern, loadState, or js",
      );
    }

    if (options.ms !== undefined) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, options.ms));
      return `Waited ${options.ms}ms`;
    }

    if (options.ref) {
      const ref = normalizeBrowserRef(options.ref);
      const found = await this.pollUntil(async () => {
        try {
          await this.resolveRefPosition(ref, targetViewId);
          return true;
        } catch {
          return false;
        }
      }, 5000);
      return found
        ? `Element ${formatBrowserRef(ref)} is available`
        : `Timed out waiting for ${formatBrowserRef(ref)}`;
    }

    if (options.text) {
      const found = await this.pollUntil(async () => {
        const value = await this.evaluateInCurrentFrame<string>(
          "document.body ? document.body.innerText : ''",
          targetViewId,
        );
        return value?.includes(options.text ?? "") ?? false;
      }, 5000);
      return found
        ? `Text appeared: ${options.text}`
        : `Timed out waiting for text: ${options.text}`;
    }

    if (options.urlPattern) {
      const found = await this.pollUntil(async () => {
        const url = this.getViewSession(targetViewId).webContents.getURL() || "";
        return matchesBrowserPattern(url, options.urlPattern ?? "");
      }, 5000);
      return found
        ? `URL matched ${options.urlPattern}`
        : `Timed out waiting for URL pattern ${options.urlPattern}`;
    }

    if (options.loadState) {
      const found = await this.waitForLoadState(options.loadState, targetViewId, 5000);
      return found
        ? `Load state reached: ${options.loadState}`
        : `Timed out waiting for ${options.loadState}`;
    }

    const found = await this.pollUntil(async () => {
      const value = await this.evaluateInCurrentFrame<unknown>(options.js ?? "false", targetViewId);
      return Boolean(value);
    }, 5000);
    return found ? "JavaScript condition satisfied" : "Timed out waiting for JavaScript condition";
  }

  async eval(code: string, viewId?: string): Promise<unknown> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    return this.evaluateInCurrentFrame<unknown>(code, targetViewId);
  }

  async screenshot(fullPage?: boolean, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    return this.captureScreenshot(Boolean(fullPage), targetViewId);
  }

  console(options: { action: BrowserConsoleAction }, viewId?: string): string {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const session = this.getViewSession(targetViewId);
    const logs = [...session.consoleLogs];
    if (options.action === "clear") {
      session.consoleLogs.length = 0;
      return "Cleared console logs";
    }
    if (logs.length === 0) return "(no console logs)";
    return logs
      .map(
        (entry) =>
          `[${new Date(entry.ts).toISOString().substring(11, 23)}] [${entry.level.toUpperCase()}] ${entry.message}`,
      )
      .join("\n");
  }

  errors(options: { action: BrowserConsoleAction }, viewId?: string): string {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const session = this.getViewSession(targetViewId);
    const errors = [...session.errorLogs];
    if (options.action === "clear") {
      session.errorLogs.length = 0;
      return "Cleared page errors";
    }
    if (errors.length === 0) return "(no page errors)";
    return errors
      .map((entry) => `[${new Date(entry.ts).toISOString().substring(11, 23)}] ${entry.message}`)
      .join("\n");
  }

  async highlight(ref?: string, clear?: boolean, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    if (clear || !ref) {
      await this.sendCommand("Overlay.hideHighlight", {}, targetViewId).catch(() => {});
      return "Cleared highlight";
    }
    const backendNodeId = this.refs.getBackendNodeIdForRef(normalizeBrowserRef(ref), targetViewId);
    await this.sendCommand(
      "Overlay.highlightNode",
      {
        backendNodeId,
        highlightConfig: {
          borderColor: { r: 250, g: 33, b: 110, a: 0.9 },
          contentColor: { r: 250, g: 33, b: 110, a: 0.2 },
          showInfo: true,
        },
      },
      targetViewId,
    );
    return `Highlighted ${formatBrowserRef(normalizeBrowserRef(ref))}`;
  }

  inspect(viewId?: string): string {
    const targetViewId = viewId ?? this.requireActiveViewId();
    this.getViewSession(targetViewId).webContents.openDevTools();
    return "Opened DevTools";
  }

  async tab(options: BrowserTabOptions): Promise<string> {
    switch (options.action) {
      case "list": {
        const tabs = this.tabList();
        if (tabs.length === 0) return "No browser tabs open";
        return tabs
          .map(
            (tab, index) =>
              `[${index}] ${tab.title || "(untitled)"} — ${tab.url}${tab.isActive ? " (active)" : ""}`,
          )
          .join("\n");
      }
      case "new":
        return this.tabNew(options.url);
      case "switch":
        if (options.index === undefined) throw new Error("index is required for tab switch");
        return this.tabSwitch(options.index);
      case "close":
        return this.tabClose(options.index);
    }
  }

  async frame(options: BrowserFrameOptions, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const session = this.getViewSession(targetViewId);
    if (options.target === "main") {
      session.activeFrameId = null;
      return "Switched to main frame";
    }

    let frameId: string | null = null;
    if (options.ref) {
      frameId = await this.getFrameIdFromRef(options.ref, targetViewId);
    } else if (options.selector) {
      const backendNodeId = await this.resolveSelectorToBackendNodeId(
        options.selector,
        targetViewId,
      );
      frameId = await this.getFrameIdFromBackendNode(backendNodeId, targetViewId);
    } else if (options.match) {
      const match = options.match.toLowerCase();
      const frameTree = await this.getFrameTree(targetViewId);
      for (const frame of this.flattenFrameTree(frameTree)) {
        if (
          (frame.name ?? "").toLowerCase().includes(match) ||
          frame.url.toLowerCase().includes(match)
        ) {
          frameId = frame.id;
          break;
        }
      }
    }

    if (!frameId) throw new Error("Frame not found");
    session.activeFrameId = frameId;
    return `Switched to frame ${frameId}`;
  }

  async dialog(options: BrowserDialogOptions, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const session = this.getViewSession(targetViewId);
    if (options.action === "status") {
      return session.dialogState
        ? JSON.stringify(session.dialogState, null, 2)
        : "(no dialog open)";
    }
    if (!session.dialogState) {
      return "No dialog is open";
    }
    await this.sendCommand(
      "Page.handleJavaScriptDialog",
      {
        accept: options.action === "accept",
        promptText: options.text,
      },
      targetViewId,
    );
    session.dialogState = null;
    return options.action === "accept" ? "Accepted dialog" : "Dismissed dialog";
  }

  async set(options: BrowserSetOptions, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    switch (options.kind) {
      case "viewport": {
        if (options.width === undefined || options.height === undefined) {
          throw new Error("width and height are required for viewport");
        }
        await this.sendCommand(
          "Emulation.setDeviceMetricsOverride",
          {
            width: options.width,
            height: options.height,
            deviceScaleFactor: options.scale ?? 1,
            mobile: false,
          },
          targetViewId,
        );
        return `Viewport set to ${options.width}x${options.height}`;
      }
      case "device": {
        if (!options.device) throw new Error("device is required for kind=device");
        const preset = DEVICE_PRESETS[options.device];
        if (!preset) {
          throw new Error(`Unsupported device preset: ${options.device}`);
        }
        await this.sendCommand(
          "Emulation.setDeviceMetricsOverride",
          {
            width: preset.width,
            height: preset.height,
            deviceScaleFactor: preset.scale,
            mobile: preset.mobile,
          },
          targetViewId,
        );
        await this.sendCommand(
          "Emulation.setUserAgentOverride",
          { userAgent: preset.userAgent },
          targetViewId,
        );
        return `Device emulation enabled: ${options.device}`;
      }
      case "geo": {
        if (options.latitude === undefined || options.longitude === undefined) {
          throw new Error("latitude and longitude are required for geo");
        }
        await this.sendCommand(
          "Emulation.setGeolocationOverride",
          {
            latitude: options.latitude,
            longitude: options.longitude,
            accuracy: 1,
          },
          targetViewId,
        );
        return `Geolocation set to ${options.latitude}, ${options.longitude}`;
      }
      case "offline": {
        const offline = Boolean(options.offline);
        await this.sendCommand(
          "Network.emulateNetworkConditions",
          {
            offline,
            latency: 0,
            downloadThroughput: -1,
            uploadThroughput: -1,
          },
          targetViewId,
        );
        return offline ? "Offline mode enabled" : "Offline mode disabled";
      }
      case "headers": {
        if (!options.headers) throw new Error("headers are required for kind=headers");
        await this.sendCommand(
          "Network.setExtraHTTPHeaders",
          { headers: options.headers },
          targetViewId,
        );
        return "Extra HTTP headers updated";
      }
      case "credentials": {
        if (options.username === undefined || options.password === undefined) {
          throw new Error("username and password are required for credentials");
        }
        const header = Buffer.from(`${options.username}:${options.password}`).toString("base64");
        await this.sendCommand(
          "Network.setExtraHTTPHeaders",
          { headers: { Authorization: `Basic ${header}` } },
          targetViewId,
        );
        return "Basic auth credentials updated";
      }
      case "media": {
        await this.sendCommand(
          "Emulation.setEmulatedMedia",
          {
            media: "screen",
            features: [
              { name: "prefers-color-scheme", value: options.colorScheme ?? "light" },
              {
                name: "prefers-reduced-motion",
                value: options.reducedMotion ? "reduce" : "no-preference",
              },
            ],
          },
          targetViewId,
        );
        return "Media emulation updated";
      }
    }
  }

  async cookies(options: BrowserCookieOptions, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    switch (options.action) {
      case "get": {
        const { cookies } = await this.sendCommand<{ cookies: Array<Record<string, unknown>> }>(
          "Network.getCookies",
          options.url ? { urls: [options.url] } : undefined,
          targetViewId,
        );
        return JSON.stringify(cookies, null, 2);
      }
      case "set": {
        if (!options.name || options.value === undefined) {
          throw new Error("name and value are required for cookies set");
        }
        const url =
          options.url ||
          this.getViewSession(targetViewId).webContents.getURL() ||
          "https://example.com";
        await this.sendCommand(
          "Network.setCookie",
          {
            name: options.name,
            value: options.value,
            url,
            domain: options.domain,
            path: options.path,
          },
          targetViewId,
        );
        return `Cookie set: ${options.name}`;
      }
      case "clear":
        await this.sendCommand("Network.clearBrowserCookies", {}, targetViewId);
        return "Cleared cookies";
    }
  }

  async storage(options: BrowserStorageOptions, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    switch (options.action) {
      case "getAll": {
        const value = await this.evaluateInCurrentFrame<Record<string, string>>(
          "Object.fromEntries(Object.entries(localStorage))",
          targetViewId,
        );
        return JSON.stringify(value ?? {}, null, 2);
      }
      case "get": {
        if (!options.key) throw new Error("key is required for storage get");
        const value = await this.evaluateInCurrentFrame<string | null>(
          `localStorage.getItem(${JSON.stringify(options.key)})`,
          targetViewId,
        );
        return value ?? "(null)";
      }
      case "set": {
        if (!options.key) throw new Error("key is required for storage set");
        await this.evaluateInCurrentFrame(
          `localStorage.setItem(${JSON.stringify(options.key)}, ${JSON.stringify(options.value ?? "")})`,
          targetViewId,
        );
        return `Stored ${options.key}`;
      }
      case "clear":
        await this.evaluateInCurrentFrame("localStorage.clear()", targetViewId);
        return "Cleared localStorage";
    }
  }

  async network(options: BrowserNetworkOptions, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const session = this.getViewSession(targetViewId);
    switch (options.action) {
      case "requests": {
        const rows = session.requestLogs.filter((entry) =>
          options.filter ? entry.url.includes(options.filter) : true,
        );
        if (rows.length === 0) return "(no tracked requests)";
        return rows
          .map((entry) => {
            const status = entry.status ?? (entry.failed ? "FAILED" : "");
            return `${entry.method} ${entry.url} ${status}`.trim();
          })
          .join("\n");
      }
      case "route": {
        if (!options.pattern) throw new Error("pattern is required for route");
        session.networkRoutes.push({
          pattern: options.pattern,
          abort: options.abort,
          body: options.body,
          status: options.status,
          headers: options.headers,
        });
        return `Added route for ${options.pattern}`;
      }
      case "unroute": {
        if (!options.pattern) {
          session.networkRoutes.length = 0;
          return "Cleared all routes";
        }
        session.networkRoutes = session.networkRoutes.filter(
          (route) => route.pattern !== options.pattern,
        );
        return `Removed route for ${options.pattern}`;
      }
    }
  }

  dispose(): void {
    for (const viewId of this.views.keys()) {
      this.detachDebugger(viewId);
    }
  }

  /**
   * Reset session state for a new agent session.
   * Detaches all debugger sessions and clears stale view/tab state so that
   * the next call to ensureOpenView() will open a fresh browser tab instead
   * of reusing an orphaned viewId from a previous session.
   */
  resetSession(): void {
    for (const viewId of this.views.keys()) {
      this.detachDebugger(viewId);
    }
    this.pendingViewRegistrations = [];
  }

  private getViewSession(viewId?: string): ViewSession {
    const targetId = viewId ?? this.activeViewId;
    if (!targetId) throw new Error("No browser view is open. Open a browser tab first.");
    const session = this.views.get(targetId);
    if (!session) throw new Error(`Browser view not found: ${targetId}`);
    return session;
  }

  private requireActiveViewId(): string {
    if (!this.activeViewId) {
      throw new Error("No browser view is open. Open a browser tab first.");
    }
    return this.activeViewId;
  }

  private async ensureOpenView(): Promise<string> {
    if (this.activeViewId && this.views.has(this.activeViewId)) {
      return this.activeViewId;
    }
    this.sendTabCommand("tabNew", {});
    const viewId = await this.waitForNextViewRegistration(new Set(this.views.keys()));
    this.activeViewId = viewId;
    return viewId;
  }

  private async sendCommand<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    viewId?: string,
  ): Promise<T> {
    return this.getViewSession(viewId).webContents.debugger.sendCommand(
      method,
      params,
    ) as Promise<T>;
  }

  /**
   * Transfer native OS focus to the webview's WebContents.
   * CDP keyboard events (Input.insertText, Input.dispatchKeyEvent) require the
   * target WebContents to have native focus; without it, Chromium may route the
   * events to whichever window currently owns focus — e.g. the host app's chat input.
   */
  private grantWebviewFocus(viewId: string): void {
    this.getViewSession(viewId).webContents.focus();
  }

  private handleDebuggerMessage(viewId: string, method: string, params: unknown): void {
    const session = this.views.get(viewId);
    if (!session) return;

    if (method === "Runtime.consoleAPICalled") {
      const payload = params as {
        type?: ConsoleLogEntry["level"];
        args?: Array<{ value?: unknown; description?: string }>;
      };
      const level = payload.type ?? "log";
      const message = (payload.args ?? [])
        .map((arg) => {
          if (arg.value !== undefined) return String(arg.value);
          return arg.description ?? "";
        })
        .join(" ");
      this.pushConsoleLog(session, { level, message, ts: Date.now() });
      if (level === "error") {
        this.pushErrorLog(session, { message, ts: Date.now() });
      }
      return;
    }

    if (method === "Runtime.exceptionThrown") {
      const payload = params as {
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      };
      const message =
        payload.exceptionDetails?.exception?.description ??
        payload.exceptionDetails?.text ??
        "JavaScript exception";
      this.pushErrorLog(session, { message, ts: Date.now() });
      return;
    }

    if (method === "Network.requestWillBeSent") {
      const payload = params as {
        requestId: string;
        type?: string;
        request: { url: string; method: string };
      };
      const entry: NetworkRequestEntry = {
        id: payload.requestId,
        url: payload.request.url,
        method: payload.request.method,
        resourceType: payload.type,
        ts: Date.now(),
      };
      session.inflightRequests.add(payload.requestId);
      session.requestById.set(payload.requestId, entry);
      session.requestLogs.push(entry);
      if (session.requestLogs.length > REQUEST_CAP) session.requestLogs.shift();
      return;
    }

    if (method === "Network.responseReceived") {
      const payload = params as { requestId: string; response?: { status?: number } };
      const entry = session.requestById.get(payload.requestId);
      if (entry) entry.status = payload.response?.status;
      return;
    }

    if (method === "Network.loadingFinished") {
      const payload = params as { requestId: string };
      session.inflightRequests.delete(payload.requestId);
      return;
    }

    if (method === "Network.loadingFailed") {
      const payload = params as { requestId: string; errorText?: string };
      session.inflightRequests.delete(payload.requestId);
      const entry = session.requestById.get(payload.requestId);
      if (entry) {
        entry.failed = true;
        entry.errorText = payload.errorText;
      }
      return;
    }

    if (method === "Page.frameNavigated") {
      const payload = params as { frame: { parentId?: string; id?: string } };
      // Main frame navigation — stale refs and execution contexts must be cleared
      if (!payload.frame.parentId) {
        this.refs.invalidate(viewId);
        session.frameContexts.clear();
        session.mainWorldContexts.clear();
      } else if (payload.frame.id) {
        // Sub-frame navigation: invalidate contexts for that frame only
        session.frameContexts.delete(payload.frame.id);
        session.mainWorldContexts.delete(payload.frame.id);
      }
      return;
    }

    if (method === "Runtime.executionContextCreated") {
      const payload = params as {
        context: {
          id: number;
          origin: string;
          name?: string;
          auxData?: { frameId?: string; isDefault?: boolean };
        };
      };
      const ctx = payload.context;
      // Cache main-world (isDefault) contexts so DOM.query* and
      // DOM.requestNode work with objectIds from the same world.
      if (ctx.auxData?.isDefault && ctx.auxData?.frameId) {
        session.mainWorldContexts.set(ctx.auxData.frameId, ctx.id);
      }
      return;
    }

    if (method === "Runtime.executionContextDestroyed") {
      const payload = params as { executionContextId: number };
      for (const [frameId, contextId] of session.mainWorldContexts) {
        if (contextId === payload.executionContextId) {
          session.mainWorldContexts.delete(frameId);
          break;
        }
      }
      for (const [frameId, contextId] of session.frameContexts) {
        if (contextId === payload.executionContextId) {
          session.frameContexts.delete(frameId);
          break;
        }
      }
      return;
    }

    if (method === "Page.javascriptDialogOpening") {
      const payload = params as {
        type?: string;
        message?: string;
        defaultPrompt?: string;
        url?: string;
      };
      session.dialogState = {
        type: payload.type ?? "alert",
        message: payload.message ?? "",
        defaultPrompt: payload.defaultPrompt,
        url: payload.url,
        ts: Date.now(),
      };
      if (session.dialogState.type === "alert" || session.dialogState.type === "beforeunload") {
        void this.sendCommand("Page.handleJavaScriptDialog", { accept: true }, viewId).finally(
          () => {
            session.dialogState = null;
          },
        );
      }
      return;
    }

    if (method === "Fetch.requestPaused") {
      void this.handleRequestPaused(
        viewId,
        params as {
          requestId: string;
          request: { url: string };
        },
      );
    }
  }

  private async handleRequestPaused(
    viewId: string,
    params: { requestId: string; request: { url: string } },
  ): Promise<void> {
    const session = this.views.get(viewId);
    if (!session) return;
    const route = session.networkRoutes.find((candidate) =>
      matchesBrowserPattern(params.request.url, candidate.pattern),
    );
    if (!route) {
      await this.sendCommand(
        "Fetch.continueRequest",
        { requestId: params.requestId },
        viewId,
      ).catch(() => {});
      return;
    }
    if (route.abort) {
      await this.sendCommand(
        "Fetch.failRequest",
        { requestId: params.requestId, errorReason: "Aborted" },
        viewId,
      ).catch(() => {});
      return;
    }
    if (route.body !== undefined) {
      await this.sendCommand(
        "Fetch.fulfillRequest",
        {
          requestId: params.requestId,
          responseCode: route.status ?? 200,
          responseHeaders: Object.entries(
            route.headers ?? { "content-type": "application/json" },
          ).map(([name, value]) => ({ name, value })),
          body: Buffer.from(route.body).toString("base64"),
        },
        viewId,
      ).catch(() => {});
      return;
    }
    await this.sendCommand("Fetch.continueRequest", { requestId: params.requestId }, viewId).catch(
      () => {},
    );
  }

  private pushConsoleLog(session: ViewSession, entry: ConsoleLogEntry): void {
    session.consoleLogs.push(entry);
    if (session.consoleLogs.length > LOG_CAP) session.consoleLogs.shift();
  }

  private pushErrorLog(session: ViewSession, entry: BrowserErrorEntry): void {
    session.errorLogs.push(entry);
    if (session.errorLogs.length > ERROR_CAP) session.errorLogs.shift();
  }

  private async getA11yTree(viewId: string): Promise<AXNode[]> {
    const { nodes } = await this.sendCommand<{ nodes: AXNode[] }>(
      "Accessibility.getFullAXTree",
      undefined,
      viewId,
    );
    return nodes;
  }

  private async resolveSnapshotScopeBackendNodeId(
    options: SnapshotOptions,
    viewId: string,
  ): Promise<number | undefined> {
    if (options.scopeRef && options.scopeSelector) {
      throw new Error("scopeRef and scopeSelector are mutually exclusive");
    }
    if (options.scopeRef) {
      return this.refs.getBackendNodeIdForRef(normalizeBrowserRef(options.scopeRef), viewId);
    }
    if (options.scopeSelector) {
      return this.resolveSelectorToBackendNodeId(options.scopeSelector, viewId);
    }
    return undefined;
  }

  private async getImplicitFrameScopeBackendNodeId(viewId: string): Promise<number | undefined> {
    const session = this.getViewSession(viewId);
    if (!session.activeFrameId) return undefined;
    return this.getFrameOwnerBackendNodeId(session.activeFrameId, viewId);
  }

  private async describeRef(ref: string, viewId: string): Promise<string> {
    const entry = this.refs.getRefEntry(viewId, ref);
    if (!entry) {
      return formatBrowserRef(ref);
    }
    const parts = [formatBrowserRef(ref), `[${entry.role ?? "unknown"}]`];
    if (entry.name) parts.push(JSON.stringify(entry.name));
    if (entry.value !== undefined) parts.push(`value=${JSON.stringify(String(entry.value))}`);
    if (entry.disabled) parts.push("(disabled)");
    return parts.join(" ");
  }

  private async resolveRefPosition(ref: string, viewId: string): Promise<{ x: number; y: number }> {
    const backendNodeId = this.refs.getBackendNodeIdForRef(ref, viewId);
    const { model } = await this.sendCommand<{ model: CDPBoxModel }>(
      "DOM.getBoxModel",
      { backendNodeId },
      viewId,
    );
    const box = this.boxModelToRect(model);
    return {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
    };
  }

  private boxModelToRect(model: CDPBoxModel): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    const xs = [model.content[0], model.content[2], model.content[4], model.content[6]];
    const ys = [model.content[1], model.content[3], model.content[5], model.content[7]];
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  }

  private async dispatchMouseClick(
    x: number,
    y: number,
    clickCount: number,
    viewId: string,
  ): Promise<void> {
    await this.sendCommand(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x, y, button: "left", clickCount },
      viewId,
    );
    await this.sendCommand(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x, y, button: "left", clickCount },
      viewId,
    );
  }

  private async waitForPotentialNavigation(viewId: string): Promise<void> {
    await this.waitForLoadEvent(viewId, undefined, 750);
  }

  private async waitForLoadEvent(
    viewId: string,
    action?: () => void,
    timeoutMs: number = WAIT_FOR_LOAD_TIMEOUT,
  ): Promise<void> {
    const session = this.getViewSession(viewId);
    await new Promise<void>((resolvePromise) => {
      const cleanup = () => {
        clearTimeout(timer);
        session.webContents.debugger.removeListener("message", onMessage);
        resolvePromise();
      };
      const onMessage = (_event: DebuggerEvent, method: string) => {
        if (method === "Page.loadEventFired") cleanup();
      };
      const timer = setTimeout(cleanup, timeoutMs);
      session.webContents.debugger.on("message", onMessage);
      action?.();
    });
  }

  private async editTextTarget(
    ref: string,
    text: string,
    mode: "replace" | "insert",
    viewId: string,
  ): Promise<void> {
    const backendNodeId = this.refs.getBackendNodeIdForRef(ref, viewId);
    const objectId = await this.resolveObjectIdForBackendNode(backendNodeId, viewId);
    const { result } = await this.sendCommand<{
      result: {
        value?: { ok: boolean; error?: string };
        description?: string;
      };
    }>(
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: `function(text, mode) {
          const textLikeInputTypes = new Set([
            'text',
            'search',
            'url',
            'tel',
            'email',
            'password',
            'number',
          ]);

          const applyValue = (element, nextValue, inputType) => {
            let setter;
            if (element instanceof HTMLInputElement) {
              setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            } else if (element instanceof HTMLTextAreaElement) {
              setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            }
            if (setter) {
              setter.call(element, nextValue);
            } else {
              element.value = nextValue;
            }
            element.dispatchEvent(new InputEvent('input', {
              bubbles: true,
              cancelable: true,
              inputType,
              data: text,
            }));
            element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          };

          const setCaret = (element, caret) => {
            if (typeof element.setSelectionRange !== 'function') return;
            try {
              element.setSelectionRange(caret, caret);
            } catch {
              // Some input types expose setSelectionRange but throw at runtime.
            }
          };

          const editFormControl = (element) => {
            const rawType = element instanceof HTMLInputElement ? (element.type || 'text').toLowerCase() : 'textarea';
            if (element instanceof HTMLInputElement && !textLikeInputTypes.has(rawType)) {
              return { ok: false, error: 'Element is not a text-like input' };
            }

            element.focus();
            const currentValue = typeof element.value === 'string' ? element.value : '';
            if (mode === 'replace') {
              applyValue(element, text, 'insertReplacementText');
              setCaret(element, text.length);
              return { ok: true };
            }

            const canSelect =
              typeof element.selectionStart === 'number' && typeof element.selectionEnd === 'number';
            let start = currentValue.length;
            let end = currentValue.length;
            if (canSelect) {
              const isFocused = document.activeElement === element;
              start = isFocused ? (element.selectionStart ?? currentValue.length) : currentValue.length;
              end = isFocused ? (element.selectionEnd ?? currentValue.length) : currentValue.length;
            }
            const nextValue = currentValue.slice(0, start) + text + currentValue.slice(end);
            applyValue(element, nextValue, 'insertText');
            setCaret(element, start + text.length);
            return { ok: true };
          };

          const resolveEditableHost = (element) => {
            if (!(element instanceof HTMLElement)) return null;
            if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
              return element;
            }
            if (element.isContentEditable) return element;
            return element.closest('[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]');
          };

          const editContentEditable = (host) => {
            host.focus();
            const selection = window.getSelection();
            if (!selection) {
              return { ok: false, error: 'Unable to access page selection' };
            }

            let range;
            const hasSelectionInsideHost =
              selection.rangeCount > 0 &&
              host.contains(selection.anchorNode) &&
              host.contains(selection.focusNode);

            if (mode === 'insert' && hasSelectionInsideHost) {
              range = selection.getRangeAt(0).cloneRange();
            } else {
              range = document.createRange();
              range.selectNodeContents(host);
              range.collapse(mode === 'insert');
            }

            range.deleteContents();
            if (text.length > 0) {
              const textNode = document.createTextNode(text);
              range.insertNode(textNode);
              range.setStartAfter(textNode);
              range.collapse(true);
            }
            selection.removeAllRanges();
            selection.addRange(range);
            host.dispatchEvent(new InputEvent('input', {
              bubbles: true,
              cancelable: true,
              inputType: mode === 'replace' ? 'insertReplacementText' : 'insertText',
              data: text,
            }));
            return { ok: true };
          };

          const target = resolveEditableHost(this);
          if (!target) {
            return { ok: false, error: 'Element is not fillable' };
          }
          if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
            return editFormControl(target);
          }
          return editContentEditable(target);
        }`,
        arguments: [{ value: text }, { value: mode }],
        returnByValue: true,
        awaitPromise: true,
      },
      viewId,
    );

    const value = result.value;
    if (!value?.ok) {
      throw new Error(value?.error ?? "Failed to edit text target");
    }
  }

  private async sendKeySequence(keys: string, viewId: string): Promise<void> {
    const parts = keys
      .split("+")
      .map((part) => part.trim())
      .filter(Boolean);
    const modifiers = new Set<string>();
    for (const raw of parts.slice(0, -1)) {
      const lower = raw.toLowerCase();
      if (lower === "mod") {
        modifiers.add(process.platform === "darwin" ? "meta" : "control");
      } else {
        modifiers.add(lower);
      }
    }
    const mainKey = parts.at(-1);
    if (!mainKey) return;
    await this.sendKeyCombo([mainKey], modifiers, viewId);
  }

  private async sendKeyCombo(
    keys: string[],
    modifiers: Set<string>,
    viewId: string,
  ): Promise<void> {
    const modifierFlags = [...modifiers].reduce(
      (total, modifier) => total + modifierFlag(modifier),
      0,
    );
    for (const key of keys) {
      const parsed = parseKey(key);
      await this.sendCommand(
        "Input.dispatchKeyEvent",
        { type: "keyDown", key: parsed.key, code: parsed.code, modifiers: modifierFlags },
        viewId,
      );
      await this.sendCommand(
        "Input.dispatchKeyEvent",
        { type: "keyUp", key: parsed.key, code: parsed.code, modifiers: modifierFlags },
        viewId,
      );
    }
  }

  private async sendKeyEvent(
    type: "keyDown" | "keyUp",
    parsed: { key: string; code: string; modifiers: number },
    viewId: string,
  ): Promise<void> {
    await this.sendCommand(
      "Input.dispatchKeyEvent",
      { type, key: parsed.key, code: parsed.code, modifiers: parsed.modifiers },
      viewId,
    );
  }

  private async setCheckedState(ref: string, checked: boolean, viewId?: string): Promise<string> {
    const targetViewId = viewId ?? this.requireActiveViewId();
    const normalizedRef = normalizeBrowserRef(ref);
    const current = await this.callOnRefNode<boolean>(
      normalizedRef,
      "function() { return !!this.checked; }",
      targetViewId,
    );
    if (Boolean(current) !== checked) {
      await this.click(normalizedRef, false, targetViewId);
    }
    return checked
      ? `Checked ${formatBrowserRef(normalizedRef)}`
      : `Unchecked ${formatBrowserRef(normalizedRef)}`;
  }

  private async callOnRefNode<T>(
    ref: string,
    functionDeclaration: string,
    viewId: string,
  ): Promise<T> {
    const backendNodeId = this.refs.getBackendNodeIdForRef(ref, viewId);
    const objectId = await this.resolveObjectIdForBackendNode(backendNodeId, viewId);
    const { result } = await this.sendCommand<{ result: { value?: T; description?: string } }>(
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration,
        returnByValue: true,
        awaitPromise: true,
      },
      viewId,
    );
    return (result.value ?? result.description) as T;
  }

  private async resolveObjectIdForBackendNode(
    backendNodeId: number,
    viewId: string,
  ): Promise<string> {
    const { object } = await this.sendCommand<{ object: { objectId: string } }>(
      "DOM.resolveNode",
      { backendNodeId },
      viewId,
    );
    return object.objectId;
  }

  private async getAttribute(ref: string, name: string, viewId: string): Promise<string> {
    const value = await this.callOnRefNode<string | null>(
      ref,
      `function() { return this.getAttribute(${JSON.stringify(name)}); }`,
      viewId,
    );
    return value ?? `Attribute "${name}" not set`;
  }

  private async evaluateInCurrentFrame<T>(
    expression: string,
    viewId: string,
    returnByValue: boolean = true,
  ): Promise<T> {
    const frameId = await this.getCurrentFrameId(viewId);
    const contextId = await this.getExecutionContextId(viewId, frameId);
    const { result } = await this.sendCommand<{
      result: { value?: T; description?: string; objectId?: string };
    }>(
      "Runtime.evaluate",
      {
        expression,
        contextId,
        returnByValue,
        awaitPromise: true,
      },
      viewId,
    );
    return (result.value ?? (result as unknown as T)) as T;
  }

  private async getExecutionContextId(viewId: string, frameId: string): Promise<number> {
    const session = this.getViewSession(viewId);
    // Prefer the main-world context so that objectIds work with DOM.requestNode.
    // Isolated-world objectIds can cause "Could not find node with given id".
    const mainWorld = session.mainWorldContexts.get(frameId);
    if (mainWorld !== undefined) return mainWorld;

    // The main-world context may not have been discovered yet (the
    // executionContextCreated event arrives asynchronously after Runtime.enable).
    // Wait briefly for it to appear before falling back to isolated world.
    const waited = await this.pollUntil(
      () => Promise.resolve(session.mainWorldContexts.has(frameId)),
      1000,
      50,
    );
    if (waited) {
      const ctx = session.mainWorldContexts.get(frameId);
      if (ctx !== undefined) return ctx;
    }

    // Fallback: create an isolated world. DOM.requestNode may fail for
    // objectIds from isolated worlds, but this is better than nothing.
    const cached = session.frameContexts.get(frameId);
    if (cached !== undefined) return cached;

    const { executionContextId } = await this.sendCommand<{ executionContextId: number }>(
      "Page.createIsolatedWorld",
      {
        frameId,
        worldName: `neovate-browser-${frameId}`,
        grantUniveralAccess: true,
      },
      viewId,
    );
    session.frameContexts.set(frameId, executionContextId);
    return executionContextId;
  }

  private async getFrameTree(viewId: string): Promise<PageFrameTree> {
    const { frameTree } = await this.sendCommand<{ frameTree: PageFrameTree }>(
      "Page.getFrameTree",
      undefined,
      viewId,
    );
    return frameTree;
  }

  private flattenFrameTree(tree: PageFrameTree): PageFrame[] {
    const result = [tree.frame];
    for (const child of tree.childFrames ?? []) {
      result.push(...this.flattenFrameTree(child));
    }
    return result;
  }

  private async getMainFrameId(viewId: string): Promise<string> {
    return (await this.getFrameTree(viewId)).frame.id;
  }

  private async getCurrentFrameId(viewId: string): Promise<string> {
    const session = this.getViewSession(viewId);
    return session.activeFrameId ?? (await this.getMainFrameId(viewId));
  }

  private async getFrameOwnerBackendNodeId(frameId: string, viewId: string): Promise<number> {
    const { backendNodeId } = await this.sendCommand<{ backendNodeId: number }>(
      "DOM.getFrameOwner",
      { frameId },
      viewId,
    );
    return backendNodeId;
  }

  private async getFrameIdFromRef(ref: string, viewId: string): Promise<string | null> {
    const backendNodeId = this.refs.getBackendNodeIdForRef(normalizeBrowserRef(ref), viewId);
    return this.getFrameIdFromBackendNode(backendNodeId, viewId);
  }

  private async getFrameIdFromBackendNode(
    backendNodeId: number,
    viewId: string,
  ): Promise<string | null> {
    const { node } = await this.sendCommand<{ node: { frameId?: string } }>(
      "DOM.describeNode",
      { backendNodeId },
      viewId,
    );
    return node.frameId ?? null;
  }

  private async resolveSelectorToBackendNodeId(selector: string, viewId: string): Promise<number> {
    const ids = await this.querySelectorBackendNodeIds(selector, viewId);
    const first = ids[0];
    if (first === undefined) {
      throw new Error(`No element matching selector ${selector}`);
    }
    return first;
  }

  private async resolveSingleRefFromSelector(
    selector: string | undefined,
    viewId: string,
  ): Promise<string> {
    if (!selector) throw new Error("selector is required");
    const backendNodeId = await this.resolveSelectorToBackendNodeId(selector, viewId);
    const [ref] = await this.refs.ensureRefsForBackendNodeIds(viewId, [backendNodeId], () =>
      this.getA11yTree(viewId),
    );
    if (!ref) throw new Error(`No element matching selector ${selector}`);
    return ref;
  }

  private async queryBackendNodeIdsByScript(
    queryBody: string,
    viewId: string,
    scopeRef?: string,
  ): Promise<number[]> {
    const scopeBackendNodeId = scopeRef
      ? this.refs.getBackendNodeIdForRef(normalizeBrowserRef(scopeRef), viewId)
      : undefined;
    const arrayObjectId = scopeBackendNodeId
      ? await this.evaluateArrayOnScope(queryBody, scopeBackendNodeId, viewId)
      : await this.evaluateArrayInCurrentFrame(queryBody, viewId);
    if (!arrayObjectId) {
      log("find: no arrayObjectId returned — JS query returned no result");
      return [];
    }
    try {
      const ids = await this.arrayObjectIdToBackendNodeIds(arrayObjectId, viewId);
      log("find: arrayObjectId → %d backendNodeId(s)", ids.length);
      return ids;
    } finally {
      await this.sendCommand("Runtime.releaseObject", { objectId: arrayObjectId }, viewId).catch(
        () => {},
      );
    }
  }

  private async evaluateArrayInCurrentFrame(
    queryBody: string,
    viewId: string,
  ): Promise<string | undefined> {
    const frameId = await this.getCurrentFrameId(viewId);
    const contextId = await this.getExecutionContextId(viewId, frameId);
    const response = await this.sendCommand<{
      result?: { type?: string; subtype?: string; objectId?: string; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      "Runtime.evaluate",
      {
        contextId,
        returnByValue: false,
        awaitPromise: true,
        expression: `(function() { ${LOCATOR_HELPERS_JS} const root = document; ${queryBody} })()`,
      },
      viewId,
    );
    if (response.exceptionDetails) {
      const msg =
        response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        "unknown error";
      log("find: Runtime.evaluate threw — %s", msg);
      return undefined;
    }
    const result = response.result;
    if (!result?.objectId) {
      log(
        "find: Runtime.evaluate returned no objectId (type=%s, subtype=%s, desc=%s)",
        result?.type,
        result?.subtype,
        result?.description,
      );
      return undefined;
    }
    return result.objectId;
  }

  private async evaluateArrayOnScope(
    queryBody: string,
    scopeBackendNodeId: number,
    viewId: string,
  ): Promise<string | undefined> {
    const objectId = await this.resolveObjectIdForBackendNode(scopeBackendNodeId, viewId);
    const response = await this.sendCommand<{
      result?: { type?: string; subtype?: string; objectId?: string; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      "Runtime.callFunctionOn",
      {
        objectId,
        returnByValue: false,
        awaitPromise: true,
        functionDeclaration: `function() { ${LOCATOR_HELPERS_JS} const root = this; ${queryBody} }`,
      },
      viewId,
    );
    if (response.exceptionDetails) {
      const msg =
        response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        "unknown error";
      log("find: Runtime.callFunctionOn threw — %s", msg);
      return undefined;
    }
    const result = response.result;
    if (!result?.objectId) {
      log(
        "find: Runtime.callFunctionOn returned no objectId (type=%s, subtype=%s)",
        result?.type,
        result?.subtype,
      );
      return undefined;
    }
    return result.objectId;
  }

  private async arrayObjectIdToBackendNodeIds(
    arrayObjectId: string,
    viewId: string,
  ): Promise<number[]> {
    const { result } = await this.sendCommand<{
      result: Array<{ name: string; value?: { objectId?: string } }>;
    }>("Runtime.getProperties", { objectId: arrayObjectId, ownProperties: true }, viewId);

    const numericEntries = result
      .filter((entry) => /^\d+$/.test(entry.name) && entry.value?.objectId)
      .sort((left, right) => Number(left.name) - Number(right.name));

    const backendNodeIds: number[] = [];
    for (const entry of numericEntries) {
      const objectId = entry.value?.objectId;
      if (!objectId) continue;
      try {
        const { nodeId } = await this.sendCommand<{ nodeId: number }>(
          "DOM.requestNode",
          { objectId },
          viewId,
        );
        const { node } = await this.sendCommand<{ node: { backendNodeId?: number } }>(
          "DOM.describeNode",
          { nodeId },
          viewId,
        );
        if (node.backendNodeId !== undefined) {
          backendNodeIds.push(node.backendNodeId);
        }
      } catch {
        // DOM.requestNode may fail when objectId comes from an isolated world
        // that is incompatible with the DOM debugger. Skip gracefully — the
        // element still exists in the DOM, but we cannot resolve its
        // backendNodeId through this path.
        log("DOM.requestNode failed for objectId — isolated-world mismatch?");
      } finally {
        await this.sendCommand("Runtime.releaseObject", { objectId }, viewId).catch(() => {});
      }
    }

    return backendNodeIds;
  }

  private async findBackendNodeIds(options: BrowserFindOptions, viewId: string): Promise<number[]> {
    const value = options.value ?? "";
    const exact = Boolean(options.exact);
    log("find: by=%s value=%q scopeRef=%s", options.by, value, options.scopeRef ?? "(none)");

    let backendNodeIds: number[];

    // For CSS selectors, use DOM.querySelectorAll directly — it bypasses
    // Runtime.evaluate entirely and avoids the returnByValue:false + objectId
    // path which fails in isolated-world contexts.
    if (options.by === "selector") {
      backendNodeIds = await this.querySelectorBackendNodeIds(value, viewId, options.scopeRef);
      log("find: DOM.querySelectorAll resolved %d backendNodeId(s)", backendNodeIds.length);
    } else {
      const queryBody = buildFindQuery(options.by, value, options.name, exact);
      backendNodeIds = await this.queryBackendNodeIdsByScript(queryBody, viewId, options.scopeRef);
      log("find: JS query resolved %d backendNodeId(s)", backendNodeIds.length);

      // Fallback to AX-tree search when JS query returns nothing.
      // This covers cases where the execution context is unavailable or
      // DOM.requestNode fails for isolated-world objectIds.
      if (backendNodeIds.length === 0) {
        const axIds = await this.findBackendNodeIdsViaAXTree(options, viewId);
        if (axIds.length > 0) {
          log("find: AX-tree fallback resolved %d backendNodeId(s)", axIds.length);
          backendNodeIds = axIds;
        }
      }
    }

    if (options.nth !== undefined) {
      const match = backendNodeIds[options.nth];
      backendNodeIds = match === undefined ? [] : [match];
    } else if (!options.all) {
      backendNodeIds = backendNodeIds.slice(0, 1);
    }
    return backendNodeIds;
  }

  /**
   * Resolve CSS selectors via CDP DOM.querySelectorAll directly, skipping the
   * Runtime.evaluate → objectId → DOM.requestNode chain which fails when the
   * execution context is from an isolated world.
   */
  private async querySelectorBackendNodeIds(
    selector: string,
    viewId: string,
    scopeRef?: string,
  ): Promise<number[]> {
    try {
      // Determine the root nodeId for the query.
      let rootNodeId: number;
      if (scopeRef) {
        const scopeBId = this.refs.getBackendNodeIdForRef(normalizeBrowserRef(scopeRef), viewId);
        const { node } = await this.sendCommand<{ node: { nodeId: number } }>(
          "DOM.describeNode",
          { backendNodeId: scopeBId },
          viewId,
        );
        rootNodeId = node.nodeId;
      } else {
        // If a frame is active, resolve the frame owner as root;
        // otherwise use the document root.
        const session = this.getViewSession(viewId);
        if (session.activeFrameId) {
          const frameOwnerBId = await this.getFrameOwnerBackendNodeId(
            session.activeFrameId,
            viewId,
          );
          const { node } = await this.sendCommand<{ node: { nodeId: number } }>(
            "DOM.describeNode",
            { backendNodeId: frameOwnerBId },
            viewId,
          );
          rootNodeId = node.nodeId;
        } else {
          const { root } = await this.sendCommand<{ root: { nodeId: number } }>(
            "DOM.getDocument",
            undefined,
            viewId,
          );
          rootNodeId = root.nodeId;
        }
      }

      const { nodeIds } = await this.sendCommand<{ nodeIds: number[] }>(
        "DOM.querySelectorAll",
        { nodeId: rootNodeId, selector },
        viewId,
      );

      if (!nodeIds || nodeIds.length === 0) return [];

      // Convert nodeIds to backendNodeIds via DOM.describeNode.
      const backendNodeIds: number[] = [];
      for (const nid of nodeIds) {
        try {
          const { node } = await this.sendCommand<{ node: { backendNodeId?: number } }>(
            "DOM.describeNode",
            { nodeId: nid },
            viewId,
          );
          if (node.backendNodeId !== undefined) {
            backendNodeIds.push(node.backendNodeId);
          }
        } catch {
          // Some nodes (e.g. detached) may fail to describe; skip them.
        }
      }
      return backendNodeIds;
    } catch (error) {
      log("find: DOM.querySelectorAll failed — %s", error);
      return [];
    }
  }

  /**
   * Fallback: search the accessibility tree directly when the JS query path
   * returns no results (e.g. isolated-world context, DOM.requestNode failures).
   * Only supports role-based and text-based lookups — CSS selectors cannot be
   * expressed in the AX tree.
   */
  private async findBackendNodeIdsViaAXTree(
    options: BrowserFindOptions,
    viewId: string,
  ): Promise<number[]> {
    const nodes = await this.getA11yTree(viewId);
    const wanted = options.value ?? "";
    const exact = Boolean(options.exact);
    const wantedName = options.name ?? "";

    // If scoped, restrict to descendants of the scope element
    let scopeNode: AXNode | undefined;
    let scopedDescendantIds: Set<string> | undefined;
    if (options.scopeRef) {
      const scopeBId = this.refs.getBackendNodeIdForRef(
        normalizeBrowserRef(options.scopeRef),
        viewId,
      );
      scopeNode = nodes.find((n) => n.backendDOMNodeId === scopeBId);
      if (scopeNode) {
        scopedDescendantIds = collectDescendantNodeIds(scopeNode, nodes);
      }
    }

    const matches: AXNode[] = [];

    for (const node of nodes) {
      // Skip ignored nodes and nodes without a backend DOM node id
      if (node.ignored || node.backendDOMNodeId === undefined) continue;

      // If scoped, only consider descendants
      if (scopedDescendantIds && !scopedDescendantIds.has(node.nodeId)) continue;

      if (!axNodeMatchesQuery(node, options.by, wanted, wantedName, exact)) continue;

      matches.push(node);
    }

    return matches.map((n) => n.backendDOMNodeId as number);
  }

  private async pollUntil(
    predicate: () => Promise<boolean>,
    timeoutMs: number,
    intervalMs: number = 200,
  ): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await predicate()) return true;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
    }
    return false;
  }

  private async waitForLoadState(
    loadState: LoadState,
    viewId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    if (loadState === "networkidle") {
      const session = this.getViewSession(viewId);
      let idleSince: number | null = null;
      return this.pollUntil(async () => {
        const readyState = await this.evaluateInCurrentFrame<string>("document.readyState", viewId);
        if (readyState !== "complete") {
          idleSince = null;
          return false;
        }
        if (session.inflightRequests.size === 0) {
          idleSince ??= Date.now();
          return Date.now() - idleSince >= NETWORK_IDLE_QUIET_MS;
        }
        idleSince = null;
        return false;
      }, timeoutMs);
    }

    return this.pollUntil(async () => {
      const readyState = await this.evaluateInCurrentFrame<string>("document.readyState", viewId);
      if (loadState === "domcontentloaded") {
        return readyState === "interactive" || readyState === "complete";
      }
      return readyState === "complete";
    }, timeoutMs);
  }

  private async captureScreenshot(fullPage: boolean, viewId: string): Promise<string> {
    if (fullPage) {
      const dims = await this.evaluateInCurrentFrame<{ width: number; height: number }>(
        "({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })",
        viewId,
      );
      await this.sendCommand(
        "Emulation.setDeviceMetricsOverride",
        {
          width: dims?.width ?? 1280,
          height: dims?.height ?? 720,
          deviceScaleFactor: 1,
          mobile: false,
        },
        viewId,
      );
      const { data } = await this.sendCommand<{ data: string }>(
        "Page.captureScreenshot",
        { format: "png" },
        viewId,
      );
      await this.sendCommand("Emulation.clearDeviceMetricsOverride", {}, viewId).catch(() => {});
      return `data:image/png;base64,${data}`;
    }
    const { data } = await this.sendCommand<{ data: string }>(
      "Page.captureScreenshot",
      { format: "png" },
      viewId,
    );
    return `data:image/png;base64,${data}`;
  }

  private async getViewportCenter(viewId: string): Promise<{ x: number; y: number }> {
    const value = await this.evaluateInCurrentFrame<{ innerWidth: number; innerHeight: number }>(
      "({ innerWidth: window.innerWidth, innerHeight: window.innerHeight })",
      viewId,
    );
    return {
      x: Math.round((value?.innerWidth ?? 1280) / 2),
      y: Math.round((value?.innerHeight ?? 720) / 2),
    };
  }

  private waitForNextViewRegistration(existingIds?: Set<string>): Promise<string> {
    return new Promise<string>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pendingViewRegistrations = this.pendingViewRegistrations.filter(
          (candidate) => candidate !== onRegister,
        );
        rejectPromise(new Error("Timeout waiting for new browser tab"));
      }, WAIT_FOR_VIEW_TIMEOUT);

      const onRegister = (viewId: string) => {
        if (existingIds?.has(viewId)) return;
        clearTimeout(timer);
        resolvePromise(viewId);
      };

      this.pendingViewRegistrations.push(onRegister);
    });
  }

  private resolvePendingViewRegistrations(viewId: string): void {
    const waiters = this.pendingViewRegistrations.splice(0);
    for (const waiter of waiters) {
      waiter(viewId);
    }
  }

  private tabList(): TabInfo[] {
    return Array.from(this.views.entries()).map(([viewId, session]) => ({
      viewId,
      url: session.webContents.getURL() || "about:blank",
      title: session.webContents.getTitle() || "",
      isActive: viewId === this.activeViewId,
    }));
  }

  private async tabNew(url?: string): Promise<string> {
    const existing = new Set(this.views.keys());
    this.sendTabCommand("tabNew", url ? { url } : {});
    const viewId = await this.waitForNextViewRegistration(existing);
    this.activeViewId = viewId;
    if (url) {
      await this.open(url, viewId);
      return `Opened new tab: ${normalizeBrowserUrl(url)}`;
    }
    return "Opened new blank tab";
  }

  private async tabSwitch(index: number): Promise<string> {
    const viewIds = Array.from(this.views.keys());
    if (index < 0 || index >= viewIds.length) {
      throw new Error(`Invalid tab index ${index}`);
    }
    const targetId = viewIds[index];
    if (!targetId) throw new Error(`Invalid tab index ${index}`);
    this.activeViewId = targetId;
    this.sendTabCommand("tabSwitch", { viewId: targetId });
    return `Switched to tab ${index}`;
  }

  private async tabClose(index?: number): Promise<string> {
    const viewIds = Array.from(this.views.keys());
    const targetId = index === undefined ? this.requireActiveViewId() : viewIds[index];
    if (!targetId) {
      throw new Error(`Invalid tab index ${index}`);
    }
    this.sendTabCommand("tabClose", { viewId: targetId });
    return index === undefined ? "Closed active tab" : `Closed tab ${index}`;
  }
}
