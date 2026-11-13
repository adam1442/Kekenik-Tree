import { Group, type Mesh } from 'three';
import type { SceneModel } from '@/contracts/engine';
import type { EditMode } from '@/contracts/app';
import type { InstanceRef } from '@/instances/types';
import type { Viewport } from '../viewport';
import { AttachmentLayer } from './attachmentLayer';
import { OutlineLayer } from './outlineLayer';
import { SpineLayer, type SpineItem } from './spineLayer';

export interface OverlayState {
  /** Selected graph node ids. */
  nodes: readonly string[];
  editMode: EditMode;
  instances: readonly InstanceRef[];
  hover: InstanceRef | null;
  spinesOnTop: boolean;
  /** Show > Attachment frames. */
  attachmentFrames?: boolean;
}

/**
 * The selection overlay pass of the viewport. One group, child of the scene root (NOT of the plant content), so the
 * View mode controller never sees it: outlines and spines look identical in Shaded, Wireframe, Normals, Lines...
 * It is rebuilt incrementally: `sync()` is called on selection / evaluation changes, replaces only its own objects and
 * disposes the old geometry. Hidden instances never draw (the spine layer reads the table flags).
 */
export class OverlaySystem {
  readonly group = new Group();
  private readonly outline: OutlineLayer;
  private readonly spines: SpineLayer;
  private readonly attachments: AttachmentLayer;
  private scene: SceneModel | null = null;
  private state: OverlayState = { nodes: [], editMode: 'generator', instances: [], hover: null, spinesOnTop: true };
  private readonly unhook: () => void;

  constructor(
    private readonly viewport: Viewport,
    private readonly surface: HTMLElement,
    private readonly meshOf: (nodeId: string) => Mesh | undefined,
  ) {
    this.group.name = 'SelectionOverlays';
    this.group.renderOrder = 990;
    this.outline = new OutlineLayer(this.group);
    this.spines = new SpineLayer(this.group);
    this.attachments = new AttachmentLayer(this.group);
    viewport.scene.add(this.group);
    this.unhook = viewport.addBeforeRender(() => {
      this.outline.setResolution(this.surface.clientWidth, this.surface.clientHeight);
      this.spines.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.attachments.setViewportHeight(this.surface.clientHeight);
    });
  }

  setScene(scene: SceneModel | null): void {
    this.scene = scene;
    this.sync();
  }

  setState(patch: Partial<OverlayState>): void {
    this.state = { ...this.state, ...patch };
    this.sync();
  }

  /** Rebuild the overlay objects for the current scene + selection. */
  sync(): void {
    const { nodes, editMode, instances, hover, spinesOnTop } = this.state;
    const scene = this.scene;
    const nodeMode = editMode === 'node';
    const instanceNodes = new Set(instances.map((i) => i.nodeId));
    // Node mode with picked instances: the instances carry the highlight, not the whole node.
    const outlined = new Set(nodes.filter((id) => !(nodeMode && instanceNodes.has(id))));
    this.outline.sync(outlined, this.meshOf);

    const items: SpineItem[] = [];
    if (scene) {
      for (const sk of scene.skeletons) {
        const selectedNode = nodes.includes(sk.nodeId);
        const picked = nodeMode ? instances.filter((i) => i.nodeId === sk.nodeId) : [];
        const hoverHere = nodeMode && hover && hover.nodeId === sk.nodeId ? hover : null;
        if (!selectedNode && picked.length === 0 && !hoverHere) continue;
        const table = sk.instances ?? null;
        const rows = new Set<number>();
        let hoverRow = -1;
        if (table) {
          const keys = new Set(picked.map((p) => p.key));
          for (let i = 0; i < table.count; i++) {
            if (keys.has(table.key[i] as number)) rows.add(i);
            if (hoverHere && table.key[i] === hoverHere.key) hoverRow = i;
          }
        }
        const instancesOnly = nodeMode && (picked.length > 0 || hoverHere !== null) && instanceNodes.size > 0;
        items.push({ nodeId: sk.nodeId, skeleton: sk.skeleton, table, selectedRows: rows, hoverRow, scope: instancesOnly ? 'instances' : 'all' });
      }
    }
    this.spines.rebuild(items, spinesOnTop);
    const sets = scene ? scene.skeletons.filter((sk) => sk.attachments).map((sk) => ({ nodeId: sk.nodeId, attachments: sk.attachments as NonNullable<typeof sk.attachments> })) : [];
    this.attachments.rebuild(sets, new Set(nodes), this.state.attachmentFrames === true);
    this.viewport.requestRender();
  }

  get outlineCount(): number {
    return this.outline.count;
  }

  /** Number of attachment triads currently drawn (tests / dev scene). */
  get attachmentFrameCount(): number {
    return this.attachments.frameCount;
  }

  get spineObjectCount(): number {
    return this.spines.objectCount;
  }

  dispose(): void {
    this.unhook();
    this.outline.dispose();
    this.spines.dispose();
    this.attachments.dispose();
    this.group.removeFromParent();
  }
}
