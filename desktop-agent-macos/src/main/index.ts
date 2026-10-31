import { app, BrowserWindow, WebContentsView, session, ipcMain, dialog } from 'electron';
import path from 'node:path';
import type {
  AgentEvent,
  DeepSeekDiagnostics,
  DeepSeekEvent,
  DeepSeekStatus,
  LayoutInfo,
  PermissionPreset,
  SourcesState,
  ViewBoundsMap
} from '../shared/contracts';
import {
  ApprovePlanSchema,
  ClarificationAnswerSchema,
  RejectPlanSchema,
  SubmitPromptSchema,
  TaskIdSchema
} from '../shared/schemas';
import { AgentStore } from './store';
import { TaskManager } from './task-manager';
import { DeepSeekAdapter, createElectronDriver } from './deepseek-adapter';
import { ChannelRegistry } from './channels/registry';
import { WebPageChannel } from './channels/web-page';
import { CHATGPT_HOSTS, CHATGPT_SELECTORS } from './channels/chatgpt';
import { ConversationRunner } from './conversation-runner';
import { classifyIntent } from '../shared/intent';
import type { ConversationEvent } from '../shared/conversation';
import { AgentOrchestrator } from './orchestrator';
import { setAgentEventSink, startAgentProcess } from './agent-manager';
import { computePageBounds, computeSplit, type PageBounds } from '../shared/layout';
import { findSource, isAllowedSourceUrl, PAGE_SOURCES, type PageSource } from '../shared/sources';
import { PlatformAccessibility } from '../platform/accessibility';

let win: BrowserWindow | null = null;

/**
 * One native view per embedded page, created on first use.
 *
 * All of them stay alive once created: tearing a view down and rebuilding it
 * throws away the site's in-memory state, and for a chat page that means the
 * reply being written right now.
 */
const views = new Map<string, WebContentsView>();
/**
 * The source on screen. Only this view is visible; the rest are parked.
 *
 * A parked view keeps the viewport it was primed with (see `primeViewports`) —
 * that is what makes a background channel answerable. Hiding a view before it
 * has ever had a size is the one thing that must not happen.
 */
let activeSourceId: string = PAGE_SOURCES[0].id;
/** Last geometry handed to each native view, so `layout()` only pushes changes. */
const applied = new Map<string, PageBounds & { visible: boolean }>();
/** True while the active source's view is being created or first loaded. */
let sourceLoading = false;

const accessibility = new PlatformAccessibility();
let permissionPreset: PermissionPreset = 'workspace-write';
let statusTimer: NodeJS.Timeout | null = null;
/** Width the user dragged the page pane to, or null for the default ratio. */
let preferredSplit: number | null = null;
/**
 * True while the divider is being dragged.
 *
 * The page pane is a native view, and macOS routes mouse events by native hit
 * test — so the instant the pointer crosses that view's left edge the renderer
 * stops hearing about the drag. With the view parked exactly on the boundary,
 * the very first pixel of a rightward drag is swallowed and the gesture dies.
 * So while dragging the view is parked just outside the window instead, and
 * the renderer draws a placeholder where it will land.
 */
let draggingPage = false;

let store: AgentStore;
let tasks: TaskManager;
let orchestrator: AgentOrchestrator;
let conversations: ConversationRunner;
// The adapter drives the planning source only. Which source that is lives in
// shared/sources.ts, so "which page does the agent talk to" is one line.
const adapter = new DeepSeekAdapter(() => {
  const view = views.get('deepseek');
  return view ? createElectronDriver(view) : null;
});

/**
 * The second channel, same driver, different site.
 *
 * Reusing `DeepSeekAdapter` rather than writing a second page driver is the
 * point of the M1 split: the probe, the send path, the "is this answer mine"
 * logic and the echo stripping are all site-agnostic. Only the hosts and the
 * selector profile differ.
 */
const chatgptAdapter = new DeepSeekAdapter(
  () => {
    const view = views.get('chatgpt');
    return view ? createElectronDriver(view, CHATGPT_SELECTORS) : null;
  },
  { hosts: CHATGPT_HOSTS, siteLabel: 'ChatGPT' }
);

const registry = new ChannelRegistry([
  new WebPageChannel({ id: 'deepseek', label: 'DeepSeek', adapter }),
  new WebPageChannel({ id: 'chatgpt', label: 'ChatGPT', adapter: chatgptAdapter })
]);

/** Single funnel for events: persist for replay, then push to the renderer. */
function emit(event: AgentEvent) {
  try {
    store?.appendEvent(event);
  } catch {
    /* Persisting events must never break the running task. */
  }
  win?.webContents.send('agent:event', event);
}

function emitDeepSeek(event: DeepSeekEvent) {
  win?.webContents.send('deepseek:event', event);
}

function emitConversation(event: ConversationEvent) {
  win?.webContents.send('conversation:event', event);
}

function trustedUiSender(event: Electron.IpcMainInvokeEvent) {
  if (!win || event.sender.id !== win.webContents.id || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('IPC sender rejected');
  }
  const url = event.senderFrame?.url ?? '';
  const isDev = url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:');
  if (!isDev && !url.startsWith('file://')) throw new Error('Untrusted renderer origin');
}

/**
 * Split the window between the app and the embedded page.
 *
 * The arithmetic lives in layout.ts so it can be asserted; both sides then
 * derive the boundary from the same number instead of each guessing.
 */
function layout() {
  if (!win) return;
  const [width, height] = win.getContentSize();
  const split = computeSplit(width, preferredSplit);
  const shown = computePageBounds(width, height, split);
  const offstage = computePageBounds(width, height, split, { parked: true });

  for (const [id, view] of views) {
    // Only the active source is on screen, and never while dragging: an
    // offscreen-but-visible view on the boundary still eats the pointer.
    //
    // The parked view keeps the viewport it was given while it was on screen
    // (`primeViewports`), so it stays askable in the background even though it
    // is not laid out against the current split.
    const onScreen = id === activeSourceId && !draggingPage;
    const bounds = onScreen ? shown : offstage;
    const last = applied.get(id);
    if (!last || last.x !== bounds.x || last.y !== bounds.y || last.width !== bounds.width || last.height !== bounds.height) {
      view.setBounds(bounds);
      applied.set(id, { ...bounds, visible: last?.visible ?? true });
    }
    if (!last || last.visible !== onScreen) {
      view.setVisible(onScreen);
      const entry = applied.get(id);
      if (entry) entry.visible = onScreen;
    }
  }

  win.webContents.send('layout:changed', { split } satisfies LayoutInfo);
}

/**
 * Give every page a real box once, while the window is still off screen.
 *
 * A `WebContentsView` that has never been shown has a **0x0 viewport**: every
 * element measures zero, so the probe cannot see an input box and cannot read an
 * answer. The channel then reports "未找到输入框，页面结构可能已变化" about a page
 * that is perfectly healthy, and a source the user has never clicked is never
 * askable at all — multi-channel comparison silently degrades to whichever page
 * happens to be in front.
 *
 * A viewport, once given, survives being hidden, so this only has to happen
 * before the first paint. Doing it before `win.show()` is what keeps it
 * invisible: showing the views afterwards would flash the second site over the
 * pane the user is looking at.
 */
async function primeViewports(): Promise<void> {
  if (!win) return;
  const [width, height] = win.getContentSize();
  const shown = computePageBounds(width, height, computeSplit(width, preferredSplit));
  for (const [id, view] of views) {
    view.setBounds(shown);
    view.setVisible(true);
    applied.set(id, { ...shown, visible: true });
  }
  // One layout pass is not enough: the page needs a frame with a non-zero size
  // before its own layout runs.
  await new Promise(resolve => setTimeout(resolve, 150));
}

function sourcesState(): SourcesState {
  return { sources: [...PAGE_SOURCES], activeId: activeSourceId, loading: sourceLoading };
}

function emitSources() {
  win?.webContents.send('sources:changed', sourcesState());
}

/**
 * Create a source's view. Loading is a separate step.
 *
 * Each source gets its own persistent partition, its own permission handlers
 * (all denied) and its own navigation allow-list — a shared session would let
 * one site read the other's cookies, which is the whole point of keeping them
 * apart.
 */
function createSourceView(source: PageSource): WebContentsView {
  if (!win) throw new Error('窗口尚未创建');

  const partition = `persist:${source.id}`;
  const ses = session.fromPartition(partition);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);

  const view = new WebContentsView({
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: true
    }
  });
  win.contentView.addChildView(view);
  // Background throttling would be a second way to break a channel that is not
  // the one on screen: Chromium slows timers and paints for a page it believes
  // is hidden, and a chat page that stops painting also stops updating the text
  // the probe reads. These pages are the product's workers, not decoration, so
  // they keep running at full rate whether or not the user is looking.
  view.webContents.setBackgroundThrottling(false);

  view.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedSourceUrl(source, url)) return { action: 'allow' };
    return { action: 'deny' };
  });
  view.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedSourceUrl(source, url)) event.preventDefault();
  });
  // `will-navigate` covers navigations the page starts, but a server-side
  // redirect goes through `will-redirect` instead — which is exactly how an
  // OAuth hop leaves the allow-list without anyone noticing.
  view.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedSourceUrl(source, url)) event.preventDefault();
  });
  view.webContents.on('will-attach-webview', event => event.preventDefault());

  views.set(source.id, view);
  return view;
}

/**
 * Load a source's page.
 *
 * Separate from creating the view so the window can be shown — and the viewport
 * primed — before any site is given a turn on the network.
 */
async function loadSource(source: PageSource): Promise<void> {
  const view = views.get(source.id);
  if (!view) return;
  await view.webContents.loadURL(source.url);
}

/** Create the view on first use, and make sure its page is on its way. */
async function ensureSource(source: PageSource): Promise<WebContentsView> {
  const existing = views.get(source.id);
  if (existing) return existing;
  if (!win) throw new Error('窗口尚未创建');
  const view = createSourceView(source);
  layout();
  await loadSource(source);
  return view;
}

/**
 * Bring a source to the front.
 *
 * The view is created in the background: the rail must switch immediately even
 * when the site takes seconds to load, otherwise the button looks broken for
 * exactly as long as the network is slow.
 */
function activateSource(id: string) {
  const source = findSource(id);
  if (!source) throw new Error(`未知来源：${id}`);
  if (id === activeSourceId && views.has(id)) return;

  activeSourceId = id;
  // A view that exists is not necessarily a page that has arrived: every source
  // is created at startup now, so "has a view" no longer answers "is it ready".
  sourceLoading = views.get(id)?.webContents.isLoading() ?? true;
  layout();
  emitSources();
  if (!sourceLoading) return;

  void ensureSource(source)
    .then(() => {
      if (activeSourceId !== id) return;
      sourceLoading = false;
      layout();
      emitSources();
    })
    .catch(() => {
      if (activeSourceId !== id) return;
      sourceLoading = false;
      emitSources();
    });
}

async function createWindow() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const isAppPage =
      details.url.startsWith('file://') || details.url.startsWith('http://localhost:') || details.url.startsWith('http://127.0.0.1:');
    if (!isAppPage) return callback({ responseHeaders: details.responseHeaders });
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self' 'unsafe-inline' http://localhost:* http://127.0.0.1:*; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://localhost:* http://localhost:* http://127.0.0.1:*; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
        ]
      }
    });
  });

  win = new BrowserWindow({
    width: 1560,
    height: 960,
    minWidth: 1180,
    minHeight: 720,
    title: 'ThinkFusion',
    // Shown after the views have been primed: see the startup order below.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.setMenuBarVisibility(false);

  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Every configured source is a channel, and a channel whose page was never
  // created cannot answer. Loading only the active one meant a fresh start could
  // read "0/2 通道就绪 · 页面尚未加载" and then quietly ask one AI, because the
  // rail was a prerequisite nobody knew they had to click.
  //
  // The order matters and is not the obvious one: every view is created and
  // given a real box while the window is still off screen, because a view that
  // has never been shown can never be asked. Only then is the window shown, and
  // only then does any site get a turn on the network — so startup is not gated
  // on the slower site, and nothing flashes over the pane.
  // The window is created hidden (`show: false`) so the views can be primed
  // before anything is painted. A window that never gets shown is worse than a
  // flash, so the show is in `finally`: whatever the priming does, the app
  // appears.
  try {
    for (const source of PAGE_SOURCES) createSourceView(source);
    await primeViewports();
    layout();
    win.on('resize', layout);
    startStatusPolling();
  } finally {
    win.show();
  }

  const active = findSource(activeSourceId) ?? PAGE_SOURCES[0];
  await loadSource(active).catch(() => undefined);
  for (const source of PAGE_SOURCES) {
    if (source.id === active.id) continue;
    void loadSource(source).catch(() => undefined);
  }
}

function startStatusPolling() {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(async () => {
    const view = views.get('deepseek');
    if (!view || view.webContents.isLoading()) return;
    try {
      const status: DeepSeekStatus = await adapter.getStatus();
      emitDeepSeek({ type: 'status', status });
    } catch {
      /* transient; next tick retries */
    }
  }, 1500);
  statusTimer.unref();
}

function registerIpc() {
  ipcMain.handle('task:submit', async (event, raw: unknown) => {
    trustedUiSender(event);
    const input = SubmitPromptSchema.parse(raw);
    return orchestrator.submit(input);
  });

  ipcMain.handle('task:get', (event, taskId: unknown) => {
    trustedUiSender(event);
    return store.getTask(TaskIdSchema.parse(taskId));
  });

  ipcMain.handle('task:history', event => {
    trustedUiSender(event);
    return tasks.list();
  });

  ipcMain.handle('task:events', (event, taskId: unknown) => {
    trustedUiSender(event);
    return store.listEvents(TaskIdSchema.parse(taskId));
  });

  ipcMain.handle('task:approve', async (event, raw: unknown) => {
    trustedUiSender(event);
    await orchestrator.approve(ApprovePlanSchema.parse(raw));
  });

  ipcMain.handle('task:reject', async (event, raw: unknown) => {
    trustedUiSender(event);
    await orchestrator.reject(RejectPlanSchema.parse(raw));
  });

  ipcMain.handle('task:cancel', async (event, taskId: unknown) => {
    trustedUiSender(event);
    await orchestrator.cancel(TaskIdSchema.parse(taskId));
  });

  ipcMain.handle('task:answer', async (event, raw: unknown) => {
    trustedUiSender(event);
    const input = ClarificationAnswerSchema.parse(raw);
    await orchestrator.answerClarification(input);
  });

  ipcMain.handle('task:delete', async (event, taskId: unknown) => {
    trustedUiSender(event);
    const id = TaskIdSchema.parse(taskId);
    await orchestrator.deleteTask(id);
    // The list is built from events, so a delete that is only persisted leaves
    // the row on screen until the window is reloaded.
    win?.webContents.send('agent:event', { type: 'task.deleted', taskId: id, at: Date.now() });
  });

  ipcMain.handle('permission:get', event => {
    trustedUiSender(event);
    return permissionPreset;
  });

  ipcMain.handle('permission:set', (event, preset: unknown) => {
    trustedUiSender(event);
    if (typeof preset !== 'string' || !['read-only', 'workspace-write', 'danger-full-access'].includes(preset)) {
      throw new Error('未知权限预设');
    }
    permissionPreset = preset as PermissionPreset;
    return { preset: permissionPreset, approvalPolicy: 'ask' as const };
  });

  ipcMain.handle('app:platform', event => {
    trustedUiSender(event);
    return process.platform;
  });

  // --- conversations -------------------------------------------------------
  //
  // The primary path. Note what is absent: no workspace, no permission, no
  // approval. A question does not need any of those, and asking for them is how
  // the old build turned every question into a file operation.

  ipcMain.handle('conversation:submit', async (event, raw: unknown) => {
    trustedUiSender(event);
    if (!raw || typeof raw !== 'object') throw new Error('无效输入');
    const input = raw as { text?: unknown; workspaceRoot?: unknown; permissionPreset?: unknown };
    if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('先写一句你想研究或完成的事情。');
    return conversations.start({
      text: input.text,
      workspaceRoot: typeof input.workspaceRoot === 'string' ? input.workspaceRoot : undefined,
      permissionPreset: typeof input.permissionPreset === 'string' ? input.permissionPreset : undefined
    });
  });

  /**
   * Routing, without the side effect.
   *
   * Submitting a `workspace` sentence sends the planning prompt to a live web
   * page, and that page keeps the thread in its history forever. Anything that
   * only wants to know how a sentence would be routed — a preview in the UI, a
   * check script — must be able to ask without writing to someone's account.
   */
  ipcMain.handle('conversation:classify', (event, raw: unknown) => {
    trustedUiSender(event);
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('先写一句想做的事。');
    const intent = classifyIntent(raw);
    return { intent: intent.kind, reason: intent.reason };
  });

  ipcMain.handle('conversation:followup', async (event, raw: unknown) => {
    trustedUiSender(event);
    const input = raw as { conversationId?: unknown; text?: unknown };
    if (typeof input.conversationId !== 'string') throw new Error('缺少对话 id');
    if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('先写一句你想追问的内容。');
    return conversations.followup(input.conversationId, input.text);
  });

  ipcMain.handle('conversation:list', event => {
    trustedUiSender(event);
    return conversations.list();
  });

  ipcMain.handle('conversation:get', (event, id: unknown) => {
    trustedUiSender(event);
    if (typeof id !== 'string') throw new Error('缺少对话 id');
    return conversations.get(id);
  });

  ipcMain.handle('conversation:messages', (event, id: unknown) => {
    trustedUiSender(event);
    if (typeof id !== 'string') throw new Error('缺少对话 id');
    return conversations.messages(id);
  });

  ipcMain.handle('conversation:cancel', (event, id: unknown) => {
    trustedUiSender(event);
    if (typeof id !== 'string') throw new Error('缺少对话 id');
    conversations.cancel(id);
  });

  ipcMain.handle('conversation:delete', (event, id: unknown) => {
    trustedUiSender(event);
    if (typeof id !== 'string') throw new Error('缺少对话 id');
    conversations.delete(id);
    // Deletion is silent otherwise: the store loses the row while every open
    // list keeps showing it, which looks like the delete button did nothing.
    emitConversation({ type: 'conversation.deleted', at: Date.now(), conversationId: id });
  });

  ipcMain.handle('channel:statuses', async event => {
    trustedUiSender(event);
    return registry.statuses();
  });

  ipcMain.handle('deepseek:status', async event => {
    trustedUiSender(event);
    return adapter.getStatus();
  });

  ipcMain.handle('deepseek:diagnose', async event => {
    trustedUiSender(event);
    const report = await adapter.diagnose();
    // The page is a native view, so its position is only knowable here. When
    // the two panes disagree, this is the number that settles it.
    return {
      ...report,
      view: views.get('deepseek')?.getBounds() ?? null,
      dragging: draggingPage
    } satisfies DeepSeekDiagnostics;
  });

  ipcMain.handle('deepseek:reload', async event => {
    trustedUiSender(event);
    const view = views.get('deepseek');
    const source = findSource('deepseek');
    if (!view || !source) throw new Error('内嵌页面尚未创建');
    await view.webContents.loadURL(source.url);
  });

  ipcMain.handle('app:sources', event => {
    trustedUiSender(event);
    return sourcesState();
  });

  ipcMain.handle('app:set-source', (event, id: unknown) => {
    trustedUiSender(event);
    if (typeof id !== 'string' || !findSource(id)) throw new Error('未知来源');
    activateSource(id);
    return sourcesState();
  });

  // The page views are native, so this is the only honest answer to "is the
  // rail covered?". It exists because that failure is silent: the buttons just
  // stop responding, and nothing throws.
  ipcMain.handle('app:view-bounds', event => {
    trustedUiSender(event);
    const out: ViewBoundsMap = {};
    for (const [id, view] of views) out[id] = view.getBounds();
    return out;
  });

  ipcMain.handle('app:layout', event => {
    trustedUiSender(event);
    const [width] = win!.getContentSize();
    return { split: computeSplit(width, preferredSplit) } satisfies LayoutInfo;
  });

  // Dragging the divider. The renderer only proposes a width; the clamp lives
  // here so a stale or hostile value cannot produce an unusable layout.
  ipcMain.handle('app:set-split', (event, value: unknown) => {
    trustedUiSender(event);
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('无效的分栏宽度');
    const [width] = win!.getContentSize();
    preferredSplit = computeSplit(width, value);
    layout();
    return { split: preferredSplit } satisfies LayoutInfo;
  });

  // Told when a drag starts and ends so the page view can step out of the way.
  ipcMain.handle('app:drag-page', (event, active: unknown) => {
    trustedUiSender(event);
    const next = active === true;
    if (next === draggingPage) return;
    draggingPage = next;
    layout();
  });

  ipcMain.handle('ax:snapshot', async event => {
    trustedUiSender(event);
    if (process.platform !== 'darwin') throw new Error('当前构建版本只实现 macOS Accessibility 读取');
    const available = await accessibility.isAvailable();
    if (!available) throw new Error('Accessibility 权限未授予或原生辅助程序不存在');
    const application = await accessibility.getFrontmostApplication();
    const tree = await accessibility.getElementTree(4);
    return { available, application, tree };
  });

  ipcMain.handle('agent:choose-directory', async event => {
    trustedUiSender(event);
    const result = await dialog.showOpenDialog(win!, {
      title: '选择本次任务的工作区',
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });
}

app.whenReady().then(async () => {
  store = new AgentStore(path.join(app.getPath('userData'), 'agent-store.json'));
  tasks = new TaskManager(store, emit);
  orchestrator = new AgentOrchestrator({
    tasks,
    store,
    adapter,
    emit,
    dbPath: () => path.join(app.getPath('userData'), 'agent-journal.json')
  });

  // The conversation runner gets the workspace hand-off as a function, not an
  // import, so that "does this file depend on the runtime" is answerable by
  // reading its imports.
  conversations = new ConversationRunner({
    store,
    registry,
    emit: emitConversation,
    submitWorkspace: input =>
      orchestrator.submit({
        prompt: input.prompt,
        permissionPreset: input.permissionPreset as PermissionPreset,
        workspaceRoot: input.workspaceRoot
      })
  });

  // Handlers, the agent process and the event sink all have to exist before any
  // renderer does. They used to be registered inside createWindow() *after*
  // `await loadURL('https://chat.deepseek.com/')`, so on a slow network the UI
  // mounted first and its opening calls (platform, permission, history, status)
  // all failed with "No handler registered" — leaving the window permanently
  // blank of state while the webview looked fine.
  registerIpc();
  startAgentProcess();
  setAgentEventSink(event => emit(event));

  await createWindow();
});

app.on('before-quit', () => {
  if (statusTimer) clearInterval(statusTimer);
  adapter.cancelAllWaits();
  chatgptAdapter.cancelAllWaits();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
