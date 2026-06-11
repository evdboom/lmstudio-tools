# lmstudio-tools

A local **MCP (Model Context Protocol)** server that gives an LM Studio model
sandboxed filesystem tools scoped to a single folder you choose. It speaks
**stdio** so it plugs into LM Studio's built-in MCP client.

## Tools exposed

| Tool            | Purpose                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `list_files`    | List files (non-recursive) in a directory.                              |
| `list_folders`  | List subfolders (non-recursive) in a directory.                         |
| `read_file`     | Read the UTF-8 contents of a file.                                      |
| `add_file`      | Create a new file. **Fails if the file already exists.**                |
| `replace_file`  | Overwrite an existing file's contents. **Fails if it does not exist.**  |
| `append_file`   | Append text to a file. Creates the file if missing.                     |
| `add_folder`    | Create a new folder. Parents are created automatically.                 |
| `remove_file`   | Delete a single file.                                                   |
| `remove_folder` | Delete a folder. Set `recursive: true` to delete non-empty folders.     |

All paths are **relative to the sandbox root**. Absolute paths and any path that
resolves outside the root (including via symlinks) are rejected.

## Requirements

- **Node.js 18.17+** (Node 20 LTS or newer recommended)
- **LM Studio** with MCP support (recent versions; check **Program → Edit
  mcp.json**)

## Install

```powershell
cd C:\repo\LmStudioTools
npm install
npm run build
```

This produces `dist/index.js`, the entry point used by LM Studio.

### Quick sanity check (optional)

Run the server against a throwaway folder and pipe an MCP `tools/list` request
to confirm it boots:

```powershell
mkdir C:\tmp\mcp-sandbox -Force | Out-Null
node .\dist\index.js --root C:\tmp\mcp-sandbox
```

You should see `lmstudio-tools MCP server ready. Root: C:\tmp\mcp-sandbox` on
stderr. The server reads MCP JSON-RPC over stdin; press `Ctrl+C` to exit.

## Configure LM Studio

1. Open **LM Studio**.
2. Go to **Program → Edit mcp.json** (sidebar entry may also be labelled
   *MCP Servers* depending on version).
3. Add an entry under `mcpServers`. Replace the paths with your own:

```json
{
  "mcpServers": {
    "lmstudio-tools": {
      "command": "node",
      "args": [
        "C:\\repo\\LmStudioTools\\dist\\index.js",
        "--root",
        "C:\\path\\to\\your\\sandbox"
      ]
    }
  }
}
```

4. Save. LM Studio launches the server on demand.
5. Open a chat with a tool-capable model and confirm the `lmstudio-tools` tools
   appear in the tools panel.

### Alternative: env var instead of `--root`

```json
{
  "mcpServers": {
    "lmstudio-tools": {
      "command": "node",
      "args": ["C:\\repo\\LmStudioTools\\dist\\index.js"],
      "env": {
        "MCP_ROOT": "C:\\path\\to\\your\\sandbox"
      }
    }
  }
}
```

`--root` wins if both are set.

## Sandboxing

- All input paths must be **relative** to the configured root.
- Paths are resolved with `path.resolve` then verified to remain inside the
  root.
- The deepest existing ancestor is `realpath`'d to block symlink escapes.
- `remove_folder` refuses to delete the sandbox root itself.
- The process inherits OS file permissions of the user running LM Studio,
  so pick a root the model is allowed to touch and nothing more.

## Development

Run from source without building:

```powershell
npm run dev -- --root C:\tmp\mcp-sandbox
```

Edit `src/*.ts`, then `npm run build` and restart LM Studio's MCP server
entry (toggle it off/on in `mcp.json`, or restart LM Studio) so the new
`dist/index.js` is loaded.

## Tests

The project ships a `vitest` suite covering three layers:

| File                          | Focus                                                                |
| ----------------------------- | -------------------------------------------------------------------- |
| `test/sandbox.test.ts`        | `safeResolve`: `..` traversal, absolute paths, NUL bytes, symlink escape. |
| `test/tools.test.ts`          | Each tool: happy path + error paths + escape attempts via the tool.  |
| `test/integration.test.ts`    | Spawn the server, do MCP handshake, exercise the tools over stdio.   |

Run them:

```powershell
npm test
```

Symlink tests gracefully skip on Windows machines without Developer Mode or
admin rights (where `fs.symlink` returns `EPERM`).

## Project layout

```
package.json           # npm metadata + scripts + deps
tsconfig.json          # TypeScript compiler config
vitest.config.ts       # test runner config
src/sandbox.ts         # path-resolution + escape guards
src/tools.ts           # filesystem operations (pure async fns)
src/index.ts           # MCP server wiring + CLI entry
test/                  # vitest suites + helpers
dist/index.js          # built entry point (after npm run build)
```

## License

MIT
