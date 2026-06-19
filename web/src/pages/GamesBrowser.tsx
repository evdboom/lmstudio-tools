import { Link } from "react-router-dom";
import { api } from "../api";
import { useAsync } from "../useAsync";

export function GamesBrowser() {
  const { data, error, loading } = useAsync(() => api.games(), []);

  return (
    <div className="page">
      <h1>Games</h1>
      {loading && <p>Loading…</p>}
      {error && <p className="error">Error: {error}</p>}
      <div className="card-grid" data-testid="games-grid">
        {data?.map((g) => (
          <Link key={g.id} to={`/game/${encodeURIComponent(g.id)}`} className="card" data-testid="game-card">
            <h2>{g.title}</h2>
            <p className="pitch">{g.pitch}</p>
            <div className="badges">
              <span className="badge">{g.authoring_mode}</span>
              <span className="badge subtle">{g.collections} collections</span>
              {g.uses_dice && <span className="badge subtle">dice</span>}
              {g.has_contract && <span className="badge subtle">contract</span>}
            </div>
            {g.concept && <p className="concept">{g.concept}</p>}
          </Link>
        ))}
      </div>
      {data && data.length === 0 && <p>No games found under games/.</p>}
    </div>
  );
}
