import { contextBridge, ipcRenderer } from 'electron';

/**
 * 独立窗口工具栏的唯一桥。
 *
 * 这份窗口的文档是 `data:` URL，没有主窗口那份完整 preload；但「保存文档」
 * 必须和放大前一样真的能落盘。改 `location.hash` 在 `data:` 页上经常不触发
 * `did-navigate-in-page`，点了没反应——所以这里只暴露保存这一件事。
 */
contextBridge.exposeInMainWorld('tfDetached', {
  saveDocument: (format: 'md' | 'docx') => ipcRenderer.invoke('page:save-from-detached', format) as Promise<void>
});
