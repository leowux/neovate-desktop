import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { BrowserIpcBridge } from "./browser-ipc-bridge";

const SEARCH_ENGINES: Record<string, string> = {
  google: "https://www.google.com/search?q=",
  bing: "https://www.bing.com/search?q=",
  duckduckgo: "https://duckduckgo.com/?q=",
};

export function createBrowserMcpServer(ipc: BrowserIpcBridge): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "browser-automation",
    version: "1.0.0",
    tools: [
      // ─── browser_state ────────────────────────────────────────────────────────
      tool(
        "browser_state",
        "Get the current browser state: URL, title, and indexed interactive elements. " +
          "Returns a numbered list like [1] <button> 'Submit'. Use element indices to click/type.",
        { screenshot: z.boolean().optional() },
        async ({ screenshot }) => {
          const result = (await ipc.call("getState", { screenshot })) as {
            text: string;
            image?: string;
          };
          const content: Array<
            { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
          > = [{ type: "text", text: result.text }];
          if (result.image) {
            const base64 = result.image.replace(/^data:image\/\w+;base64,/, "");
            content.push({ type: "image", data: base64, mimeType: "image/png" });
          }
          return { content };
        },
      ),

      // ─── browser_navigate ─────────────────────────────────────────────────────
      tool(
        "browser_navigate",
        "Navigate the browser to a URL. Returns the new page state with indexed elements.",
        { url: z.string() },
        async ({ url }) => {
          const text = (await ipc.call("navigate", { url })) as string;
          return { content: [{ type: "text" as const, text }] };
        },
      ),

      // ─── browser_search ───────────────────────────────────────────────────────
      tool(
        "browser_search",
        "Search the web using a search engine. Returns the search results page state.",
        {
          query: z.string(),
          engine: z.enum(["google", "bing", "duckduckgo"]).optional(),
        },
        async ({ query, engine = "google" }) => {
          const base = SEARCH_ENGINES[engine] ?? SEARCH_ENGINES.google;
          const url = base + encodeURIComponent(query);
          const text = (await ipc.call("navigate", { url })) as string;
          return { content: [{ type: "text" as const, text }] };
        },
      ),

      // ─── browser_click ────────────────────────────────────────────────────────
      tool(
        "browser_click",
        "Click an element by its index (from browser_state), or click at pixel coordinates (x, y). Returns updated page state.",
        {
          index: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Element index from browser_state"),
          x: z.number().optional().describe("X pixel coordinate (use with y instead of index)"),
          y: z.number().optional().describe("Y pixel coordinate (use with x instead of index)"),
        },
        async ({ index, x, y }) => {
          const text = (await ipc.call("click", { index, x, y })) as string;
          return { content: [{ type: "text" as const, text }] };
        },
      ),

      // ─── browser_input ────────────────────────────────────────────────────────
      tool(
        "browser_input",
        "Type text into an input element by its index. Set clear=true to clear existing content first.",
        {
          index: z.number().int().positive(),
          text: z.string(),
          clear: z.boolean().optional(),
        },
        async ({ index, text, clear }) => {
          const result = (await ipc.call("input", { index, text, clear })) as string;
          return { content: [{ type: "text" as const, text: result }] };
        },
      ),

      // ─── browser_scroll ───────────────────────────────────────────────────────
      tool(
        "browser_scroll",
        "Scroll the page or a specific element. Amount is in viewport pages (default 1).",
        {
          direction: z.enum(["up", "down", "left", "right"]),
          amount: z.number().positive().optional(),
          target: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Element index to scroll within (scrolls the page if omitted)"),
        },
        async ({ direction, amount, target }) => {
          const text = (await ipc.call("scroll", { direction, amount, target })) as string;
          return { content: [{ type: "text" as const, text }] };
        },
      ),

      // ─── browser_screenshot ───────────────────────────────────────────────────
      tool(
        "browser_screenshot",
        "Take a screenshot of the current browser view. Set fullPage=true to capture the entire scrollable page.",
        { fullPage: z.boolean().optional() },
        async ({ fullPage }) => {
          const dataUrl = (await ipc.call("screenshot", { fullPage })) as string;
          const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
          return {
            content: [{ type: "image" as const, data: base64, mimeType: "image/png" }],
          };
        },
      ),

      // ─── browser_go_back ──────────────────────────────────────────────────────
      tool(
        "browser_go_back",
        "Navigate back in the browser history. Returns updated page state.",
        {},
        async () => {
          const text = (await ipc.call("goBack", {})) as string;
          return { content: [{ type: "text" as const, text }] };
        },
      ),

      // ─── browser_wait ─────────────────────────────────────────────────────────
      tool(
        "browser_wait",
        "Wait for a condition: a CSS selector to appear, text to appear, or a fixed number of seconds (default 3, max 10).",
        {
          seconds: z.number().positive().max(10).optional().describe("Fixed wait in seconds"),
          selector: z.string().optional().describe("CSS selector to wait for"),
          text: z.string().optional().describe("Text content to wait for on the page"),
          timeout: z
            .number()
            .positive()
            .max(10000)
            .optional()
            .describe("Timeout in ms for selector/text wait (default 5000)"),
        },
        async ({ seconds, selector, text, timeout }) => {
          const result = (await ipc.call("wait", { seconds, selector, text, timeout })) as string;
          return { content: [{ type: "text" as const, text: result }] };
        },
      ),

      // ─── browser_evaluate ─────────────────────────────────────────────────────
      tool(
        "browser_evaluate",
        "Execute arbitrary JavaScript in the browser page context. Returns the result.",
        { code: z.string() },
        async ({ code }) => {
          const result = await ipc.call("evaluate", { code });
          const text =
            result === undefined || result === null
              ? "(undefined)"
              : typeof result === "object"
                ? JSON.stringify(result, null, 2)
                : String(result);
          return { content: [{ type: "text" as const, text }] };
        },
      ),

      // ─── browser_send_keys ────────────────────────────────────────────────────
      tool(
        "browser_send_keys",
        "Send keyboard keys to the focused element. Supports single keys (Enter, Tab, Escape, Backspace, ArrowUp/Down/Left/Right, Space) and modifier combos (Control+a, Shift+Enter, Alt+Tab). Use Mod+key for platform-adaptive modifier (Cmd on macOS, Ctrl elsewhere).",
        { keys: z.string() },
        async ({ keys }) => {
          const text = (await ipc.call("sendKeys", { keys })) as string;
          return { content: [{ type: "text" as const, text }] };
        },
      ),

      // ─── browser_console_logs ─────────────────────────────────────────────────
      tool(
        "browser_console_logs",
        "Get buffered console logs from the browser page. Set clear=true to clear the buffer after reading.",
        { clear: z.boolean().optional() },
        async ({ clear }) => {
          const logs = (await ipc.call("getConsoleLogs", { clear })) as Array<{
            level: number;
            message: string;
            ts: number;
          }>;
          if (logs.length === 0) {
            return { content: [{ type: "text" as const, text: "(no console logs)" }] };
          }
          const LEVEL_NAMES: Record<number, string> = {
            0: "LOG",
            1: "WARN",
            2: "ERROR",
            3: "DEBUG",
          };
          const formatted = logs
            .map((l) => {
              const ts = new Date(l.ts).toISOString().substring(11, 23);
              const level = LEVEL_NAMES[l.level] ?? "LOG";
              return `[${ts}] [${level}] ${l.message}`;
            })
            .join("\n");
          return { content: [{ type: "text" as const, text: formatted }] };
        },
      ),

      // ─── browser_hover ────────────────────────────────────────────────────────
      tool(
        "browser_hover",
        "Hover over an element by its index (from browser_state). Useful for triggering tooltips, dropdowns, or hover menus.",
        { index: z.number().int().positive() },
        async ({ index }) => {
          const text = (await ipc.call("hover", { index })) as string;
          return { content: [{ type: "text" as const, text }] };
        },
      ),

      // ─── browser_dblclick ─────────────────────────────────────────────────────
      tool(
        "browser_dblclick",
        "Double-click an element by its index (from browser_state). Useful for selecting text or entering edit mode.",
        { index: z.number().int().positive() },
        async ({ index }) => {
          const text = (await ipc.call("dblclick", { index })) as string;
          return { content: [{ type: "text" as const, text }] };
        },
      ),

      // ─── browser_select ───────────────────────────────────────────────────────
      tool(
        "browser_select",
        "Select an option from a <select> dropdown by its index (from browser_state). Provide option value or visible label.",
        {
          index: z.number().int().positive().describe("Index of the <select> element"),
          value: z.string().optional().describe("Option value attribute to select"),
          label: z.string().optional().describe("Visible option text to select"),
        },
        async ({ index, value, label }) => {
          const text = (await ipc.call("select", { index, value, label })) as string;
          return { content: [{ type: "text" as const, text }] };
        },
      ),

      // ─── browser_get_text ─────────────────────────────────────────────────────
      tool(
        "browser_get_text",
        "Get the text content of an element by its index (from browser_state) or a CSS selector.",
        {
          index: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Element index from browser_state"),
          selector: z.string().optional().describe("CSS selector to query"),
        },
        async ({ index, selector }) => {
          const text = (await ipc.call("getText", { index, selector })) as string;
          return { content: [{ type: "text" as const, text }] };
        },
      ),

      // ─── browser_get_html ─────────────────────────────────────────────────────
      tool(
        "browser_get_html",
        "Get the HTML of the page or a specific element. Returns outerHTML by default, set inner=true for innerHTML.",
        {
          selector: z
            .string()
            .optional()
            .describe("CSS selector (returns full page HTML if omitted)"),
          inner: z.boolean().optional().describe("Return innerHTML instead of outerHTML"),
        },
        async ({ selector, inner }) => {
          const text = (await ipc.call("getHtml", { selector, inner })) as string;
          return { content: [{ type: "text" as const, text }] };
        },
      ),

      // ─── browser_get_attribute ────────────────────────────────────────────────
      tool(
        "browser_get_attribute",
        "Get the value of a specific attribute on an element by its index (from browser_state).",
        {
          index: z.number().int().positive(),
          name: z.string().describe("Attribute name (e.g. 'href', 'src', 'class')"),
        },
        async ({ index, name }) => {
          const text = (await ipc.call("getAttribute", { index, name })) as string;
          return { content: [{ type: "text" as const, text }] };
        },
      ),

      // ─── browser_tab_list ─────────────────────────────────────────────────────
      tool(
        "browser_tab_list",
        "List all open browser tabs with their index, URL, and title.",
        {},
        async () => {
          const text = (await ipc.call("tabList", {})) as string;
          return { content: [{ type: "text" as const, text }] };
        },
      ),

      // ─── browser_tab_new ──────────────────────────────────────────────────────
      tool(
        "browser_tab_new",
        "Open a new browser tab. Optionally navigate to a URL.",
        { url: z.string().optional() },
        async ({ url }) => {
          const text = (await ipc.call("tabNew", { url })) as string;
          return { content: [{ type: "text" as const, text }] };
        },
      ),

      // ─── browser_tab_switch ───────────────────────────────────────────────────
      tool(
        "browser_tab_switch",
        "Switch to a different browser tab by its tab index (from browser_tab_list).",
        { index: z.number().int().nonnegative() },
        async ({ index }) => {
          const text = (await ipc.call("tabSwitch", { index })) as string;
          return { content: [{ type: "text" as const, text }] };
        },
      ),

      // ─── browser_tab_close ────────────────────────────────────────────────────
      tool(
        "browser_tab_close",
        "Close a browser tab by its tab index (from browser_tab_list). Closes the active tab if no index given.",
        { index: z.number().int().nonnegative().optional() },
        async ({ index }) => {
          const text = (await ipc.call("tabClose", { index })) as string;
          return { content: [{ type: "text" as const, text }] };
        },
      ),
    ],
  });
}
