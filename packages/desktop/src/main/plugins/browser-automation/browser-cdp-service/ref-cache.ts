import type { AXNode, RefCacheEntry } from "./types";

import { formatBrowserRef } from "./utils";

export class BrowserRefCache {
  private refCache = new Map<string, Map<string, RefCacheEntry>>();
  private backendRefCache = new Map<string, Map<number, string>>();
  private refCounters = new Map<string, number>();

  reset(viewId: string): void {
    this.refCache.set(viewId, new Map());
    this.backendRefCache.set(viewId, new Map());
    this.refCounters.set(viewId, 0);
  }

  invalidate(viewId: string): void {
    this.reset(viewId);
  }

  nextRef(viewId: string): string {
    const next = (this.refCounters.get(viewId) ?? 0) + 1;
    this.refCounters.set(viewId, next);
    return `e${next}`;
  }

  ensureRef(
    viewId: string,
    backendNodeId: number,
    entry: Omit<RefCacheEntry, "backendNodeId"> = {},
  ): string {
    const reverse = this.backendRefCache.get(viewId) ?? new Map<number, string>();
    this.backendRefCache.set(viewId, reverse);
    const cache = this.refCache.get(viewId) ?? new Map<string, RefCacheEntry>();
    this.refCache.set(viewId, cache);
    const existing = reverse.get(backendNodeId);
    if (existing) {
      const current = cache.get(existing);
      cache.set(existing, { ...current, ...entry, backendNodeId });
      return existing;
    }
    const ref = this.nextRef(viewId);
    reverse.set(backendNodeId, ref);
    cache.set(ref, { backendNodeId, ...entry });
    return ref;
  }

  getBackendNodeIdForRef(ref: string, viewId: string): number {
    const cache = this.refCache.get(viewId);
    const backendNodeId = cache?.get(ref)?.backendNodeId;
    if (backendNodeId === undefined) {
      throw new Error(
        `Unknown ref ${formatBrowserRef(ref)}. Run browser_snapshot or browser_find first.`,
      );
    }
    return backendNodeId;
  }

  seedFromAXTree(viewId: string, nodes: AXNode[]): void {
    for (const node of nodes) {
      if (!node.backendDOMNodeId) continue;
      this.ensureRef(viewId, node.backendDOMNodeId, {
        role: node.role?.value,
        name: node.name?.value ?? "",
        value: node.value?.value,
        description: node.description?.value,
        disabled: node.disabled === true,
      });
    }
  }

  async ensureRefsForBackendNodeIds(
    viewId: string,
    backendNodeIds: number[],
    getA11yTree: () => Promise<AXNode[]>,
  ): Promise<string[]> {
    const nodes = await getA11yTree();
    const byBackend = new Map<number, AXNode>();
    for (const node of nodes) {
      if (node.backendDOMNodeId !== undefined) {
        byBackend.set(node.backendDOMNodeId, node);
      }
    }
    return backendNodeIds.map((backendNodeId) => {
      const node = byBackend.get(backendNodeId);
      return this.ensureRef(viewId, backendNodeId, {
        role: node?.role?.value,
        name: node?.name?.value ?? "",
        value: node?.value?.value,
        description: node?.description?.value,
        disabled: node?.disabled === true,
      });
    });
  }

  getRefEntry(viewId: string, ref: string): RefCacheEntry | undefined {
    return this.refCache.get(viewId)?.get(ref);
  }
}
