import { describe, expect, it } from "vitest";

import type {
  AXNode,
  EnsureRefFn,
} from "../../src/main/plugins/browser-automation/browser-cdp-service";

import {
  axNodeMatchesQuery,
  buildFindQuery,
  collectDescendantNodeIds,
  collectFullSnapshotLines,
  collectInteractiveSnapshotLines,
  findScopedNodes,
  formatSnapshotLine,
} from "../../src/main/plugins/browser-automation/browser-cdp-service";
import { SAMPLE_AX_TREE } from "./fixtures/browser-fixtures";

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Build a nodeMap from a flat list of AXNodes (keyed by nodeId). */
function buildNodeMap(nodes: AXNode[]): Map<string, AXNode> {
  return new Map(nodes.map((n) => [n.nodeId, n]));
}

/** A no-op ensureRef that assigns sequential eN refs. */
const ensureRef: EnsureRefFn = (_viewId, backendNodeId, _entry) => {
  return `e${backendNodeId}`;
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ax-helpers: formatSnapshotLine", () => {
  it("formats a node with role and name", () => {
    const node: AXNode = {
      nodeId: "a",
      role: { value: "button" },
      name: { value: "Submit" },
      backendDOMNodeId: 10,
    };
    expect(formatSnapshotLine(node, "e10", false, 0, false)).toBe('@e10 [button] "Submit"');
  });

  it("indents by depth", () => {
    const node: AXNode = {
      nodeId: "a",
      role: { value: "textbox" },
      name: { value: "Email" },
      backendDOMNodeId: 20,
    };
    expect(formatSnapshotLine(node, "e20", false, 2, false)).toBe('    @e20 [textbox] "Email"');
  });

  it("includes value in non-compact mode", () => {
    const node: AXNode = {
      nodeId: "a",
      role: { value: "textbox" },
      name: { value: "Email" },
      value: { value: "typed text" },
      backendDOMNodeId: 30,
    };
    expect(formatSnapshotLine(node, "e30", false, 0, false)).toBe(
      '@e30 [textbox] "Email" value="typed text"',
    );
  });

  it("omits value in compact mode", () => {
    const node: AXNode = {
      nodeId: "a",
      role: { value: "textbox" },
      name: { value: "Email" },
      value: { value: "typed text" },
      backendDOMNodeId: 30,
    };
    expect(formatSnapshotLine(node, "e30", true, 0, false)).toBe('@e30 [textbox] "Email"');
  });

  it("shows disabled and focused markers", () => {
    const node: AXNode = {
      nodeId: "a",
      role: { value: "button" },
      name: { value: "Submit" },
      disabled: true,
      focused: true,
      backendDOMNodeId: 40,
    };
    expect(formatSnapshotLine(node, "e40", false, 0, true)).toBe(
      '@e40 [button] "Submit" (disabled) (focused)',
    );
  });

  it("handles node with no ref", () => {
    const node: AXNode = {
      nodeId: "a",
      role: { value: "generic" },
    };
    expect(formatSnapshotLine(node, undefined, false, 0, false)).toBe("[generic]");
  });
});

describe("ax-helpers: findScopedNodes", () => {
  it("finds a node by backendDOMNodeId", () => {
    const nodes = [...SAMPLE_AX_TREE] as AXNode[];
    // 100 is the RootWebArea
    const found = findScopedNodes(nodes, 100);
    expect(found).toHaveLength(1);
    expect(found[0].role?.value).toBe("RootWebArea");
  });

  it("returns empty array when not found", () => {
    const nodes = [...SAMPLE_AX_TREE] as AXNode[];
    expect(findScopedNodes(nodes, 99999)).toHaveLength(0);
  });
});

describe("ax-helpers: collectInteractiveSnapshotLines", () => {
  it("collects only interactive roles", () => {
    const nodes = [...SAMPLE_AX_TREE] as AXNode[];
    const nodeMap = buildNodeMap(nodes);
    const lines: string[] = [];
    const root = nodes[0];

    collectInteractiveSnapshotLines(lines, root, nodeMap, ensureRef, "v1", false, undefined, 0);

    // RootWebArea not interactive, heading not interactive, Iframe not interactive
    // Only textbox + button are collected
    expect(lines).toContain('@e120 [textbox] "Email" value="user@example.com"');
    expect(lines).toContain('@e130 [button] "Submit order"');
    expect(lines.some((l) => l.includes("heading"))).toBe(false);
    expect(lines.some((l) => l.includes("Iframe"))).toBe(false);
  });

  it("respects depth limit", () => {
    const nodes = [...SAMPLE_AX_TREE] as AXNode[];
    const nodeMap = buildNodeMap(nodes);
    const lines: string[] = [];
    const root = nodes[0];

    // depth=0 → only root level (but RootWebArea is depth 0, children are depth 1)
    // With interactive-only, root is not interactive, so at depth 0 nothing is collected
    collectInteractiveSnapshotLines(lines, root, nodeMap, ensureRef, "v1", false, 0, 0);
    expect(lines).toHaveLength(0);
  });

  it("produces compact output", () => {
    const nodes = [...SAMPLE_AX_TREE] as AXNode[];
    const nodeMap = buildNodeMap(nodes);
    const lines: string[] = [];
    const root = nodes[0];

    collectInteractiveSnapshotLines(lines, root, nodeMap, ensureRef, "v1", true, undefined, 0);

    // Compact mode: no value shown
    expect(lines).toContain('@e120 [textbox] "Email"');
    expect(lines).not.toContainEqual(expect.stringContaining("value="));
  });
});

describe("ax-helpers: collectFullSnapshotLines", () => {
  it("collects all nodes with indentation", () => {
    const nodes = [...SAMPLE_AX_TREE] as AXNode[];
    const nodeMap = buildNodeMap(nodes);
    const lines: string[] = [];
    const root = nodes[0];

    collectFullSnapshotLines(lines, root, nodeMap, ensureRef, "v1", false, undefined, 0, false);

    expect(lines[0]).toBe('@e100 [RootWebArea] "Checkout"');
    expect(lines[1]).toBe('  @e110 [heading] "Checkout form"');
    expect(lines[2]).toBe('  @e120 [textbox] "Email" value="user@example.com"');
    expect(lines[3]).toBe('  @e130 [button] "Submit order"');
    expect(lines[4]).toBe('  @e140 [Iframe] "payment-frame"');
    expect(lines[5]).toBe('    @e210 [textbox] "Card number"');
    expect(lines[6]).toBe('    @e220 [button] "Pay"');
  });

  it("marks focused nodes when focused=true", () => {
    const nodes = [...SAMPLE_AX_TREE] as AXNode[];
    const nodeMap = buildNodeMap(nodes);
    const lines: string[] = [];
    const root = nodes[0];

    collectFullSnapshotLines(lines, root, nodeMap, ensureRef, "v1", false, undefined, 0, true);

    // email and card are focused in SAMPLE_AX_TREE
    expect(lines.some((l) => l.includes("(focused)"))).toBe(true);
  });

  it("respects depth limit", () => {
    const nodes = [...SAMPLE_AX_TREE] as AXNode[];
    const nodeMap = buildNodeMap(nodes);
    const lines: string[] = [];
    const root = nodes[0];

    // depth=1 → root (0) + direct children (1)
    collectFullSnapshotLines(lines, root, nodeMap, ensureRef, "v1", false, 1, 0, false);

    expect(lines).toContain('@e100 [RootWebArea] "Checkout"');
    expect(lines).toContain('  @e110 [heading] "Checkout form"');
    // iframe's children should NOT appear
    expect(lines.some((l) => l.includes("Card number"))).toBe(false);
  });
});

describe("ax-helpers: buildFindQuery", () => {
  it("builds a selector query", () => {
    const q = buildFindQuery("selector", "#foo", undefined, false);
    expect(q).toContain("querySelectorAll");
    expect(q).toContain('"#foo"');
  });

  it("builds a role query with name filter", () => {
    const q = buildFindQuery("role", "button", "Submit", true);
    expect(q).toContain('"button"');
    expect(q).toContain('"Submit"');
    expect(q).toContain("true"); // exact
  });

  it("builds a text query", () => {
    const q = buildFindQuery("text", "hello", undefined, false);
    expect(q).toContain('"hello"');
    expect(q).toContain("__nvText");
  });

  it("builds a label query", () => {
    const q = buildFindQuery("label", "Email", undefined, true);
    expect(q).toContain('"Email"');
    expect(q).toContain("__nvLabel");
  });

  it("builds a placeholder query", () => {
    const q = buildFindQuery("placeholder", "Enter...", undefined, false);
    expect(q).toContain("[placeholder]");
  });

  it("builds an alt query", () => {
    const q = buildFindQuery("alt", "Logo", undefined, false);
    expect(q).toContain("[alt]");
  });

  it("builds a title query", () => {
    const q = buildFindQuery("title", "Tooltip", undefined, false);
    expect(q).toContain("[title]");
  });

  it("builds a testid query", () => {
    const q = buildFindQuery("testid", "login-btn", undefined, false);
    expect(q).toContain("[data-testid]");
  });
});

describe("ax-helpers: axNodeMatchesQuery", () => {
  const buttonNode: AXNode = {
    nodeId: "btn",
    role: { value: "button" },
    name: { value: "Submit" },
    backendDOMNodeId: 10,
  };

  const textboxNode: AXNode = {
    nodeId: "tb",
    role: { value: "textbox" },
    name: { value: "Email" },
    value: { value: "user@example.com" },
    description: { value: "Enter your email" },
    backendDOMNodeId: 20,
  };

  const headingNode: AXNode = {
    nodeId: "h",
    role: { value: "heading" },
    name: { value: "Welcome" },
    backendDOMNodeId: 30,
  };

  it("matches by role (exact)", () => {
    expect(axNodeMatchesQuery(buttonNode, "role", "button", "", true)).toBe(true);
    expect(axNodeMatchesQuery(buttonNode, "role", "link", "", true)).toBe(false);
  });

  it("matches by role with name filter", () => {
    expect(axNodeMatchesQuery(buttonNode, "role", "button", "Submit", true)).toBe(true);
    expect(axNodeMatchesQuery(buttonNode, "role", "button", "Cancel", true)).toBe(false);
  });

  it("matches by role case-insensitively", () => {
    expect(axNodeMatchesQuery(buttonNode, "role", "Button", "", false)).toBe(true);
  });

  it("matches by text (name or value)", () => {
    expect(axNodeMatchesQuery(textboxNode, "text", "Email", "", false)).toBe(true);
    expect(axNodeMatchesQuery(textboxNode, "text", "user@example.com", "", false)).toBe(true);
    expect(axNodeMatchesQuery(textboxNode, "text", "nonexistent", "", true)).toBe(false);
  });

  it("matches by label only for interactive elements", () => {
    expect(axNodeMatchesQuery(textboxNode, "label", "Email", "", false)).toBe(true);
    expect(axNodeMatchesQuery(headingNode, "label", "Welcome", "", false)).toBe(false);
  });

  it("matches by placeholder only for interactive elements", () => {
    expect(axNodeMatchesQuery(textboxNode, "placeholder", "Enter your email", "", false)).toBe(
      true,
    );
    expect(axNodeMatchesQuery(headingNode, "placeholder", "Welcome", "", false)).toBe(false);
  });

  it("matches by alt for images and interactive elements", () => {
    const imgNode: AXNode = {
      nodeId: "img",
      role: { value: "img" },
      name: { value: "Logo" },
      backendDOMNodeId: 40,
    };
    expect(axNodeMatchesQuery(imgNode, "alt", "Logo", "", false)).toBe(true);
    expect(axNodeMatchesQuery(buttonNode, "alt", "Submit", "", false)).toBe(true);
    expect(axNodeMatchesQuery(headingNode, "alt", "Welcome", "", false)).toBe(false);
  });

  it("matches by title on any element", () => {
    expect(axNodeMatchesQuery(headingNode, "title", "Welcome", "", false)).toBe(true);
    expect(axNodeMatchesQuery(buttonNode, "title", "Submit", "", false)).toBe(true);
  });

  it("never matches by testid or selector (not available in AX tree)", () => {
    expect(axNodeMatchesQuery(buttonNode, "testid", "anything", "", false)).toBe(false);
    expect(axNodeMatchesQuery(buttonNode, "selector", "#btn", "", false)).toBe(false);
  });
});

describe("ax-helpers: collectDescendantNodeIds", () => {
  it("collects all descendant node IDs", () => {
    const nodes = [...SAMPLE_AX_TREE] as AXNode[];
    const root = nodes[0];
    const ids = collectDescendantNodeIds(root, nodes);

    // Root has 4 children: heading, email, submit, iframe
    // iframe has 2 children: card, pay
    expect(ids.has("heading")).toBe(true);
    expect(ids.has("email")).toBe(true);
    expect(ids.has("submit")).toBe(true);
    expect(ids.has("iframe")).toBe(true);
    expect(ids.has("card")).toBe(true);
    expect(ids.has("pay")).toBe(true);
    // root itself is NOT a descendant
    expect(ids.has("root")).toBe(false);
  });

  it("returns empty set for a leaf node", () => {
    const leaf: AXNode = { nodeId: "leaf" };
    const ids = collectDescendantNodeIds(leaf, [leaf]);
    expect(ids.size).toBe(0);
  });
});
