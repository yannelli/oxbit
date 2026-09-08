/** Serializable panel layout. Each contribution has exactly one home. */
export type DockSide = "left" | "right" | "bottom";
export type DropEdge = "center" | "left" | "right" | "top" | "bottom";
export interface PanelGroup {
  kind: "group";
  id: string;
  panels: string[];
  active: string;
}
export interface PanelSplit {
  kind: "split";
  id: string;
  direction: "row" | "column";
  ratio: number;
  children: [PanelNode, PanelNode];
}
export type PanelNode = PanelGroup | PanelSplit;
export interface PanelDock {
  visible: boolean;
  size: number;
  root?: PanelNode;
}
export interface PanelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface FloatingPanel {
  id: string;
  root: PanelNode;
  bounds: PanelBounds;
}
export interface PanelTarget {
  container: DockSide | string;
  group?: string;
  edge?: DropEdge;
  index?: number;
}
export interface PanelLayout {
  version: 1;
  docks: Record<DockSide, PanelDock>;
  floating: FloatingPanel[];
  returns: Record<string, PanelTarget>;
  activeDock: DockSide;
}
