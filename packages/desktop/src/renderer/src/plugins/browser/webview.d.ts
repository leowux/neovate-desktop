/**
 * Type declarations for the Electron <webview> tag in the renderer process.
 *
 * The renderer tsconfig does not include Electron's full type definitions,
 * so we declare the subset needed for the browser plugin.
 */

interface WebviewElement extends HTMLElement {
  src: string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  openDevTools(): void;
  getWebContentsId(): number;
  loadURL(url: string): Promise<void>;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  capturePage(rect?: { x: number; y: number; width: number; height: number }): Promise<{
    toDataURL(type?: string): string;
    toPNG(): Uint8Array;
  }>;
  getWebContentsId(): number;
}

declare namespace JSX {
  interface IntrinsicElements {
    webview: React.DetailedHTMLProps<
      React.HTMLAttributes<WebviewElement> & {
        src?: string;
        preload?: string;
        partition?: string;
        allowpopups?: boolean;
      },
      WebviewElement
    >;
  }
}
