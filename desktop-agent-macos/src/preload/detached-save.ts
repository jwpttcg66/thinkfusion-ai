import { contextBridge, ipcRenderer } from 'electron';
import type { PageExtractPreview, SavePageDocumentInput, SavePageDocumentResult } from '../shared/export';

/** The save sheet can read a preview and save only the detached page it belongs to. */
contextBridge.exposeInMainWorld('tfDetachedSave', {
  getPreview: (): Promise<PageExtractPreview> => ipcRenderer.invoke('page:detached-save-preview'),
  save: (input: Pick<SavePageDocumentInput, 'documents' | 'mode' | 'includeTranscript'>): Promise<SavePageDocumentResult | null> =>
    ipcRenderer.invoke('page:detached-save-document', input),
  close: (): void => ipcRenderer.send('page:detached-save-close')
});
