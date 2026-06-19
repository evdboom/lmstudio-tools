import { api } from "../api";
import { useAsync } from "../useAsync";

export function EntityPanel({ gameId, entityRef, onClose }: { gameId: string; entityRef: string; onClose: () => void }) {
  const { data, error, loading } = useAsync(() => api.entity(gameId, entityRef), [gameId, entityRef]);
  return (
    <aside className="entity-panel" data-testid="entity-panel">
      <div className="entity-panel-head">
        <strong>{entityRef}</strong>
        <button onClick={onClose} aria-label="Close">×</button>
      </div>
      {loading && <p>Loading…</p>}
      {error && <p className="error">{error}</p>}
      {data && <pre className="json">{JSON.stringify(data, null, 2)}</pre>}
    </aside>
  );
}
