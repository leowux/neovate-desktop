import type { WebContents } from "electron";

// ── Type aliases ──────────────────────────────────────────────────────────────

export type DebuggerEvent = {
  preventDefault: () => void;
  readonly defaultPrevented: boolean;
};

export type LoadState = "load" | "domcontentloaded" | "networkidle";

export type BrowserFindBy =
  | "role"
  | "text"
  | "label"
  | "placeholder"
  | "alt"
  | "title"
  | "testid"
  | "selector";

export type BrowserGetKind =
  | "text"
  | "html"
  | "value"
  | "attr"
  | "title"
  | "url"
  | "count"
  | "box"
  | "styles";

export type BrowserIsKind = "visible" | "enabled" | "checked";

export type BrowserConsoleAction = "get" | "clear";

export type BrowserTabAction = "list" | "new" | "switch" | "close";

export type BrowserDialogAction = "accept" | "dismiss" | "status";

export type BrowserStorageAction = "get" | "getAll" | "set" | "clear";

export type BrowserCookieAction = "get" | "set" | "clear";

export type BrowserNetworkAction = "requests" | "route" | "unroute";

export type BrowserSetKind =
  | "viewport"
  | "device"
  | "geo"
  | "offline"
  | "headers"
  | "credentials"
  | "media";

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface RefCacheEntry {
  backendNodeId: number;
  role?: string;
  name?: string;
  value?: string;
  description?: string;
  disabled?: boolean;
}

export interface ConsoleLogEntry {
  level: "log" | "warn" | "error" | "debug";
  message: string;
  ts: number;
}

export interface BrowserErrorEntry {
  message: string;
  ts: number;
  url?: string;
}

export interface DialogState {
  type: string;
  message: string;
  defaultPrompt?: string;
  url?: string;
  ts: number;
}

export interface NetworkRequestEntry {
  id: string;
  url: string;
  method: string;
  status?: number;
  resourceType?: string;
  failed?: boolean;
  errorText?: string;
  ts: number;
}

export interface NetworkRouteRule {
  pattern: string;
  abort?: boolean;
  body?: string;
  status?: number;
  headers?: Record<string, string>;
}

export interface ViewSession {
  webContents: WebContents;
  consoleLogs: ConsoleLogEntry[];
  errorLogs: BrowserErrorEntry[];
  requestLogs: NetworkRequestEntry[];
  requestById: Map<string, NetworkRequestEntry>;
  inflightRequests: Set<string>;
  networkRoutes: NetworkRouteRule[];
  dialogState: DialogState | null;
  activeFrameId: string | null;
  /** Isolated-world execution contexts keyed by frameId. */
  frameContexts: Map<string, number>;
  /** Main-world execution contexts keyed by frameId, discovered from Runtime.executionContextCreated. */
  mainWorldContexts: Map<string, number>;
  heldKeys: Set<string>;
  onDebuggerMessage: (
    event: DebuggerEvent,
    method: string,
    params: unknown,
    sessionId: string,
  ) => void;
}

export interface TabInfo {
  viewId: string;
  url: string;
  title: string;
  isActive: boolean;
}

export interface PageFrame {
  id: string;
  name?: string;
  url: string;
  parentId?: string;
}

export interface PageFrameTree {
  frame: PageFrame;
  childFrames?: PageFrameTree[];
}

export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value: string };
  name?: { value: string };
  value?: { value: string };
  description?: { value: string };
  disabled?: boolean;
  focused?: boolean;
  backendDOMNodeId?: number;
  childIds?: string[];
}

export interface CDPBoxModel {
  content: number[];
  width: number;
  height: number;
}

export interface SnapshotOptions {
  interactiveOnly?: boolean;
  compact?: boolean;
  depth?: number;
  scopeRef?: string;
  scopeSelector?: string;
  focused?: boolean;
}

export interface BrowserFindOptions {
  by: BrowserFindBy;
  value?: string;
  name?: string;
  exact?: boolean;
  nth?: number;
  all?: boolean;
  scopeRef?: string;
}

export interface BrowserGetOptions {
  kind: BrowserGetKind;
  ref?: string;
  selector?: string;
  name?: string;
}

export interface BrowserIsOptions {
  kind: BrowserIsKind;
  ref: string;
}

export interface BrowserWaitOptions {
  ref?: string;
  ms?: number;
  text?: string;
  urlPattern?: string;
  loadState?: LoadState;
  js?: string;
}

export interface BrowserTabOptions {
  action: BrowserTabAction;
  index?: number;
  url?: string;
}

export interface BrowserDialogOptions {
  action: BrowserDialogAction;
  text?: string;
}

export interface BrowserSetOptions {
  kind: BrowserSetKind;
  width?: number;
  height?: number;
  scale?: number;
  device?: string;
  latitude?: number;
  longitude?: number;
  offline?: boolean;
  headers?: Record<string, string>;
  username?: string;
  password?: string;
  colorScheme?: "light" | "dark";
  reducedMotion?: boolean;
}

export interface BrowserCookieOptions {
  action: BrowserCookieAction;
  name?: string;
  value?: string;
  url?: string;
  domain?: string;
  path?: string;
}

export interface BrowserStorageOptions {
  action: BrowserStorageAction;
  area?: "local";
  key?: string;
  value?: string;
}

export interface BrowserNetworkOptions {
  action: BrowserNetworkAction;
  pattern?: string;
  abort?: boolean;
  body?: string;
  status?: number;
  headers?: Record<string, string>;
  filter?: string;
}

export interface BrowserFrameOptions {
  target?: "main";
  ref?: string;
  selector?: string;
  match?: string;
}
