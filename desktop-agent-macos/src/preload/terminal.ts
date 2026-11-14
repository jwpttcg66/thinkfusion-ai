import { contextBridge, ipcRenderer } from 'electron';
import type { TerminalAttach, TerminalDataEvent, TerminalSessionSummary } from '../shared/cli-agents';

/**
 * 独立终端窗口的唯一桥。
 *
 * 与主窗口的 `agentAPI` 不同：这里没有任务、文件、设置或任意路径能力，
 * 只有「看/写一个已经存在的 PTY」。主进程按 sender id 校验来源，别处拿不到。
 */
contextBridge.exposeInMainWorld('tfTerminal', {
  list: (): Promise<TerminalSessionSummary[]> => ipcRenderer.invoke('terminal:list'),
  attach: (sessionId: string): Promise<TerminalAttach> => ipcRenderer.invoke('terminal:attach', sessionId),
  write: (sessionId: string, data: string): Promise<void> =>
    ipcRenderer.invoke('terminal:write', { sessionId, data }),
  resize: (sessionId: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('terminal:resize', { sessionId, cols, rows }),
  close: (sessionId: string): Promise<void> => ipcRenderer.invoke('terminal:close', sessionId),
  onData: (listener: (event: TerminalDataEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TerminalDataEvent) => listener(payload);
    ipcRenderer.on('terminal:data', handler);
    return () => ipcRenderer.removeListener('terminal:data', handler);
  },
  reattach: (): Promise<void> => ipcRenderer.invoke('terminal:reattach')
});
