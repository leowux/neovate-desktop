import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { IpcMainInvokeEvent } from "electron";

import { ipcMain, webContents } from "electron";

import type { MainPlugin, PluginContext } from "../../core/plugin/types";

import { toDisposable } from "../../core/disposable";
import { BrowserCdpService } from "./browser-cdp-service";
import { createBrowserMcpServer } from "./mcp-server";

let cdpService: BrowserCdpService | null = null;

/**
 * Create a fresh McpSdkServerConfigWithInstance for each session.
 * McpServer instances from @modelcontextprotocol/sdk support only one connection
 * lifetime — reusing the same instance after a session ends causes the next session
 * to see no browser tools. A fresh instance must be created per session.
 */
export function createFreshBrowserMcpServer(): McpSdkServerConfigWithInstance | null {
  if (!cdpService) return null;
  // Reset stale view/debugger state from previous session so ensureOpenView()
  // won't reuse an orphaned viewId whose tab was already closed by the renderer.
  cdpService.resetSession();
  return createBrowserMcpServer(cdpService);
}

const browserAutomationPlugin: MainPlugin = {
  name: "browser-automation",

  configContributions(ctx: PluginContext) {
    // Create CDP service with callback for tab commands
    cdpService = new BrowserCdpService((method: string, args: unknown) => {
      const wc = ctx.app.windowManager.mainWindow?.webContents;
      if (wc) {
        wc.send("nv:browser-tab-cmd", { method, args });
      }
    });
    return {};
  },

  activate(ctx: PluginContext) {
    ipcMain.handle(
      "browser:registerWebContents",
      (
        _event: IpcMainInvokeEvent,
        { viewId, webContentsId }: { viewId: string; webContentsId: number },
      ) => {
        const wc = webContents.fromId(webContentsId);
        if (wc && cdpService) {
          cdpService.attachDebugger(viewId, wc);
          log("registered webContents viewId=%s wcId=%d", viewId, webContentsId);
        }
      },
    );

    ipcMain.handle(
      "browser:unregisterWebContents",
      (_event: IpcMainInvokeEvent, { viewId }: { viewId: string }) => {
        if (cdpService) {
          cdpService.detachDebugger(viewId);
          log("unregistered webContents viewId=%s", viewId);
        }
      },
    );

    ipcMain.handle(
      "browser:setActiveView",
      (_event: IpcMainInvokeEvent, { viewId }: { viewId: string }) => {
        cdpService?.setActiveView(viewId);
      },
    );

    ctx.app.subscriptions.push(
      toDisposable(() => {
        ipcMain.removeHandler("browser:registerWebContents");
        ipcMain.removeHandler("browser:unregisterWebContents");
        ipcMain.removeHandler("browser:setActiveView");
      }),
    );
  },

  deactivate() {
    cdpService?.dispose();
    cdpService = null;
  },
};

const log = require("debug")("neovate:browser-automation");

export default browserAutomationPlugin;
