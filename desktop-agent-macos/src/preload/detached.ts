import { contextBridge, ipcRenderer } from 'electron';

/**
 * 独立窗口工具栏的唯一桥。
 *
 * 这份窗口的文档是 `data:` URL，没有主窗口那份完整 preload。这里只暴露
 * 打开附属保存面板和吸附动作；保存面板属于独立窗口，不会抬起主窗口。
 */
contextBridge.exposeInMainWorld('tfDetached', {
  requestSave: (format: 'md' | 'docx') => ipcRenderer.invoke('page:request-save-from-detached', format) as Promise<void>,
  reattach: () => ipcRenderer.send('page:reattach-from-detached')
});
