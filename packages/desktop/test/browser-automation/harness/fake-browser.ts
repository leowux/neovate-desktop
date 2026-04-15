import { vi } from "vitest";

import { BrowserCdpService } from "../../../src/main/plugins/browser-automation/browser-cdp-service";

type DebuggerListener = (
  event: { preventDefault: () => void; defaultPrevented: boolean },
  method: string,
  params: unknown,
  sessionId: string,
) => void;

type CommandHandler = (params: Record<string, unknown> | undefined) => unknown | Promise<unknown>;

export class FakeDebugger {
  readonly attach = vi.fn();
  readonly detach = vi.fn();
  readonly calls: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
  readonly listeners = new Set<DebuggerListener>();

  private handlers = new Map<string, CommandHandler>();
  private queuedResponses = new Map<string, unknown[]>();

  readonly on = vi.fn((event: string, listener: DebuggerListener) => {
    if (event === "message") this.listeners.add(listener);
  });

  readonly removeListener = vi.fn((event: string, listener: DebuggerListener) => {
    if (event === "message") this.listeners.delete(listener);
  });

  setHandler(method: string, handler: CommandHandler): void {
    this.handlers.set(method, handler);
  }

  queueResponse(method: string, ...responses: unknown[]): void {
    const queue = this.queuedResponses.get(method) ?? [];
    queue.push(...responses);
    this.queuedResponses.set(method, queue);
  }

  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });

    const queue = this.queuedResponses.get(method);
    if (queue && queue.length > 0) {
      return queue.shift();
    }

    const handler = this.handlers.get(method);
    if (handler) {
      return handler(params);
    }

    return {};
  }

  emit(method: string, params: unknown = {}): void {
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    for (const listener of this.listeners) {
      listener(event, method, params, "session-1");
    }
  }

  lastCall(
    method: string,
  ): { method: string; params: Record<string, unknown> | undefined } | undefined {
    return [...this.calls].reverse().find((call) => call.method === method);
  }
}

export class FakeWebContents {
  readonly debugger = new FakeDebugger();
  readonly loadURL = vi.fn(async (url: string) => {
    this.pushHistory(url);
    this.debugger.emit("Page.loadEventFired");
  });
  readonly goBack = vi.fn(() => {
    if (!this.canGoBack()) return;
    this.historyIndex -= 1;
    this.debugger.emit("Page.loadEventFired");
  });
  readonly goForward = vi.fn(() => {
    if (!this.canGoForward()) return;
    this.historyIndex += 1;
    this.debugger.emit("Page.loadEventFired");
  });
  readonly reload = vi.fn(() => {
    this.debugger.emit("Page.loadEventFired");
  });
  readonly openDevTools = vi.fn();
  readonly setWindowOpenHandler = vi.fn(
    (handler: (details: { url: string }) => { action: string }) => {
      this.windowOpenHandler = handler;
      return { action: "deny" };
    },
  );
  readonly send = vi.fn();

  private history: string[];
  private historyIndex: number;
  private title: string;
  private windowOpenHandler: ((details: { url: string }) => { action: string }) | null = null;

  constructor(initialUrl: string = "about:blank") {
    this.history = [initialUrl];
    this.historyIndex = 0;
    this.title = this.deriveTitle(initialUrl);
  }

  getURL(): string {
    return this.history[this.historyIndex] ?? "about:blank";
  }

  getTitle(): string {
    return this.title;
  }

  canGoBack(): boolean {
    return this.historyIndex > 0;
  }

  canGoForward(): boolean {
    return this.historyIndex < this.history.length - 1;
  }

  triggerWindowOpen(url: string): { action: string } | null {
    return this.windowOpenHandler?.({ url }) ?? null;
  }

  private pushHistory(url: string): void {
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(url);
    this.historyIndex = this.history.length - 1;
    this.title = this.deriveTitle(url);
  }

  private deriveTitle(url: string): string {
    if (url === "about:blank") return "";
    try {
      const parsed = new URL(url);
      return parsed.hostname || parsed.pathname || url;
    } catch {
      return url;
    }
  }
}

export async function createBrowserCdpHarness(
  options: {
    initialUrl?: string;
    sendTabCommand?: (method: string, args: unknown, service: BrowserCdpService) => void;
  } = {},
) {
  let serviceRef: BrowserCdpService;
  const sendTabCommand = vi.fn((method: string, args: unknown) => {
    options.sendTabCommand?.(method, args, serviceRef);
  });
  const service = new BrowserCdpService(sendTabCommand);
  serviceRef = service;

  const webContents = new FakeWebContents(options.initialUrl);
  await service.attachDebugger("view-1", webContents as never);

  return {
    service,
    webContents,
    debuggerClient: webContents.debugger,
    sendTabCommand,
    async attachView(viewId: string, initialUrl: string = "about:blank") {
      const wc = new FakeWebContents(initialUrl);
      await service.attachDebugger(viewId, wc as never);
      return wc;
    },
  };
}
