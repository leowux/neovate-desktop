import debug from "debug";
import { ipcMain, type IpcMainEvent } from "electron";
import { randomUUID } from "node:crypto";

import type { IBrowserWindowManager } from "../../core/types";

const log = debug("neovate:browser-ipc");

const CALL_TIMEOUT_MS = 20_000;

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Bridge for main-process → renderer IPC calls used by browser automation.
 * Main sends `nv:browser-cmd` to the renderer and waits for `nv:browser-result`.
 */
export class BrowserIpcBridge {
  private pending = new Map<string, PendingCall>();
  private attached = false;

  constructor(private windowManager: IBrowserWindowManager) {}

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    ipcMain.on("nv:browser-result", this.handleResult);
    log("attached");
  }

  dispose(): void {
    ipcMain.removeListener("nv:browser-result", this.handleResult);
    this.attached = false;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("BrowserIpcBridge disposed"));
    }
    this.pending.clear();
    log("disposed");
  }

  async call(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const webContents = this.windowManager.mainWindow?.webContents;
    if (!webContents) {
      throw new Error("Main window not available — cannot reach browser automation service");
    }

    const requestId = randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();

    const timer = setTimeout(() => {
      this.pending.delete(requestId);
      reject(new Error(`Browser automation timeout for method: ${method}`));
    }, CALL_TIMEOUT_MS);

    this.pending.set(requestId, { resolve, reject, timer });
    webContents.send("nv:browser-cmd", { requestId, method, args });
    log("call method=%s requestId=%s", method, requestId);

    return promise;
  }

  private handleResult = (
    _event: IpcMainEvent,
    { requestId, result, error }: { requestId: string; result: unknown; error?: string },
  ): void => {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    if (error) {
      log("result error method requestId=%s error=%s", requestId, error);
      pending.reject(new Error(error));
    } else {
      log("result ok requestId=%s", requestId);
      pending.resolve(result);
    }
  };
}
