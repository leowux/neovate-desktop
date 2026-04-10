import { ElectronAPI } from "@electron-toolkit/preload";

interface NeovateApi {
  homedir: string;
  isDev: boolean;
  onOpenSettings: (callback: () => void) => () => void;
  onPopupWindowShown: (callback: () => void) => () => void;
  onFullScreenChange: (callback: (isFullScreen: boolean) => void) => () => void;
}

interface BrowserIpc {
  onBrowserCommand: (
    callback: (cmd: { requestId: string; method: string; args: unknown }) => void,
  ) => () => void;
  sendBrowserResult: (requestId: string, result: unknown, error?: string) => void;
}

declare global {
  interface Window {
    electron: ElectronAPI;
    api: NeovateApi;
    browserIpc: BrowserIpc;
  }
}
