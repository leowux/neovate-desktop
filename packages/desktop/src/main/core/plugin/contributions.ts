import type {
  HookCallbackMatcher,
  HookEvent,
  McpServerConfig,
  Options,
} from "@anthropic-ai/claude-agent-sdk";
import type { AnyRouter } from "@orpc/server";

import type { DeeplinkHandler } from "../deeplink/types";
import type { Contribution } from "./contribution";

export interface AgentContributions {
  claudeCode?: ClaudeCodeContributions;
}

export interface ClaudeCodeContributions {
  options?: Pick<Options, "hooks">;
}

export type Contributions = {
  routers: Contribution<AnyRouter>[];
  agents: Contribution<AgentContributions>[];
  deeplinkHandlers: Contribution<DeeplinkHandler>[];
  mcpServers: Contribution<Record<string, McpServerConfig>>[];
};

/** Merge MCP server contributions from all plugins into a single Record. */
export function mergeMcpServers(
  servers: Contribution<Record<string, McpServerConfig>>[],
): Record<string, McpServerConfig> {
  const merged: Record<string, McpServerConfig> = {};
  for (const { value } of servers) {
    Object.assign(merged, value);
  }
  return merged;
}

/** Merge agent hook contributions into a single SDK-compatible hooks record. */
export function mergeAgentHooks(
  agents: Contribution<AgentContributions>[],
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const merged: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  for (const { value } of agents) {
    const hooks = value.claudeCode?.options?.hooks;
    if (!hooks) continue;
    for (const [event, matchers] of Object.entries(hooks)) {
      if (!matchers) continue;
      (merged[event as HookEvent] ??= []).push(...matchers);
    }
  }
  return merged;
}
