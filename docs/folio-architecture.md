# Folio TypeScript Map

This is the short version of how the Folio reader and story authoring pieces fit together.

```mermaid
flowchart LR
  subgraph UI[Browser]
    main[reader/src/main.tsx\nReader UI and SSE client]
    authoring[reader/src/authoring.tsx\nBlueprint editor UI]
  end

  subgraph Reader[Folio reader runtime]
    server[src/reader-server.ts\nHTTP routes, auth, SSE]
    service[src/reader-service.ts\nRun lifecycle and generation decisions]
    prompts[src/reader-prompts.ts\nNarration and review prompts]
    design[src/reader-*-design.ts\nAI-assisted beat/character/location drafts]
    client[src/lmstudio-client.ts\nLM Studio HTTP streaming]
    readerStore[src/reader-store.ts\nRun JSON persistence]
  end

  subgraph Story[Shared story layer]
    model[src/story-model.ts\nSchemas, types, validation, budgets]
    storyStore[src/story-store.ts\nAtomic story.json and run file I/O]
    editor[src/story-editor.ts\nEditable blueprint operations]
    state[src/story-state.ts\nBeat state and history derivation]
    authoringLogic[src/story-authoring.ts\nAuthoring mutations and rules]
  end

  subgraph MCP[Separate MCP server]
    teller[src/story-teller-index.ts\nMCP tool registration and transport]
  end

  main -->|/api| server
  authoring -->|/api/editor| server
  server --> service
  server --> editor
  server --> design
  server --> client
  service --> prompts
  service --> readerStore
  service --> storyStore
  prompts --> model
  design --> model
  design --> state
  readerStore --> storyStore
  readerStore --> model
  editor --> storyStore
  editor --> model
  state --> model
  authoringLogic --> storyStore
  authoringLogic --> model
  teller --> authoringLogic
  teller --> editor
  teller --> model
  client -->|LM Studio API| LM[LM Studio]
  storyStore --> Files[(story.json and runs/*.json)]
```

## Responsibility key

| File | Owns |
| --- | --- |
| `reader-server.ts` | Fastify routes, authentication, SSE lifecycle, and wiring dependencies together. |
| `reader-service.ts` | Reader run rules: prepare prompts, accept/regenerate/review beats, and update run state. |
| `reader-store.ts` | The reader run format and persistence of `runs/<uuid>.json`. |
| `reader-prompts.ts` | Context-mode-specific narration prompts and reasoning parsing. |
| `lmstudio-client.ts` | The network protocol for listing models and streaming LM Studio responses. |
| `story-model.ts` | The canonical `story-v3` schema, types, validation, and beat-budget helpers. |
| `story-store.ts` | Safe filesystem access and atomic reads/writes for `story.json` and run files. |
| `story-editor.ts` | Read/save/list operations for editable story blueprints. |
| `story-authoring.ts` | Domain operations used by authoring tools: create, add, validate, and finalize. |
| `story-state.ts` | Derived state and history calculations used when constructing reader context. |
| `story-teller-index.ts` | MCP-facing registration for authoring and telling tools; it delegates domain work. |

The `reader/` TypeScript files are the browser client. The root `src/` files are the server, domain, and persistence layers. `tools.ts`, `skills.ts`, `workflow.ts`, `sandbox.ts`, and related files are the separate general-purpose MCP servers, not part of the Folio reader request path.