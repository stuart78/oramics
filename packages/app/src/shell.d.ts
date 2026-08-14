/** The surface the Electron preload exposes. Absent when running in a plain browser. */
export interface OramicsShell {
  /** Show a save dialog and write the PDF. Returns the path, or null if cancelled. */
  savePdf: (bytes: Uint8Array) => Promise<string | null>;
  /** Open or close the projector window on the external display. */
  toggleProjector: () => Promise<boolean>;
}

declare global {
  interface Window {
    oramics?: OramicsShell;
  }
}
