// Thin client for the read-only management API.

export interface GameSummary {
  id: string;
  title: string;
  pitch: string;
  authoring_mode: string;
  concept: string | null;
  collections: number;
  has_contract: boolean;
  uses_dice: boolean;
}

export interface GameDetailData {
  id: string;
  manifest: Record<string, unknown>;
  play_sections: Record<string, string>;
  runtime_contract: Record<string, unknown> | null;
  state: Record<string, unknown>;
}

export interface GraphNode {
  id: string;
  collection: string;
  label: string;
  status: string | null;
}
export interface GraphEdge {
  id: string;
  from: string;
  type: string;
  to: string;
}
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const body = (await res.json()) as { ok: boolean; data?: T; error?: string };
  if (!body.ok) throw new Error(body.error ?? `Request failed: ${path}`);
  return body.data as T;
}

export const api = {
  games: () => get<GameSummary[]>("/api/games"),
  game: (id: string) => get<GameDetailData>(`/api/games/${encodeURIComponent(id)}`),
  graph: (id: string) => get<GraphData>(`/api/games/${encodeURIComponent(id)}/graph`),
  entity: (id: string, ref: string) =>
    get<Record<string, unknown>>(`/api/games/${encodeURIComponent(id)}/entity?ref=${encodeURIComponent(ref)}`),
  verify: (id: string) => get<Record<string, unknown>>(`/api/games/${encodeURIComponent(id)}/verify`),
};
