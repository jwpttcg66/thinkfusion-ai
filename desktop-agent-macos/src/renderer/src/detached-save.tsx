import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DetachedSavePreview } from '../../shared/export';
import { PageSaveDialog } from './components/PageSaveDialog';
import './style.css';

function DetachedSaveApp() {
  const [request, setRequest] = useState<DetachedSavePreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | undefined>();

  useEffect(() => {
    void window.tfDetachedSave.getPreview()
      .then(setRequest)
      .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  function close() {
    window.tfDetachedSave.close();
  }

  async function save(input: Parameters<React.ComponentProps<typeof PageSaveDialog>['onSave']>[0]) {
    if (!request || busy) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await window.tfDetachedSave.save(input);
      setNotice({
        text: result
          ? `已保存到 ${result.path}`
          : '已取消保存'
      });
    } catch (reason) {
      setNotice({ text: reason instanceof Error ? reason.message : String(reason), error: true });
    } finally {
      setBusy(false);
    }
  }

  if (error || !request) {
    return (
      <div className="diag-overlay">
        <section className="diag-panel page-save-panel" role="dialog" aria-label="保存网页对话">
          <div className="diag-head">
            <b>保存网页对话</b>
            <span className="settings-spacer" />
            <button className="btn ghost" type="button" onClick={close}>关闭</button>
          </div>
          <div className="diag-body">
            <p className={error ? 'diag-warn' : 'muted'}>{error || '正在读取这一页的对话…'}</p>
          </div>
        </section>
      </div>
    );
  }

  return (
    <PageSaveDialog
      preview={request.preview}
      format={request.format}
      busy={busy}
      notice={notice}
      onClose={close}
      onSave={input => void save(input)}
    />
  );
}

document.title = '保存网页对话';
createRoot(document.getElementById('root')!).render(<DetachedSaveApp />);
