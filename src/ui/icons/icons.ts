/**
 * Inline SVG icon registry. All icons are drawn in-house (24x24 grid, 1.5px round stroke, currentColor).
 * Add icons with registerIcon(); consume with icon(name, size).
 */
const ICONS = new Map<string, string>();

export function registerIcon(name: string, inner: string): void {
  ICONS.set(name, inner);
}

/** Raw inner SVG markup (24x24 grid) of a registered icon, for embedding inside other SVG documents. */
export function iconMarkup(name: string): string | undefined {
  return ICONS.get(name);
}

/** Returns a fresh <svg> element. Unknown names yield an empty placeholder square. */
export function icon(name: string, size = 16): SVGSVGElement {
  const holder = document.createElement('span');
  const inner = ICONS.get(name) ?? '<rect x="5" y="5" width="14" height="14" rx="2" stroke-dasharray="2 2"/>';
  holder.innerHTML =
    `<svg xmlns="http://www.w3.org/2000/svg" class="kt-icon" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  return holder.firstElementChild as SVGSVGElement;
}

const F = 'fill="currentColor" stroke="none"';

const BUILTIN: Record<string, string> = {
  logo: '<path d="M12 3c-3 3-5 5-5 8 0 1.5.6 2.600 1.500 3.300C7 14.500 6 15.700 6 17c0 2.200 2.700 3 6 3s6-.8 6-3c0-1.300-1-2.500-2.500-2.700.9-.7 1.500-1.800 1.500-3.300 0-3-2-5-5-8z"/><path d="M12 14v7"/>',
  plusSquare: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 8v8M8 12h8"/>',
  actions: '<path d="M5 4l5.500 14 2.300-5.700L18.500 10z"/><path d="M15 16.500l4.500 4"/>',
  dice: `<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.100" ${F}/><circle cx="15" cy="9" r="1.100" ${F}/><circle cx="12" cy="12" r="1.100" ${F}/><circle cx="9" cy="15" r="1.100" ${F}/><circle cx="15" cy="15" r="1.100" ${F}/>`,
  gear: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="6.500"/><path d="M12 2.500v3M12 18.500v3M2.500 12h3M18.500 12h3M5.300 5.300l2 2M16.700 16.700l2 2M18.700 5.300l-2 2M7.300 16.700l-2 2"/>',
  float: '<rect x="8.500" y="4" width="11.500" height="11.500" rx="1.500"/><path d="M15.500 19.500H6.500a2 2 0 0 1-2-2v-9"/>',
  dock: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9h16"/>',
  minimize: '<path d="M6 17h12"/>',
  maximize: '<rect x="6" y="6" width="12" height="12" rx="1.500"/>',
  close: '<path d="M6.500 6.500l11 11M17.500 6.500l-11 11"/>',
  menu: '<path d="M5 7h14M5 12h14M5 17h14"/>',
  chevronDown: '<path d="M6.500 9.500l5.500 5.500 5.500-5.500"/>',
  chevronRight: '<path d="M9.500 6.500l5.500 5.500-5.500 5.500"/>',
  pencil: '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>',
  leaf: '<path d="M5 19C5 10 10 5 19 5c0 9-5 14-14 14z"/><path d="M5 19l8-8"/>',
  leafCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 16c0-4 2-6.500 7-7 0 4.500-2.500 7-7 7z"/>',
  nodes: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7.500 7.500l3.500 8M16.500 9.500l-3.500 7"/>',
  brush: '<path d="M18.500 3.500l2 2-8.500 8.500-3-3z"/><path d="M9 11c-3 0-4.500 2-4.500 4 0 2-1 3.500-1 3.500s5.500 1 7.500-1c1-1 1.500-3 .5-4"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M15.500 15.500l4.500 4.500"/>',
  globe: '<circle cx="12" cy="12" r="8.500"/><path d="M3.500 12h17M12 3.500c3.500 3.500 3.500 13.500 0 17M12 3.500c-3.500 3.500-3.500 13.500 0 17"/>',
  eye: '<path d="M2.500 12S6 5.500 12 5.500 21.500 12 21.500 12 18 18.500 12 18.500 2.500 12 2.500 12z"/><circle cx="12" cy="12" r="3"/>',
  cube: '<path d="M12 3l8 4.500v9L12 21l-8-4.500v-9z"/><path d="M12 12l8-4.500M12 12v9M12 12L4 7.500"/>',
  wind: '<path d="M3 9h10a2.500 2.500 0 1 0-2.500-2.500M3 14h14a2.500 2.500 0 1 1-2.500 2.500M3 19h6"/><path d="M18 4l1 1.500M20.500 6.500L22 7"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2.500M12 18.500V21M3 12h2.500M18.500 12H21M5.600 5.600l1.800 1.800M16.600 16.600l1.800 1.800M18.400 5.600l-1.800 1.800M7.400 16.600l-1.800 1.800"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  toolNodes: '<circle cx="8" cy="8" r="2.500"/><circle cx="17" cy="9" r="2.500"/><circle cx="12" cy="17" r="2.500"/><path d="M10 9.500l1.500 5M15 11l-2 4"/>',
  toolPaint: '<rect x="4.500" y="4.500" width="15" height="15" rx="2"/><path d="M4.500 14.500l5-4 4 3 6-4.500"/>',
  toolMeasure: '<rect x="3" y="9" width="18" height="6" rx="1"/><path d="M7 9v3M11 9v2M15 9v3"/>',
  discs: '<circle cx="10" cy="10" r="6"/><circle cx="15" cy="14" r="6"/>',
  disc: '<circle cx="12" cy="12" r="8"/><path d="M8 12h8"/>',
  expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
  shrink: '<path d="M20 4l-6 6M14 5v5h5M4 20l6-6M10 19v-5H5"/>',
  plusMinus: '<path d="M5 8h6M8 5v6M5 17h6"/><path d="M19 6L11 20"/>',
  hand: '<path d="M8 12V6.500a1.500 1.500 0 0 1 3 0V11M11 11V4.500a1.500 1.500 0 0 1 3 0V11M14 11V6.500a1.500 1.500 0 0 1 3 0V14c0 4-2 6-5 6s-4-1-6-4l-2-3.500a1.500 1.500 0 0 1 2.500-1.500L8 14"/>',
  clipboard: '<rect x="6" y="5" width="12" height="16" rx="2"/><path d="M9 5V3.500h6V5"/>',
  layers: '<path d="M12 4l9 5-9 5-9-5z"/><path d="M3 14l9 5 9-5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  check: '<path d="M5 12.500l4.500 4.500L19 7.500"/>',
  dotsV: `<circle cx="12" cy="5.500" r="1.400" ${F}/><circle cx="12" cy="12" r="1.400" ${F}/><circle cx="12" cy="18.500" r="1.400" ${F}/>`,
  arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  magnet: '<path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z"/><path d="M6 8h4M14 8h4"/>',
  materials: '<circle cx="9" cy="9" r="5"/><circle cx="15" cy="9" r="5"/><circle cx="12" cy="15" r="5"/>',
  camera: '<rect x="3" y="7" width="18" height="12" rx="2"/><circle cx="12" cy="13" r="3.500"/><path d="M9 7l1-2h4l1 2"/>',
  meshList: '<path d="M4 6h3M4 12h3M4 18h3M10 6h10M10 12h10M10 18h10"/>',
  path: '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M7.500 16.500l9-9"/>',
  curveList: '<path d="M5 7h10M5 12h14M5 17h8"/>',
  curve: '<path d="M4 18c4 0 3-12 8-12s4 12 8 12"/>',
  draw: '<path d="M4 20l1-4L16 5l3 3L8 19z"/>',
  addCircle: '<circle cx="12" cy="12" r="8"/><path d="M12 8v8M8 12h8"/>',
  selectBox: '<rect x="4.500" y="4.500" width="15" height="15" rx="1" stroke-dasharray="3 2.500"/>',
  removeDiamond: '<path d="M12 4l8 8-8 8-8-8z"/><path d="M8.500 12h7"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.500-5.800"/><path d="M4 5v5h5"/>',
  mirror: '<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 6L4 18h5zM15 6l5 12h-5z"/>',
  generate: '<circle cx="6" cy="8" r="2"/><circle cx="17" cy="6" r="2"/><circle cx="18" cy="17" r="2"/><circle cx="8" cy="18" r="2"/><path d="M7.500 9.500l1 7M8 7.500l7-1M16 8l1 7M10 17.500l6 0"/>',
  editNodes: '<circle cx="6" cy="17" r="2"/><circle cx="12" cy="8" r="2"/><circle cx="19" cy="15" r="2"/><path d="M7 15l4-5M13.500 9.500l4.500 4"/>',
  linear: '<circle cx="5" cy="19" r="2"/><circle cx="19" cy="5" r="2"/><path d="M6.500 17.500l11-11"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.500-5.800"/><path d="M4 5v5h5M12 8v4l3 2"/>',
  clearFill: '<path d="M4 20l1-4L15 6l3 3L8 19z"/><path d="M14 20h6"/>',
  bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.500 10.900c.700.600 1 1.300 1 2.100h5c0-.800.300-1.500 1-2.100A6 6 0 0 0 12 3z"/>',
  sunDir: '<circle cx="12" cy="12" r="3.500"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.600 5.600l2 2M16.400 16.400l2 2M18.400 5.600l-2 2"/><path d="M12 12l5-5"/>',
  tangentAuto: '<path d="M3 17C7 17 8 7 12 7s5 10 9 10"/><circle cx="12" cy="7" r="2"/>',
  tangentLinear: '<path d="M4 18L12 6l8 12"/><circle cx="12" cy="6" r="2"/>',
  tangentStep: '<path d="M4 17h8V7h8"/><circle cx="12" cy="7" r="2"/>',
  tangentFlat: '<path d="M4 12h16"/><circle cx="12" cy="12" r="2.2"/><circle cx="5" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  tangentAligned: '<path d="M4 16L20 8"/><circle cx="12" cy="12" r="2.2"/><circle cx="5" cy="15.5" r="1.4"/><circle cx="19" cy="8.5" r="1.4"/>',
  tangentMirrored: '<path d="M5 15.5L19 8.5"/><circle cx="12" cy="12" r="2.2"/><rect x="3.5" y="14" width="3" height="3"/><rect x="17.5" y="7" width="3" height="3"/>',
  tangentFree: '<path d="M5 17l7-7 7 5"/><circle cx="12" cy="10" r="2.2"/><circle cx="5" cy="17" r="1.4"/><circle cx="19" cy="15" r="1.4"/>',
  flipH: '<path d="M12 4v16" stroke-dasharray="2 2"/><path d="M4 8l5 4-5 4V8zM20 8l-5 4 5 4V8z"/>',
  flipV: '<path d="M4 12h16" stroke-dasharray="2 2"/><path d="M8 4l4 5 4-5H8zM8 20l4-5 4 5H8z"/>',
  fitView: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><circle cx="12" cy="12" r="2"/>',
  eyedropper: '<path d="M14.5 5.5l4 4M4 20l4-1 9.5-9.5a1.5 1.5 0 0 0 0-2.1l-1.9-1.9a1.5 1.5 0 0 0-2.1 0L4 15l-1 5z"/>',
  ramp: '<rect x="3" y="6" width="18" height="8" rx="1.5"/><path d="M7 14l-2 4h4zM17 14l-2 4h4z"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  reload: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M20 4.5v5h-5"/>',
  export: '<path d="M12 15V4M8 8l4-4 4 4"/><path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>',
  stub: '<rect x="5" y="5" width="14" height="14" rx="2" stroke-dasharray="2 2"/>',
};

for (const [name, inner] of Object.entries(BUILTIN)) registerIcon(name, inner);
