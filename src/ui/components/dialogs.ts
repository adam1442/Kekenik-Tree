import { h } from './dom';
import { FloatingWindow } from './floatingWindow';

/** Small modal dialogs built on the shared FloatingWindow primitive. */

function centered(layer: HTMLElement, w: number, hgt: number): { x: number; y: number; w: number; h: number } {
  return { x: Math.max(0, (layer.clientWidth - w) / 2), y: Math.max(0, (layer.clientHeight - hgt) / 3), w, h: hgt };
}

export function showInfoDialog(layer: HTMLElement, title: string, content: HTMLElement, size = { w: 420, h: 300 }): FloatingWindow {
  const win = new FloatingWindow({
    title,
    container: layer,
    rect: centered(layer, size.w, size.h),
    minSize: { w: 280, h: 160 },
    minimizable: false,
    maximizable: false,
    modal: true,
    className: 'kt-info-dialog',
    onClose: () => win.dispose(),
  });
  const ok = h('button', 'kt-em-btn primary', 'OK');
  ok.addEventListener('click', () => win.close());
  win.body.append(h('div', 'kt-info-content', content), h('div', 'kt-em-footer', h('div', 'kt-em-spacer'), ok));
  return win;
}

export function showPromptDialog(layer: HTMLElement, title: string, initial: string, onSubmit: (value: string) => void): void {
  const input = h('input', 'kt-field kt-prompt-input');
  input.value = initial;
  const win = new FloatingWindow({
    title,
    container: layer,
    rect: centered(layer, 340, 130),
    minSize: { w: 280, h: 120 },
    resizable: false,
    minimizable: false,
    maximizable: false,
    modal: true,
    className: 'kt-info-dialog',
    onClose: () => win.dispose(),
  });
  const submit = (): void => {
    const v = input.value.trim();
    if (v) onSubmit(v);
    win.close();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') win.close();
  });
  const cancel = h('button', 'kt-em-btn', 'Cancel');
  const ok = h('button', 'kt-em-btn primary', 'OK');
  cancel.addEventListener('click', () => win.close());
  ok.addEventListener('click', submit);
  win.body.append(h('div', 'kt-info-content', input), h('div', 'kt-em-footer', h('div', 'kt-em-spacer'), cancel, ok));
  input.focus();
  input.select();
}

export interface ChoiceButton {
  label: string;
  primary?: boolean;
}

/** Modal message with several buttons. Resolves with the clicked button's index, or -1 when the window is closed. */
export function showChoiceDialog(layer: HTMLElement, title: string, message: string, buttons: ChoiceButton[]): Promise<number> {
  return new Promise((resolve) => {
    let result = -1;
    const win = new FloatingWindow({
      title,
      container: layer,
      rect: centered(layer, 420, 150),
      minSize: { w: 300, h: 130 },
      resizable: false,
      minimizable: false,
      maximizable: false,
      modal: true,
      className: 'kt-info-dialog',
      onClose: () => {
        win.dispose();
        resolve(result);
      },
    });
    const footer = h('div', 'kt-em-footer', h('div', 'kt-em-spacer'));
    buttons.forEach((b, i) => {
      const btn = h('button', `kt-em-btn${b.primary ? ' primary' : ''}`, b.label);
      btn.addEventListener('click', () => {
        result = i;
        win.close();
      });
      footer.append(btn);
    });
    win.body.append(h('div', 'kt-info-content', message), footer);
  });
}

/** Promise flavour of showPromptDialog: resolves the entered text, or null when cancelled. */
export function askText(layer: HTMLElement, title: string, initial: string): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    showPromptDialog(layer, title, initial, (v) => {
      done = true;
      resolve(v);
    });
    // The prompt has no cancel callback: resolve null once its window leaves the DOM without a submit.
    const watch = new MutationObserver(() => {
      if (layer.querySelector('.kt-prompt-input')) return;
      watch.disconnect();
      if (!done) resolve(null);
    });
    watch.observe(layer, { childList: true, subtree: true });
  });
}
