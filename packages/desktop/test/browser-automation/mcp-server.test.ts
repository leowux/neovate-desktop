import { describe, expect, it } from "vitest";

import {
  BROWSER_MCP_SERVER_VERSION,
  BROWSER_MCP_TOOL_NAMES,
  createBrowserMcpServer,
} from "../../src/main/plugins/browser-automation/mcp-server";

describe("browser automation MCP metadata", () => {
  it("exports the redesigned tool surface", () => {
    expect(BROWSER_MCP_SERVER_VERSION).toBe("3.0.0");

    expect(BROWSER_MCP_TOOL_NAMES).toContain("browser_open");
    expect(BROWSER_MCP_TOOL_NAMES).toContain("browser_snapshot");
    expect(BROWSER_MCP_TOOL_NAMES).toContain("browser_find");
    expect(BROWSER_MCP_TOOL_NAMES).toContain("browser_tab");
    expect(BROWSER_MCP_TOOL_NAMES).toContain("browser_network");

    expect(BROWSER_MCP_TOOL_NAMES).not.toContain("browser_state");
    expect(BROWSER_MCP_TOOL_NAMES).not.toContain("browser_navigate");
    expect(BROWSER_MCP_TOOL_NAMES).not.toContain("browser_input");
    expect(BROWSER_MCP_TOOL_NAMES).not.toContain("browser_go_back");
    expect(BROWSER_MCP_TOOL_NAMES).not.toContain("browser_tab_list");
    expect(BROWSER_MCP_TOOL_NAMES).not.toContain("browser_tab_new");
  });

  it("creates a fresh MCP SDK server config on each call", () => {
    const fakeCdp = {} as never;

    const serverA = createBrowserMcpServer(fakeCdp);
    const serverB = createBrowserMcpServer(fakeCdp);

    expect(serverA.type).toBe("sdk");
    expect(serverA.name).toBe("browser-automation");
    expect(serverA.instance).toBeTruthy();
    expect(serverB.instance).toBeTruthy();
    expect(serverA.instance).not.toBe(serverB.instance);
  });
});
