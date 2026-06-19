import { useMemo } from "react";
import { ReactFlow, Background, Controls, type Node, type Edge, MarkerType } from "@xyflow/react";
import dagre from "dagre";
import type { GraphData } from "../api";

const COLORS = ["#4f7cff", "#e0563a", "#2fae6b", "#b765d6", "#d6a13a", "#3ab6d6", "#d63a8a"];

function colorFor(collection: string, collections: string[]): string {
  const i = collections.indexOf(collection);
  return COLORS[i % COLORS.length];
}

function layout(data: GraphData, collections: string[]): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 80 });

  const W = 170;
  const H = 44;
  for (const n of data.nodes) g.setNode(n.id, { width: W, height: H });
  // Only lay out edges whose endpoints are real nodes.
  const ids = new Set(data.nodes.map((n) => n.id));
  for (const e of data.edges) if (ids.has(e.from) && ids.has(e.to)) g.setEdge(e.from, e.to);
  dagre.layout(g);

  const nodes: Node[] = data.nodes.map((n) => {
    const pos = g.node(n.id);
    return {
      id: n.id,
      position: { x: pos.x - W / 2, y: pos.y - H / 2 },
      data: { label: `${n.label}${n.status ? ` · ${n.status}` : ""}` },
      style: {
        background: colorFor(n.collection, collections),
        color: "white",
        border: "none",
        borderRadius: 8,
        fontSize: 12,
        width: W,
      },
    };
  });

  const edges: Edge[] = data.edges
    .filter((e) => ids.has(e.from) && ids.has(e.to))
    .map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      label: e.type,
      labelStyle: { fontSize: 10 },
      markerEnd: { type: MarkerType.ArrowClosed },
    }));

  return { nodes, edges };
}

export function GraphView({ data, onSelect }: { data: GraphData; onSelect: (ref: string) => void }) {
  const collections = useMemo(() => [...new Set(data.nodes.map((n) => n.collection))], [data]);
  const { nodes, edges } = useMemo(() => layout(data, collections), [data, collections]);

  if (data.nodes.length === 0) return <p>This game has no runtime entities yet.</p>;

  return (
    <div className="graph" data-testid="graph">
      <div className="legend">
        {collections.map((c) => (
          <span key={c} className="legend-item">
            <i style={{ background: colorFor(c, collections) }} /> {c}
          </span>
        ))}
      </div>
      <div className="graph-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          onNodeClick={(_e, node) => onSelect(node.id)}
          nodesDraggable={false}
          nodesConnectable={false}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
