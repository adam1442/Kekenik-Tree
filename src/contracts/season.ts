/** Season state handed down the hierarchy (Tree node -> generators). See `src/seasons`. */
export interface SeasonState {
  /** Slider value 0..1. */
  value: number;
  /** Sum of the Descendant offsets of this node and its ancestors (positive = later). */
  shift: number;
  /** Leaves that finished their life are drawn on the ground. */
  showDropped: boolean;
  /** Dropped leaves are part of the export. */
  exportDropped: boolean;
}
