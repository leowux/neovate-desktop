// Barrel: re-export everything from the split modules.
// External consumers can continue importing from "browser-cdp-service"
// (which now resolves to this directory's index.ts).

export { BrowserCdpService } from "./service";

export {
  normalizeBrowserRef,
  formatBrowserRef,
  normalizeBrowserUrl,
  matchesBrowserPattern,
} from "./utils";

export {
  formatSnapshotLine,
  findScopedNodes,
  collectInteractiveSnapshotLines,
  collectFullSnapshotLines,
  buildFindQuery,
  axNodeMatchesQuery,
  collectDescendantNodeIds,
} from "./ax-helpers";

export type { EnsureRefFn } from "./ax-helpers";

export { parseKey, modifierFlag } from "./keyboard-helpers";

export { BrowserRefCache } from "./ref-cache";

export type {
  ConsoleLogEntry,
  BrowserErrorEntry,
  RefCacheEntry,
  AXNode,
  BrowserFindBy,
} from "./types";
