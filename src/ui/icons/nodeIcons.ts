import { registerIcon } from './icons';

/**
 * Node glyphs: bold white shapes drawn on the 24x24 grid, meant to sit inside a coloured round node
 * (the host element sets `color: white`). Drawn in-house.
 */
const FILL = 'fill="currentColor" stroke="none"';

const NODE_ICONS: Record<string, string> = {
  nodeTree: `<path d="M5.500 14a3.500 3.500 0 0 1 1.800-6.500 4.800 4.800 0 0 1 9.200-.2A3.500 3.500 0 0 1 18.500 14z" ${FILL}/><path d="M12 13.500v5.500" stroke-width="2.200"/>`,
  nodeBranch: '<path d="M12 19v-7.500M12 11.500L7 6M12 11.500L17 6M12 15.500l-3.500-3.500" stroke-width="2.500"/>',
  nodeRoot: '<path d="M12 5v7.500M12 12.500L7 18M12 12.500L17 18M12 8.500l3.500 3.500" stroke-width="2.500"/>',
  nodeSplit: '<path d="M12 19v-6.500M12 12.500L6.500 6M12 12.500L17.500 6" stroke-width="2.500"/>',
  nodeKnot: '<path d="M9 19V5" stroke-width="2.400"/><circle cx="13.800" cy="12" r="3.600" stroke-width="2.100"/><circle cx="14.200" cy="12" r="1.200" fill="currentColor" stroke="none"/>',
  nodeSpine: '<path d="M10 19c0-4.500 4-5.500 4-9.500 0-2-1.200-3.500-2-4.500" stroke-width="2.200" stroke-dasharray="2.5 2"/><circle cx="10" cy="19" r="1.600" fill="currentColor" stroke="none"/><circle cx="12" cy="5" r="1.600" fill="currentColor" stroke="none"/>',
  nodeLeaf: `<path d="M6.500 17C6.500 9.500 11 5.500 18 5.500c0 7.500-3.500 12-11.500 11.500z" ${FILL}/>`,
  nodeFrond: '<path d="M12 19V5M12 9l-4-2.500M12 9l4-2.500M12 13l-5-2.500M12 13l5-2.500M12 17l-4.500-2M12 17l4.500-2" stroke-width="1.900"/>',
  nodeDecoration: `<path d="M5 17.500c1.500-4 4.500-6 7-6s5.500 2 7 6z" ${FILL}/><path d="M9 8.500h6M12 8.500V6" stroke-width="1.800"/><circle cx="7.500" cy="8" r="1.200" ${FILL}/><circle cx="16.800" cy="7" r="1.200" ${FILL}/>`,
  nodeCap: '<circle cx="12" cy="12" r="6.500" stroke-width="1.800"/><circle cx="12" cy="12" r="3" stroke-width="1.600"/>',
  nodeCluster: `<circle cx="9" cy="14" r="3.200" ${FILL}/><circle cx="15.500" cy="14" r="3.200" ${FILL}/><circle cx="12.200" cy="8.500" r="3.200" ${FILL}/>`,
  nodeSleep: '<path d="M7 7.500h5l-5 6h5M13.500 12.500h4l-4 5h4" stroke-width="1.800"/>',
  nodeForce: '<path d="M5.500 12h11M12.500 7l5 5-5 5" stroke-width="2.200"/>',
  nodeMaterial: '<circle cx="12" cy="12" r="6.500" stroke-width="1.800"/><path d="M8.500 10.500a4 4 0 0 1 3-3" stroke-width="1.600"/>',
  nodeMesh: '<path d="M12 5l6 3.200v7.600L12 19l-6-3.200V8.200zM12 12v7M12 12L6 8.200M12 12l6-3.800" stroke-width="1.700"/>',
  nodeModifier: '<path d="M6 17.500L17.500 6M13 6h4.500V10.500M6 12v5.500h5.500" stroke-width="2"/>',
  nodeUtility: '<circle cx="12" cy="12" r="2.800" stroke-width="1.800"/><path d="M12 5v2.500M12 16.500V19M5 12h2.500M16.500 12H19" stroke-width="1.800"/>',
  nodeWind: '<path d="M4.500 9.500h9a2.500 2.500 0 1 0-2.500-2.500M4.500 14.500h12a2.500 2.500 0 1 1-2.500 2.500" stroke-width="1.900"/>',
};

for (const [name, inner] of Object.entries(NODE_ICONS)) registerIcon(name, inner);
