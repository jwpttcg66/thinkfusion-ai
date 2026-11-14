import { contextBridge, ipcRenderer } from 'electron';
import type { DetachedPageSaveApi } from '../shared/export';

/** The save sheet can read a preview and save only the detached page it belongs to. */
const api: DetachedPageSaveApi = {
  getPreview: () => ipcRenderer.invoke('page:detached-save-preview'),
  save: input =>
    ipcRenderer.invoke('page:detached-save-document', input),
  close: () => ipcRenderer.send('page:detached-save-close')
};

contextBridge.exposeInMainWorld('tfDetachedSave', api);
