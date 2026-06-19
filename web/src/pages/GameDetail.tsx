import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { useAsync } from "../useAsync";
import { GraphView } from "../components/GraphView";
import { EntityPanel } from "../components/EntityPanel";
import type { GraphNode, GameDetailData } from "../api";

type Tab = "overview" | "collections" | "graph";

export function GameDetail() {
  const { id = "" } = useParams();
  const [tab, setTab] = useState<Tab>("overview");
  const [selected, setSelected] = useState<string | undefined>();

  const detail = useAsync(() => api.game(id), [id]);
  const graph = useAsync(() => api.graph(id), [id]);

  return (
    <div className="page detail">
      <div className="detail-main">
        <Link to="/" className="back">← Games</Link>
        <h1>{(detail.data?.manifest.title as string) ?? id}</h1>
        {detail.error && <p className="error">{detail.error}</p>}

        <nav className="tabs">
          {(["overview", "collections", "graph"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)} data-testid={`tab-${t}`}>
              {t}
            </button>
          ))}
        </nav>

        {tab === "overview" && detail.data && <Overview id={id} data={detail.data} />}
        {tab === "collections" && graph.data && (
          <Collections nodes={graph.data.nodes} onSelect={setSelected} />
        )}
        {tab === "graph" && graph.data && <GraphView data={graph.data} onSelect={setSelected} />}
      </div>

      {selected && <EntityPanel gameId={id} entityRef={selected} onClose={() => setSelected(undefined)} />}
    </div>
  );
}

function Overview({ id, data }: { id: string; data: GameDetailData }) {
  const m = data.manifest as Record<string, unknown>;
  const contract = data.runtime_contract as Record<string, unknown> | null;
  return (
    <div className="overview" data-testid="overview">
      <section>
        <h3>Manifest</h3>
        <dl>
          <dt>authoring_mode</dt><dd data-testid="authoring-mode">{String(m.authoring_mode)}</dd>
          <dt>pitch</dt><dd>{String(m.pitch ?? "")}</dd>
          {m.concept != null && (<><dt>concept</dt><dd>{String(m.concept)}</dd></>)}
          <dt>uses_dice</dt><dd>{String(Boolean((m.boot as Record<string, unknown>)?.uses_dice))}</dd>
        </dl>
      </section>

      {contract && (
        <section>
          <h3>Runtime contract</h3>
          <pre className="json">{JSON.stringify(contract, null, 2)}</pre>
        </section>
      )}

      <section>
        <h3>PLAY.md</h3>
        {Object.entries(data.play_sections).map(([name, body]) => (
          <div key={name} className="play-section">
            <h4>{name}</h4>
            <p>{body}</p>
          </div>
        ))}
      </section>

      <VerifyButton id={id} />
    </div>
  );
}

function VerifyButton({ id }: { id: string }) {
  const [result, setResult] = useState<Record<string, unknown> | undefined>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  return (
    <section>
      <h3>Verify</h3>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr(undefined);
          try {
            setResult(await api.verify(id));
          } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Running…" : "Run verify_campaign"}
      </button>
      {err && <p className="error">{err}</p>}
      {result && <pre className="json">{JSON.stringify(result, null, 2)}</pre>}
    </section>
  );
}

function Collections({ nodes, onSelect }: { nodes: GraphNode[]; onSelect: (ref: string) => void }) {
  const byCollection = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    const list = byCollection.get(n.collection) ?? [];
    list.push(n);
    byCollection.set(n.collection, list);
  }
  if (nodes.length === 0) return <p>No runtime entities.</p>;
  return (
    <div className="collections" data-testid="collections">
      {[...byCollection.entries()].map(([name, list]) => (
        <section key={name}>
          <h3>{name} <span className="subtle">({list.length})</span></h3>
          <table>
            <thead><tr><th>label</th><th>status</th><th>id</th></tr></thead>
            <tbody>
              {list.map((n) => (
                <tr key={n.id} onClick={() => onSelect(n.id)} className="row">
                  <td>{n.label}</td>
                  <td>{n.status ?? ""}</td>
                  <td className="subtle">{n.id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
