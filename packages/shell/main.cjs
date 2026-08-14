/**
 * Electron main process.
 *
 * Two responsibilities: put the editor on the primary display and the projector
 * on the external one, and give the renderer a save dialog. Everything else —
 * audio, drawing, PDF generation — happens in the renderer, because the engine
 * and the template both run fine in a browser context and keeping them there
 * means they stay testable without Electron.
 */

const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const fs = require('node:fs');
const { writeFile } = require('node:fs/promises');
const path = require('node:path');

const DEV_URL = process.env.ORAMICS_DEV_URL;

// Packaged builds carry a staged copy (see stage.mjs); running unpackaged
// against a plain `pnpm build` reaches across the workspace.
const STAGED = path.join(__dirname, 'renderer');
const RENDERER_DIR = fs.existsSync(STAGED) ? STAGED : path.join(__dirname, '../app/dist');

/** @type {BrowserWindow | null} */
let editorWindow = null;
/** @type {BrowserWindow | null} */
let projectorWindow = null;

const baseWebPreferences = {
  preload: path.join(__dirname, 'preload.cjs'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false,
};

/** Load either the dev server or the built file, for a given HTML entry. */
const loadEntry = (win, entry) => {
  if (DEV_URL) return win.loadURL(new URL(entry, DEV_URL).href);
  return win.loadFile(path.join(RENDERER_DIR, entry));
};

const createEditorWindow = () => {
  editorWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1040,
    minHeight: 640,
    backgroundColor: '#0a090c',
    title: 'Oramics',
    titleBarStyle: 'hiddenInset',
    webPreferences: baseWebPreferences,
  });
  loadEntry(editorWindow, 'index.html');
  editorWindow.on('closed', () => {
    editorWindow = null;
  });
};

/**
 * Put the projector on a display that is not the one the editor is on. Falls
 * back to a window on the primary display so the feature still works on a
 * single-screen laptop while you are building.
 */
const externalDisplay = () => {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  return displays.find((d) => d.id !== primary.id) ?? null;
};

const createProjectorWindow = () => {
  const target = externalDisplay();
  const bounds = target
    ? target.bounds
    : { x: undefined, y: undefined, width: 1280, height: 800 };

  projectorWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    fullscreen: Boolean(target),
    backgroundColor: '#0a090c',
    title: 'Oramics — Projector',
    webPreferences: baseWebPreferences,
  });
  loadEntry(projectorWindow, 'projector.html');
  projectorWindow.on('closed', () => {
    projectorWindow = null;
  });
};

ipcMain.handle('oramics:toggle-projector', () => {
  if (projectorWindow) {
    projectorWindow.close();
    return false;
  }
  createProjectorWindow();
  return true;
});

ipcMain.handle('oramics:save-pdf', async (_event, bytes) => {
  const { canceled, filePath } = await dialog.showSaveDialog(editorWindow ?? undefined, {
    title: 'Export sheet',
    defaultPath: 'oramics-session.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return null;
  await writeFile(filePath, Buffer.from(bytes));
  return filePath;
});

app.whenReady().then(() => {
  createEditorWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createEditorWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
