import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";

import type { MainPlugin, PluginContext } from "../../core/plugin/types";

import { BrowserIpcBridge } from "./browser-ipc-bridge";
import { createBrowserMcpServer } from "./mcp-server";

let bridge: BrowserIpcBridge | null = null;

/**
 * Create a fresh McpSdkServerConfigWithInstance for each session.
 * McpServer instances from @modelcontextprotocol/sdk support only one connection
 * lifetime — reusing the same instance after a session ends causes the next session
 * to see no browser tools. A fresh instance must be created per session.
 */
export function createFreshBrowserMcpServer(): McpSdkServerConfigWithInstance | null {
  if (!bridge) return null;
  return createBrowserMcpServer(bridge);
}

const browserAutomationPlugin: MainPlugin = {
  name: "browser-automation",

  configContributions(ctx: PluginContext) {
    bridge = new BrowserIpcBridge(ctx.app.windowManager);
    return {};
  },

  activate(_ctx: PluginContext) {
    bridge?.attach();
  },

  deactivate() {
    bridge?.dispose();
    bridge = null;
  },
};

export default browserAutomationPlugin;
