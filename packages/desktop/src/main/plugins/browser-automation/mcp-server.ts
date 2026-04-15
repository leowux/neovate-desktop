import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { BrowserCdpService } from "./browser-cdp-service";

export const BROWSER_MCP_SERVER_VERSION = "3.0.0";

export const BROWSER_MCP_TOOL_NAMES = [
  "browser_open",
  "browser_back",
  "browser_forward",
  "browser_reload",
  "browser_snapshot",
  "browser_find",
  "browser_click",
  "browser_dblclick",
  "browser_focus",
  "browser_fill",
  "browser_type",
  "browser_press",
  "browser_key_down",
  "browser_key_up",
  "browser_hover",
  "browser_check",
  "browser_uncheck",
  "browser_select",
  "browser_scroll",
  "browser_scroll_into_view",
  "browser_drag",
  "browser_upload",
  "browser_get",
  "browser_is",
  "browser_wait",
  "browser_eval",
  "browser_screenshot",
  "browser_console",
  "browser_errors",
  "browser_highlight",
  "browser_inspect",
  "browser_tab",
  "browser_frame",
  "browser_dialog",
  "browser_set",
  "browser_cookies",
  "browser_storage",
  "browser_network",
] as const;

const BrowserFindBySchema = z.enum([
  "role",
  "text",
  "label",
  "placeholder",
  "alt",
  "title",
  "testid",
  "selector",
]);

const BrowserGetKindSchema = z.enum([
  "text",
  "html",
  "value",
  "attr",
  "title",
  "url",
  "count",
  "box",
  "styles",
]);

const BrowserIsKindSchema = z.enum(["visible", "enabled", "checked"]);
const BrowserTabActionSchema = z.enum(["list", "new", "switch", "close"]);
const BrowserDialogActionSchema = z.enum(["accept", "dismiss", "status"]);
const BrowserConsoleActionSchema = z.enum(["get", "clear"]);
const BrowserStorageActionSchema = z.enum(["get", "getAll", "set", "clear"]);
const BrowserCookieActionSchema = z.enum(["get", "set", "clear"]);
const BrowserNetworkActionSchema = z.enum(["requests", "route", "unroute"]);
const BrowserSetKindSchema = z.enum([
  "viewport",
  "device",
  "geo",
  "offline",
  "headers",
  "credentials",
  "media",
]);

export function createBrowserMcpServer(cdp: BrowserCdpService): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "browser-automation",
    version: BROWSER_MCP_SERVER_VERSION,
    tools: [
      tool(
        "browser_open",
        "Open a URL in the current browser tab. Creates a new browser tab if none is open.",
        { url: z.string() },
        async ({ url }) => ({
          content: [{ type: "text" as const, text: await cdp.open(url) }],
        }),
      ),

      tool("browser_back", "Navigate back in browser history.", {}, async () => ({
        content: [{ type: "text" as const, text: await cdp.back() }],
      })),

      tool("browser_forward", "Navigate forward in browser history.", {}, async () => ({
        content: [{ type: "text" as const, text: await cdp.forward() }],
      })),

      tool("browser_reload", "Reload the current page.", {}, async () => ({
        content: [{ type: "text" as const, text: await cdp.reload() }],
      })),

      tool(
        "browser_snapshot",
        "Capture a browser snapshot. Defaults to the full accessibility tree; set interactiveOnly=true for the compact action-planning view.",
        {
          interactiveOnly: z.boolean().optional(),
          compact: z.boolean().optional(),
          depth: z.number().int().nonnegative().optional(),
          scopeRef: z.string().optional(),
          scopeSelector: z.string().optional(),
          focused: z.boolean().optional(),
        },
        async (args) => ({
          content: [{ type: "text" as const, text: await cdp.snapshot(args) }],
        }),
      ),

      tool(
        "browser_find",
        "Resolve semantic locators into @refs. Returns matching refs and a compact preview instead of performing an action.",
        {
          by: BrowserFindBySchema,
          value: z.string(),
          name: z.string().optional(),
          exact: z.boolean().optional(),
          nth: z.number().int().nonnegative().optional(),
          all: z.boolean().optional(),
          scopeRef: z.string().optional(),
        },
        async (args) => ({
          content: [{ type: "text" as const, text: await cdp.find(args) }],
        }),
      ),

      tool(
        "browser_click",
        "Click an element by @ref. Set newTab=true to open a link in a new Neovate tab when possible.",
        { ref: z.string(), newTab: z.boolean().optional() },
        async ({ ref, newTab }) => ({
          content: [{ type: "text" as const, text: await cdp.click(ref, newTab) }],
        }),
      ),

      tool(
        "browser_dblclick",
        "Double-click an element by @ref.",
        { ref: z.string() },
        async ({ ref }) => ({
          content: [{ type: "text" as const, text: await cdp.dblclick(ref) }],
        }),
      ),

      tool("browser_focus", "Focus an element by @ref.", { ref: z.string() }, async ({ ref }) => ({
        content: [{ type: "text" as const, text: await cdp.focus(ref) }],
      })),

      tool(
        "browser_fill",
        "Clear the element and then type text into it.",
        { ref: z.string(), text: z.string() },
        async ({ ref, text }) => ({
          content: [{ type: "text" as const, text: await cdp.fill(ref, text) }],
        }),
      ),

      tool(
        "browser_type",
        "Type text into the focused element without clearing first.",
        { ref: z.string(), text: z.string() },
        async ({ ref, text }) => ({
          content: [{ type: "text" as const, text: await cdp.type(ref, text) }],
        }),
      ),

      tool(
        "browser_press",
        "Press a key or key combination, for example Enter or Control+a.",
        { keys: z.string() },
        async ({ keys }) => ({
          content: [{ type: "text" as const, text: await cdp.press(keys) }],
        }),
      ),

      tool(
        "browser_key_down",
        "Hold a key down until browser_key_up is called.",
        { key: z.string() },
        async ({ key }) => ({
          content: [{ type: "text" as const, text: await cdp.keyDown(key) }],
        }),
      ),

      tool(
        "browser_key_up",
        "Release a previously held key.",
        { key: z.string() },
        async ({ key }) => ({
          content: [{ type: "text" as const, text: await cdp.keyUp(key) }],
        }),
      ),

      tool(
        "browser_hover",
        "Hover over an element by @ref.",
        { ref: z.string() },
        async ({ ref }) => ({
          content: [{ type: "text" as const, text: await cdp.hover(ref) }],
        }),
      ),

      tool(
        "browser_check",
        "Ensure a checkbox-like control is checked.",
        { ref: z.string() },
        async ({ ref }) => ({
          content: [{ type: "text" as const, text: await cdp.check(ref) }],
        }),
      ),

      tool(
        "browser_uncheck",
        "Ensure a checkbox-like control is unchecked.",
        { ref: z.string() },
        async ({ ref }) => ({
          content: [{ type: "text" as const, text: await cdp.uncheck(ref) }],
        }),
      ),

      tool(
        "browser_select",
        "Select one or more option values in a select element.",
        { ref: z.string(), values: z.array(z.string()).min(1) },
        async ({ ref, values }) => ({
          content: [{ type: "text" as const, text: await cdp.select(ref, values) }],
        }),
      ),

      tool(
        "browser_scroll",
        "Scroll the page or a target element in pixel units. Defaults to scrolling down by 300px.",
        {
          direction: z.enum(["up", "down", "left", "right"]).optional(),
          amount: z.number().int().positive().optional(),
          ref: z.string().optional(),
        },
        async ({ direction, amount, ref }) => ({
          content: [{ type: "text" as const, text: await cdp.scroll(direction, amount, ref) }],
        }),
      ),

      tool(
        "browser_scroll_into_view",
        "Scroll an element into view by @ref.",
        { ref: z.string() },
        async ({ ref }) => ({
          content: [{ type: "text" as const, text: await cdp.scrollIntoView(ref) }],
        }),
      ),

      tool(
        "browser_drag",
        "Drag from one @ref to another.",
        { fromRef: z.string(), toRef: z.string() },
        async ({ fromRef, toRef }) => ({
          content: [{ type: "text" as const, text: await cdp.drag(fromRef, toRef) }],
        }),
      ),

      tool(
        "browser_upload",
        "Upload files into a file input by @ref.",
        { ref: z.string(), files: z.array(z.string()).min(1) },
        async ({ ref, files }) => ({
          content: [{ type: "text" as const, text: await cdp.upload(ref, files) }],
        }),
      ),

      tool(
        "browser_get",
        "Read page or element information through a single consolidated API.",
        {
          kind: BrowserGetKindSchema,
          ref: z.string().optional(),
          selector: z.string().optional(),
          name: z.string().optional(),
        },
        async (args) => ({
          content: [{ type: "text" as const, text: await cdp.get(args) }],
        }),
      ),

      tool(
        "browser_is",
        "Check whether an element is visible, enabled, or checked.",
        { kind: BrowserIsKindSchema, ref: z.string() },
        async (args) => ({
          content: [{ type: "text" as const, text: await cdp.is(args) }],
        }),
      ),

      tool(
        "browser_wait",
        "Wait for exactly one condition: ref, milliseconds, text, URL pattern, load state, or JavaScript predicate.",
        {
          ref: z.string().optional(),
          ms: z.number().int().nonnegative().optional(),
          text: z.string().optional(),
          urlPattern: z.string().optional(),
          loadState: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
          js: z.string().optional(),
        },
        async (args) => ({
          content: [{ type: "text" as const, text: await cdp.wait(args) }],
        }),
      ),

      tool(
        "browser_eval",
        "Evaluate JavaScript in the current frame context.",
        { code: z.string() },
        async ({ code }) => {
          const result = await cdp.eval(code);
          const text =
            result === undefined || result === null
              ? "(undefined)"
              : typeof result === "object"
                ? JSON.stringify(result, null, 2)
                : String(result);
          return { content: [{ type: "text" as const, text }] };
        },
      ),

      tool(
        "browser_screenshot",
        "Take a screenshot of the current page. Set fullPage=true to capture the full scrollable page.",
        { fullPage: z.boolean().optional() },
        async ({ fullPage }) => {
          const dataUrl = await cdp.screenshot(fullPage);
          const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
          return {
            content: [{ type: "image" as const, data: base64, mimeType: "image/png" }],
          };
        },
      ),

      tool(
        "browser_console",
        "Read or clear buffered console messages.",
        { action: BrowserConsoleActionSchema.optional() },
        async ({ action = "get" }) => ({
          content: [{ type: "text" as const, text: cdp.console({ action }) }],
        }),
      ),

      tool(
        "browser_errors",
        "Read or clear buffered page errors and JavaScript exceptions.",
        { action: BrowserConsoleActionSchema.optional() },
        async ({ action = "get" }) => ({
          content: [{ type: "text" as const, text: cdp.errors({ action }) }],
        }),
      ),

      tool(
        "browser_highlight",
        "Highlight an element by @ref, or clear the current highlight.",
        { ref: z.string().optional(), clear: z.boolean().optional() },
        async ({ ref, clear }) => ({
          content: [{ type: "text" as const, text: await cdp.highlight(ref, clear) }],
        }),
      ),

      tool(
        "browser_inspect",
        "Open DevTools for the current embedded browser tab.",
        {},
        async () => ({
          content: [{ type: "text" as const, text: cdp.inspect() }],
        }),
      ),

      tool(
        "browser_tab",
        "List, open, switch, or close browser tabs through one consolidated tool.",
        {
          action: BrowserTabActionSchema,
          index: z.number().int().nonnegative().optional(),
          url: z.string().optional(),
        },
        async (args) => ({
          content: [{ type: "text" as const, text: await cdp.tab(args) }],
        }),
      ),

      tool(
        "browser_frame",
        "Switch the current frame context by main target, @ref, selector, or frame name/URL match.",
        {
          target: z.literal("main").optional(),
          ref: z.string().optional(),
          selector: z.string().optional(),
          match: z.string().optional(),
        },
        async (args) => ({
          content: [{ type: "text" as const, text: await cdp.frame(args) }],
        }),
      ),

      tool(
        "browser_dialog",
        "Accept, dismiss, or inspect the current dialog state.",
        { action: BrowserDialogActionSchema, text: z.string().optional() },
        async (args) => ({
          content: [{ type: "text" as const, text: await cdp.dialog(args) }],
        }),
      ),

      tool(
        "browser_set",
        "Configure viewport, device emulation, geolocation, offline mode, HTTP headers, credentials, or media settings.",
        {
          kind: BrowserSetKindSchema,
          width: z.number().int().positive().optional(),
          height: z.number().int().positive().optional(),
          scale: z.number().positive().optional(),
          device: z.string().optional(),
          latitude: z.number().optional(),
          longitude: z.number().optional(),
          offline: z.boolean().optional(),
          headers: z.record(z.string(), z.string()).optional(),
          username: z.string().optional(),
          password: z.string().optional(),
          colorScheme: z.enum(["light", "dark"]).optional(),
          reducedMotion: z.boolean().optional(),
        },
        async (args) => ({
          content: [{ type: "text" as const, text: await cdp.set(args) }],
        }),
      ),

      tool(
        "browser_cookies",
        "Get, set, or clear cookies for the current browser session.",
        {
          action: BrowserCookieActionSchema,
          name: z.string().optional(),
          value: z.string().optional(),
          url: z.string().optional(),
          domain: z.string().optional(),
          path: z.string().optional(),
        },
        async (args) => ({
          content: [{ type: "text" as const, text: await cdp.cookies(args) }],
        }),
      ),

      tool(
        "browser_storage",
        "Read or mutate browser storage. Currently supports localStorage.",
        {
          action: BrowserStorageActionSchema,
          area: z.literal("local").optional(),
          key: z.string().optional(),
          value: z.string().optional(),
        },
        async (args) => ({
          content: [{ type: "text" as const, text: await cdp.storage(args) }],
        }),
      ),

      tool(
        "browser_network",
        "Inspect tracked requests or add/remove simple network interception rules.",
        {
          action: BrowserNetworkActionSchema,
          pattern: z.string().optional(),
          abort: z.boolean().optional(),
          body: z.string().optional(),
          status: z.number().int().positive().optional(),
          headers: z.record(z.string(), z.string()).optional(),
          filter: z.string().optional(),
        },
        async (args) => ({
          content: [{ type: "text" as const, text: await cdp.network(args) }],
        }),
      ),
    ],
  });
}
