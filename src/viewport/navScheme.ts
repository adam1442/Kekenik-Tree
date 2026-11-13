export type NavScheme = 'kekenik' | 'maya' | 'blender';
export type NavMode = 'orbit' | 'pan' | 'dolly' | null;

export const NAV_SCHEMES: readonly { id: NavScheme; label: string; help: string }[] = [
  { id: 'kekenik', label: 'Kekenik', help: 'LMB orbit · Shift+LMB / MMB pan · RMB drag dolly' },
  { id: 'maya', label: 'Maya-like', help: 'Alt+LMB orbit · Alt+MMB pan · Alt+RMB dolly' },
  { id: 'blender', label: 'Blender-like', help: 'MMB orbit · Shift+MMB pan · Ctrl+MMB dolly' },
];

interface PointerLike {
  button: number;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
}

/** Pure mapping from a pointer-down event to a camera drag mode for a navigation scheme. */
export function resolveNavMode(scheme: NavScheme, e: PointerLike): NavMode {
  switch (scheme) {
    case 'maya':
      if (!e.altKey) return null;
      return e.button === 0 ? 'orbit' : e.button === 1 ? 'pan' : e.button === 2 ? 'dolly' : null;
    case 'blender':
      if (e.button !== 1) return null;
      return e.ctrlKey ? 'dolly' : e.shiftKey ? 'pan' : 'orbit';
    default:
      if (e.button === 1) return 'pan';
      if (e.button === 2) return 'dolly';
      return e.button === 0 ? (e.shiftKey ? 'pan' : 'orbit') : null;
  }
}

let active: NavScheme = 'kekenik';
export const getNavScheme = (): NavScheme => active;
export const setNavScheme = (s: NavScheme): void => {
  active = s;
};
