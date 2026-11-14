/**
 * The detached page's save picker lives in a modal child window owned by that
 * page window. Keeping it out of the main renderer prevents a save click from
 * raising the main window over the single live WebContentsView.
 */
export function detachedSaveDocument(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline';">
<title>保存网页对话</title>
<style>
  :root { color-scheme: light; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif; color: #262622; background: #f5f5f2; }
  * { box-sizing: border-box; }
  body { margin: 0; min-width: 520px; min-height: 100vh; padding: 18px; }
  .shell { display: flex; flex-direction: column; min-height: calc(100vh - 36px); max-width: 900px; margin: 0 auto; overflow: hidden; border: 1px solid #deded8; border-radius: 12px; background: #fff; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid #e7e7e2; }
  header h1 { margin: 0; font-size: 15px; font-weight: 650; }
  #source { min-width: 0; overflow: hidden; color: #777770; text-overflow: ellipsis; white-space: nowrap; }
  .spacer { flex: 1; }
  button { font: inherit; }
  .quiet, .close, .action { border: 1px solid #deded8; border-radius: 7px; background: #fff; color: inherit; cursor: pointer; }
  .quiet, .close { padding: 6px 10px; }
  button:hover:not(:disabled) { background: #f4f4f0; }
  button:disabled { opacity: .48; cursor: default; }
  .lead { margin: 0; padding: 13px 18px; color: #66665f; }
  #items { flex: 1; overflow: auto; padding: 0 18px 14px; }
  .stamp { margin: 10px 0 4px; color: #777770; font-size: 11px; }
  .row { display: flex; align-items: flex-start; gap: 10px; padding: 10px; border: 1px solid #e5e5df; border-radius: 9px; cursor: pointer; }
  .row:has(input:checked) { border-color: #9ac8a4; background: #f2f8f2; }
  .row input { margin: 3px 0 0; accent-color: #397b4c; }
  .bubble { display: grid; min-width: 0; gap: 3px; }
  .bubble b { font-weight: 600; }
  .excerpt { color: #66665f; overflow-wrap: anywhere; }
  footer { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center; padding: 12px 18px; border-top: 1px solid #e7e7e2; }
  .options { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; color: #66665f; }
  .options label { display: inline-flex; align-items: center; gap: 6px; }
  .actions { display: flex; gap: 7px; }
  .action { min-width: 92px; padding: 8px 10px; }
  .action.primary { border-color: #397b4c; background: #397b4c; color: #fff; }
  .action.primary:hover:not(:disabled) { background: #2f693f; }
  #status { grid-column: 1 / -1; min-height: 18px; margin: 0; color: #66665f; overflow-wrap: anywhere; }
  #status.error { color: #a33125; }
</style></head><body>
<main class="shell" role="dialog" aria-label="保存网页对话">
  <header><h1>保存网页对话</h1><span id="source"></span><span class="spacer"></span><button id="close" class="close" type="button">关闭</button></header>
  <p id="lead" class="lead">正在读取这一页的对话…</p>
  <section id="items" aria-label="可保存的对话"></section>
  <footer>
    <div class="options">
      <span id="summary">尚未读取</span>
      <label><input id="transcript" type="checkbox" checked> 附页面转录</label>
    </div>
    <div class="actions">
      <button id="selected-items" class="action" type="button" disabled>逐条保存</button>
      <button id="selected-merge" class="action primary" type="button" disabled>合并保存</button>
      <button id="all-merge" class="action" type="button" disabled>全部保存</button>
    </div>
    <p id="status" role="status" aria-live="polite"></p>
  </footer>
</main>
<script>
  (function () {
    var api = window.tfDetachedSave;
    var preview = null;
    var busy = false;
    var selected = new Set();
    var items = document.getElementById('items');
    var summary = document.getElementById('summary');
    var status = document.getElementById('status');
    var buttons = ['selected-items', 'selected-merge', 'all-merge'].map(function (id) { return document.getElementById(id); });

    function setStatus(text, error) {
      status.textContent = text || '';
      status.className = error ? 'error' : '';
    }

    function indexes() {
      return preview ? preview.items.filter(function (item) { return selected.has(item.index); }).map(function (item) { return item.index; }) : [];
    }

    function updateButtons() {
      var chosen = indexes().length > 0;
      buttons[0].disabled = busy || !chosen;
      buttons[1].disabled = busy || !chosen;
      buttons[2].disabled = busy || !preview || preview.items.length === 0;
      summary.textContent = preview
        ? '已选 ' + String(indexes().length) + '/' + String(preview.items.length) + ' 条 · ' + String(preview.totalChars) + ' 字'
        : '尚未读取';
    }

    function render(value) {
      preview = value;
      document.getElementById('source').textContent = value.sourceLabel + (value.pageTitle ? ' · ' + value.pageTitle : '');
      document.getElementById('lead').textContent = '这一页读到 ' + String(value.items.length) + ' 条消息，共 ' + String(value.totalChars) + ' 字。绿色是你问的，白色是回答；勾选要保存的内容。';
      items.replaceChildren();
      if (value.items.length === 0) {
        var empty = document.createElement('p');
        empty.textContent = '这一页没有可保存的对话（可能停在登录页或空会话）。';
        items.append(empty);
      }
      value.items.forEach(function (item) {
        var stamp = document.createElement('p');
        stamp.className = 'stamp';
        stamp.textContent = '第 ' + String(item.index + 1) + ' 条 · ' + (item.role === 'user' ? '我问的' : '回答') + ' · ' + String(item.chars) + ' 字';
        var row = document.createElement('label');
        row.className = 'row';
        var checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.setAttribute('aria-label', '选择第 ' + String(item.index + 1) + ' 条');
        checkbox.addEventListener('change', function () {
          if (checkbox.checked) selected.add(item.index);
          else selected.delete(item.index);
          updateButtons();
        });
        var bubble = document.createElement('span');
        bubble.className = 'bubble';
        var title = document.createElement('b');
        title.textContent = item.title;
        var excerpt = document.createElement('span');
        excerpt.className = 'excerpt';
        excerpt.textContent = item.excerpt || '（这条没有正文）';
        bubble.append(title, excerpt);
        row.append(checkbox, bubble);
        items.append(stamp, row);
      });
      updateButtons();
    }

    async function save(mode, all) {
      if (!preview || busy) return;
      var documents = all ? preview.items.map(function (item) { return item.index; }) : indexes();
      if (documents.length === 0) return;
      busy = true;
      updateButtons();
      setStatus('正在保存…', false);
      try {
        var result = await api.save({ documents: documents, mode: mode, includeTranscript: mode === 'per-item' ? false : document.getElementById('transcript').checked });
        if (!result) {
          setStatus('已取消保存', false);
          return;
        }
        setStatus('已保存到 ' + (result.path || result.files.map(function (file) { return file.path; }).join('、')), false);
      } catch (error) {
        setStatus(error && error.message ? error.message : String(error), true);
      } finally {
        busy = false;
        updateButtons();
      }
    }

    document.getElementById('close').addEventListener('click', function () { api.close(); });
    document.getElementById('selected-items').addEventListener('click', function () { void save('per-item', false); });
    document.getElementById('selected-merge').addEventListener('click', function () { void save('merge', false); });
    document.getElementById('all-merge').addEventListener('click', function () { void save('merge', true); });
    window.addEventListener('keydown', function (event) { if (event.key === 'Escape') api.close(); });
    if (!api) {
      setStatus('保存窗口桥接未就绪，请重启应用后再试。', true);
      return;
    }
    api.getPreview().then(render).catch(function (error) {
      document.getElementById('lead').textContent = '读取失败';
      setStatus(error && error.message ? error.message : String(error), true);
    });
  })();
</script></body></html>`;
}
