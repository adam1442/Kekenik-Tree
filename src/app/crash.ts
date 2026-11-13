import { debugLog } from '@/core/debugLog';

/** Text of the crash report: message, stack, user agent and the recent debug log (copied by the "Copy log" button). */
export function formatCrashReport(error: unknown, extra: readonly string[] = debugLog.lines().slice(-60).map((l) => `[${l.level}] ${l.scope}: ${l.text}`)): string {
  const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : JSON.stringify(error));
  return [
    `Kekenik Tree crash report — ${new Date().toISOString()}`,
    `UA: ${typeof navigator === 'undefined' ? 'n/a' : navigator.userAgent}`,
    '',
    `${err.name}: ${err.message}`,
    err.stack ?? '(no stack)',
    '',
    '--- recent log ---',
    ...extra,
  ].join('\n');
}

let shown = false;

/** Friendly full-screen crash page with Copy-log / Reload buttons. Unsaved work stays in the autosave store. */
export function showCrashScreen(error: unknown): void {
  if (shown || typeof document === 'undefined') return;
  shown = true;
  const report = formatCrashReport(error);
  const el = (tag: string, cls: string, text = ''): HTMLElement => {
    const n = document.createElement(tag);
    n.className = cls;
    n.textContent = text;
    return n;
  };
  const card = el('div', 'kt-crash-card');
  const log = el('pre', 'kt-crash-log', report);
  const copy = el('button', 'kt-lib-btn', 'Copy log');
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(report).then(() => (copy.textContent = 'Copied'));
  });
  const reload = el('button', 'kt-lib-btn primary', 'Reload (restores autosave)');
  reload.addEventListener('click', () => location.reload());
  const actions = el('div', 'kt-crash-actions');
  actions.append(reload, copy);
  card.append(el('h1', '', 'Something went wrong'), el('p', '', 'Kekenik Tree hit an unexpected error. Your work was autosaved; reload to recover it. Please attach the log if you report this.'), log, actions);
  const root = el('div', 'kt-crash');
  root.append(card);
  document.body.append(root);
}

/** Route uncaught errors and unhandled rejections to the crash screen. Returns a detach function. */
export function installCrashHandler(): () => void {
  const onError = (e: ErrorEvent): void => {
    // Browsers report benign ResizeObserver loop notices as window errors without an Error object.
    if (!e.error && /ResizeObserver/.test(e.message)) return;
    showCrashScreen(e.error ?? e.message);
  };
  const onRejection = (e: PromiseRejectionEvent): void => showCrashScreen(e.reason);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
