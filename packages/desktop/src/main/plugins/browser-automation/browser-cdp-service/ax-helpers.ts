import type { AXNode, BrowserFindBy } from "./types";

import { INTERACTIVE_ROLES } from "./constants";
import { formatBrowserRef } from "./utils";

export type EnsureRefFn = (
  viewId: string,
  backendNodeId: number,
  entry: { role: string; name: string; value?: string; description?: string; disabled: boolean },
) => string;

export function formatSnapshotLine(
  node: AXNode,
  ref: string | undefined,
  compact: boolean,
  depth: number,
  focused: boolean,
): string {
  const prefix = "  ".repeat(depth);
  const pieces: string[] = [];
  if (ref) pieces.push(formatBrowserRef(ref));
  pieces.push(`[${node.role?.value ?? "unknown"}]`);
  const name = node.name?.value?.trim();
  if (name) pieces.push(JSON.stringify(name));
  if (!compact && node.value?.value !== undefined) {
    pieces.push(`value=${JSON.stringify(String(node.value.value))}`);
  }
  if (!compact && node.disabled) pieces.push("(disabled)");
  if (!compact && focused && node.focused) pieces.push("(focused)");
  return `${prefix}${pieces.join(" ")}`.trimEnd();
}

export function findScopedNodes(nodes: AXNode[], backendNodeId: number): AXNode[] {
  const node = nodes.find((candidate) => candidate.backendDOMNodeId === backendNodeId);
  return node ? [node] : [];
}

export function collectInteractiveSnapshotLines(
  lines: string[],
  node: AXNode,
  nodeMap: Map<string, AXNode>,
  ensureRef: EnsureRefFn,
  viewId: string,
  compact: boolean,
  depth: number | undefined,
  currentDepth: number,
): void {
  if (depth !== undefined && currentDepth > depth) return;
  if (
    !node.ignored &&
    node.role?.value &&
    INTERACTIVE_ROLES.has(node.role.value) &&
    node.backendDOMNodeId
  ) {
    const ref = ensureRef(viewId, node.backendDOMNodeId, {
      role: node.role.value,
      name: node.name?.value ?? "",
      value: node.value?.value,
      description: node.description?.value,
      disabled: node.disabled === true,
    });
    lines.push(formatSnapshotLine(node, ref, compact, 0, false));
  }
  for (const childId of node.childIds ?? []) {
    const child = nodeMap.get(childId);
    if (child) {
      collectInteractiveSnapshotLines(
        lines,
        child,
        nodeMap,
        ensureRef,
        viewId,
        compact,
        depth,
        currentDepth + 1,
      );
    }
  }
}

export function collectFullSnapshotLines(
  lines: string[],
  node: AXNode,
  nodeMap: Map<string, AXNode>,
  ensureRef: EnsureRefFn,
  viewId: string,
  compact: boolean,
  depth: number | undefined,
  currentDepth: number,
  focused: boolean,
): void {
  if (depth !== undefined && currentDepth > depth) return;
  const childDepth = node.ignored ? currentDepth : currentDepth + 1;
  if (!node.ignored) {
    const ref = node.backendDOMNodeId
      ? ensureRef(viewId, node.backendDOMNodeId, {
          role: node.role?.value ?? "",
          name: node.name?.value ?? "",
          value: node.value?.value,
          description: node.description?.value,
          disabled: node.disabled === true,
        })
      : undefined;
    lines.push(formatSnapshotLine(node, ref, compact, currentDepth, focused));
  }
  // Always traverse children — ignored nodes are structural/presentation
  // wrappers, not visual leaves, so their descendants must not be pruned.
  for (const childId of node.childIds ?? []) {
    const child = nodeMap.get(childId);
    if (child) {
      collectFullSnapshotLines(
        lines,
        child,
        nodeMap,
        ensureRef,
        viewId,
        compact,
        depth,
        childDepth,
        focused,
      );
    }
  }
}

export function buildFindQuery(
  by: BrowserFindBy,
  value: string,
  name: string | undefined,
  exact: boolean,
): string {
  switch (by) {
    case "selector":
      return `return Array.from(root.querySelectorAll(${JSON.stringify(value)}));`;
    case "role":
      return `
        const wantedRole = ${JSON.stringify(value.toLowerCase())};
        const wantedName = ${JSON.stringify(name ?? "")};
        return Array.from(root.querySelectorAll("*")).filter((el) => {
          if (__nvRole(el) !== wantedRole) return false;
          return __nvMatch(__nvName(el), wantedName, ${JSON.stringify(exact)});
        });
      `;
    case "text":
      return `
        const wantedText = ${JSON.stringify(value)};
        return Array.from(root.querySelectorAll("*")).filter((el) =>
          __nvMatch(__nvText(el), wantedText, ${JSON.stringify(exact)}) ||
          __nvMatch(__nvName(el), wantedText, ${JSON.stringify(exact)})
        );
      `;
    case "label":
      return `
        const wantedLabel = ${JSON.stringify(value)};
        return Array.from(root.querySelectorAll("*")).filter((el) =>
          __nvMatch(__nvLabel(el), wantedLabel, ${JSON.stringify(exact)})
        );
      `;
    case "placeholder":
      return `
        const wanted = ${JSON.stringify(value)};
        return Array.from(root.querySelectorAll("[placeholder]")).filter((el) =>
          __nvMatch(el.getAttribute("placeholder"), wanted, ${JSON.stringify(exact)})
        );
      `;
    case "alt":
      return `
        const wanted = ${JSON.stringify(value)};
        return Array.from(root.querySelectorAll("[alt]")).filter((el) =>
          __nvMatch(el.getAttribute("alt"), wanted, ${JSON.stringify(exact)})
        );
      `;
    case "title":
      return `
        const wanted = ${JSON.stringify(value)};
        return Array.from(root.querySelectorAll("[title]")).filter((el) =>
          __nvMatch(el.getAttribute("title"), wanted, ${JSON.stringify(exact)})
        );
      `;
    case "testid":
      return `
        const wanted = ${JSON.stringify(value)};
        return Array.from(root.querySelectorAll("[data-testid]")).filter((el) =>
          __nvMatch(el.getAttribute("data-testid"), wanted, ${JSON.stringify(exact)})
        );
      `;
  }
}

export function axNodeMatchesQuery(
  node: AXNode,
  by: BrowserFindBy,
  value: string,
  name: string,
  exact: boolean,
): boolean {
  const nodeRole = node.role?.value?.toLowerCase() ?? "";
  const nodeName = node.name?.value ?? "";
  const nodeValue = node.value?.value ?? "";
  const nodeDescription = node.description?.value ?? "";

  const match = (candidate: string, expected: string): boolean => {
    const left = candidate.trim().replace(/\s+/g, " ");
    const right = expected.trim().replace(/\s+/g, " ");
    if (!right) return true;
    if (exact) return left === right;
    return left.toLowerCase().includes(right.toLowerCase());
  };

  switch (by) {
    case "role":
      if (!match(nodeRole, value)) return false;
      if (name && !match(nodeName, name)) return false;
      return true;
    case "text":
      return match(nodeName, value) || match(nodeValue, value) || match(nodeDescription, value);
    case "label":
      // Labels are associated with interactive (labelable) elements only —
      // not headings, paragraphs, or structural nodes.
      if (!INTERACTIVE_ROLES.has(nodeRole)) return false;
      return match(nodeName, value);
    case "placeholder":
      // Placeholders belong on form controls only.
      if (!INTERACTIVE_ROLES.has(nodeRole)) return false;
      // AX tree exposes placeholder as part of name or description
      return match(nodeName, value) || match(nodeDescription, value);
    case "alt":
      // Alt text applies to images and image-like roles.
      if (!INTERACTIVE_ROLES.has(nodeRole) && nodeRole !== "img" && nodeRole !== "image")
        return false;
      return match(nodeName, value);
    case "title":
      // Title attribute can appear on any element, but is most useful
      // on interactive elements. Allow broad matching.
      return match(nodeName, value) || match(nodeDescription, value);
    case "testid":
      // data-testid is not exposed in AX tree — no match possible
      return false;
    case "selector":
      // CSS selectors cannot be evaluated against the AX tree
      return false;
  }
}

export function collectDescendantNodeIds(root: AXNode, allNodes: AXNode[]): Set<string> {
  const byNodeId = new Map<string, AXNode>();
  for (const n of allNodes) byNodeId.set(n.nodeId, n);

  const ids = new Set<string>();
  const stack = [...(root.childIds ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    const child = byNodeId.get(id);
    if (child?.childIds) stack.push(...child.childIds);
  }
  return ids;
}
