import type { CommandRegistry } from './commands';

export interface ParsedShortcut {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>;

const KEY_ALIASES: Record<string, string> = { space: ' ', esc: 'escape', del: 'delete' };

/** "Mod+Shift+Z" -> structured. `Mod` is Ctrl (or Cmd on macOS). */
export function parseShortcut(spec: string): ParsedShortcut {
  const parts = spec.split('+').map((p) => p.trim());
  const keyPart = (parts[parts.length - 1] ?? '').toLowerCase();
  const mods = parts.slice(0, -1).map((p) => p.toLowerCase());
  return {
    key: KEY_ALIASES[keyPart] ?? keyPart,
    mod: mods.includes('mod') || mods.includes('ctrl') || mods.includes('cmd'),
    shift: mods.includes('shift'),
    alt: mods.includes('alt'),
  };
}

export function matchesShortcut(e: KeyLike, s: ParsedShortcut): boolean {
  const mod = e.ctrlKey || e.metaKey;
  return e.key.toLowerCase() === s.key && mod === s.mod && e.shiftKey === s.shift && e.altKey === s.alt;
}

/** Human-readable label: "⇧⌘Z" on macOS, "Ctrl+Shift+Z" elsewhere. */
export function formatShortcut(spec: string, mac: boolean): string {
  const p = parseShortcut(spec);
  const key = p.key === ' ' ? 'Space' : p.key.length === 1 ? p.key.toUpperCase() : p.key.charAt(0).toUpperCase() + p.key.slice(1);
  if (mac) return `${p.alt ? '⌥' : ''}${p.shift ? '⇧' : ''}${p.mod ? '⌘' : ''}${key}`;
  return [p.mod ? 'Ctrl' : '', p.alt ? 'Alt' : '', p.shift ? 'Shift' : '', key].filter(Boolean).join('+');
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

/** Global keyboard shortcut dispatcher bound to the command registry. */
export function attachShortcuts(commands: CommandRegistry): () => void {
  const handler = (e: KeyboardEvent): void => {
    if (isTyping(e.target)) return;
    for (const cmd of commands.list()) {
      if (!cmd.shortcut || cmd.scope || (cmd.enabled && !cmd.enabled())) continue;
      if ([cmd.shortcut, ...(cmd.extraShortcuts ?? [])].some((spec) => matchesShortcut(e, parseShortcut(spec)))) {
        e.preventDefault();
        commands.run(cmd.id);
        return;
      }
    }
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}
