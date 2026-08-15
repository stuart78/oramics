/** The surface the Electron preload exposes. Absent when running in a plain browser. */
export interface OramicsShell {
  /** Show a save dialog and write the PDF. Returns the path, or null if cancelled. */
  savePdf: (bytes: Uint8Array) => Promise<string | null>;
  /** Show a save dialog and write the performance file. Null if cancelled. */
  saveSession: (text: string) => Promise<string | null>;
  /** Show an open dialog and read a performance file. Null if cancelled. */
  openSession: () => Promise<{ path: string; text: string } | null>;
  /** Open or close the projector window on the external display. */
  toggleProjector: () => Promise<boolean>;
  /** Subscribe to menu commands. Returns an unsubscribe function. */
  onCommand: (handler: (command: ShellCommand) => void) => () => void;
}

/** What the menu can ask the editor window to do. */
export type ShellCommand = 'open' | 'save' | 'export-pdf' | 'zoom-in' | 'zoom-out' | 'zoom-fit' | 'theme';

declare global {
  interface Window {
    oramics?: OramicsShell;
  }
}
