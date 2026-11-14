import { contextBridge, ipcRenderer } from 'electron';

/**
 * 独立窗口工具栏的唯一桥。
 *
 * 这份窗口的文档是 `data:` URL，没有主窗口那份完整 preload。这里只暴露
 * 保存请求和吸附动作；保存选择仍由主窗口的同一套多选面板处理。
 */
contextBridge.exposeInMainWorld('tfDetached', {
  requestSave: (format: 'md' | 'docx') => ipcRenderer.invoke('page:request-save-from-detached', format) as Promise<void>,
  reattach: () => ipcRenderer.send('page:reattach-from-detached')
});
