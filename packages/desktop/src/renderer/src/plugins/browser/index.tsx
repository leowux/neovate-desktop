import { Globe } from "lucide-react";

import type { RendererPlugin } from "../../core/plugin";
import type { PluginContext } from "../../core/plugin/types";

const NAME = "plugin-browser";

/** Localhost variants opened in built-in browser by default (matches VS Code simple-browser) */
const DEFAULT_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "0.0.0.0",
  "[0:0:0:0:0:0:0:0]",
  "[::]",
]);

interface BrowserPluginOptions {
  /**
   * Additional hostnames to open in the built-in browser (exact match).
   * Merged with DEFAULT_HOSTS (localhost variants).
   *
   * @example
   * browserPlugin({ includeHosts: ["docs.example.com", "preview.dev"] })
   */
  includeHosts?: string[];
}

export default function browserPlugin(options?: BrowserPluginOptions): RendererPlugin {
  const enabledHosts = new Set([...DEFAULT_HOSTS, ...(options?.includeHosts ?? [])]);
  let cleanupBrowserTabCommands: (() => void) | null = null;

  return {
    name: NAME,

    configI18n() {
      return {
        namespace: NAME,
        loader: async (locale) => {
          try {
            return (await import(`./locales/${locale}.json`)).default;
          } catch {
            return (await import("./locales/en-US.json")).default;
          }
        },
      };
    },

    configViewContributions() {
      return {
        contentPanelViews: [
          {
            viewType: "browser",
            name: { "en-US": "Browser", "zh-CN": "浏览器" },
            singleton: false,
            deactivation: "offscreen",
            icon: ({ className }: { className?: string }) => <Globe className={className} />,
            component: () => import("./browser-view"),
          },
        ],
      };
    },

    activate(ctx: PluginContext) {
      cleanupBrowserTabCommands?.();
      cleanupBrowserTabCommands =
        window.api?.onBrowserTabCommand?.((cmd) => {
          const contentPanel = ctx.app.workbench.contentPanel;

          if (cmd.method === "tabNew") {
            const payload =
              cmd.args && typeof cmd.args === "object"
                ? (cmd.args as { url?: unknown })
                : undefined;
            const url = typeof payload?.url === "string" ? payload.url : undefined;
            const state = url ? { url } : undefined;
            contentPanel.openView("browser", state ? { state } : undefined);
            return;
          }

          if (
            cmd.args &&
            typeof cmd.args === "object" &&
            "viewId" in cmd.args &&
            typeof cmd.args.viewId === "string"
          ) {
            if (cmd.method === "tabSwitch") {
              contentPanel.activateView(cmd.args.viewId);
              return;
            }

            if (cmd.method === "tabClose") {
              contentPanel.closeView(cmd.args.viewId);
            }
          }
        }) ?? null;
    },

    deactivate() {
      cleanupBrowserTabCommands?.();
      cleanupBrowserTabCommands = null;
    },

    configContributions(ctx: PluginContext) {
      return {
        externalUriOpeners: [
          {
            id: "browser.preview",
            opener: {
              async canOpenExternalUri(uri: URL) {
                return enabledHosts.has(uri.hostname);
              },
              async openExternalUri(resolvedUri: URL) {
                ctx.app.workbench.contentPanel.openView("browser", {
                  state: { url: resolvedUri.toString() },
                });
                return true;
              },
            },
            metadata: {
              schemes: ["http", "https"],
              label: "Open in browser preview",
            },
          },
        ],
      };
    },
  };
}
