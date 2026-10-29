# lmstudio-tools

MCP servers for LM Studio with three focused surfaces:

- `lmstudio-tools`: sandboxed filesystem and JSON/plan helpers
- `lmstudio-skills`: skills loading plus markdown workflow execution
- `story-teller-mcp`: strict story authoring and beat-by-beat telling runtime

The repository also includes `story-reader`, a local scrolling reader that calls LM Studio's HTTP API directly. It is independent of the MCP telling tools.

## Scope

This repository now focuses on:

- file tools (`src/index.ts`)
- skills and workflow framework (`src/skills-index.ts`, `src/workflow.ts`)
- story authoring and telling (`src/story-teller-index.ts`, `src/story-telling.ts`)
- direct-API story reading (`src/reader-server.ts`, `reader/`)

Game runtime and game-specific workflow content were removed.

## Prerequisites

- Node.js 18.17 or newer
- npm
- LM Studio 0.3.17 or newer for app-based MCP use
- An LM Studio model with tool-use support

## Install And Build

```powershell
git clone <repository-url> C:\repo\LmStudioTools
Set-Location C:\repo\LmStudioTools
npm install
npm run build
```

Run `npm run build` again after pulling source changes. LM Studio executes files from `dist/`, not directly from `src/`.

Build both the servers and story reader UI with:

```powershell
npm run build:all
```

Create the writable roots before connecting the servers:

```powershell
New-Item -ItemType Directory -Force C:\tmp\lmstudio-workspace | Out-Null
New-Item -ItemType Directory -Force C:\tmp\stories | Out-Null
```

`--root` is a security boundary and must name an existing directory. Every path accepted from a model is resolved beneath that root.

## LM Studio Setup

In LM Studio, open the **Program** tab in the right sidebar, then select **Install > Edit mcp.json**. Add the servers under `mcpServers` using absolute paths.

Minimal story setup on Windows:

```json
{
	"mcpServers": {
		"story-teller": {
			"command": "node",
			"args": [
				"C:\\repo\\LmStudioTools\\dist\\story-teller-index.js",
				"--root",
				"C:\\tmp\\stories",
				"--quiet"
			]
		}
	}
}
```

Complete setup with file, skill, and story servers:

```json
{
	"mcpServers": {
		"lmstudio-tools": {
			"command": "node",
			"args": [
				"C:\\repo\\LmStudioTools\\dist\\index.js",
				"--root",
				"C:\\tmp\\lmstudio-workspace",
				"--quiet"
			]
		},
		"lmstudio-skills": {
			"command": "node",
			"args": [
				"C:\\repo\\LmStudioTools\\dist\\skills-index.js",
				"--root",
				"C:\\tmp\\lmstudio-workspace",
				"--quiet"
			]
		},
		"story-teller": {
			"command": "node",
			"args": [
				"C:\\repo\\LmStudioTools\\dist\\story-teller-index.js",
				"--root",
				"C:\\tmp\\stories",
				"--quiet"
			]
		}
	}
}
```

LM Studio currently follows Cursor-style `mcp.json` notation. If an existing file already contains `mcpServers`, merge only the individual server entries rather than adding a second `mcpServers` object. Folio authoring expects the story server entry to be named `story-teller`, which LM Studio exposes to API calls as plugin id `mcp/story-teller`.

Restart the MCP integrations after changing `mcp.json` or rebuilding this project. Confirm that the Program tab lists each configured server and its tools.

### Optional Tool Prefixes

`--prefix <name>` prefixes tool names to avoid collisions when multiple configured MCP instances expose the same names. Do not add a prefix unless one is needed.

For example, adding `"--prefix", "archive"` to a second story server produces tools such as `archive_story_create` and `archive_next_beat`. The `mcpServers` entry name, such as `story-teller`, identifies the server in LM Studio but does not alter tool names.

### Install The Story Skills

The skills server discovers folders under `<skills-root>/Skills`. Install the supplied local trial skills with:

```powershell
New-Item -ItemType Directory -Force C:\tmp\lmstudio-workspace\Skills | Out-Null
New-Item -ItemType Directory -Force C:\tmp\lmstudio-workspace\Skills\story-crafter | Out-Null
New-Item -ItemType Directory -Force C:\tmp\lmstudio-workspace\Skills\story-teller | Out-Null
Copy-Item -Force .\tmp\story-crafter\SKILL.md C:\tmp\lmstudio-workspace\Skills\story-crafter\SKILL.md
Copy-Item -Force .\tmp\story-teller\SKILL.md C:\tmp\lmstudio-workspace\Skills\story-teller\SKILL.md
```

Restart the `lmstudio-skills` integration after copying or changing skills. In chat, call `list_skills`, load `story-crafter`, and provide a story brief. After finalization, load `story-teller` and provide the returned story folder path.

If your LM Studio workflow injects skills directly instead of using `lmstudio-skills`, install the same two `SKILL.md` folders using that workflow and connect only `story-teller-mcp`.

## Run From A Terminal

File tools server:

```bash
node dist/index.js --root /absolute/path/to/workspace
```

Skills/workflow server:

```bash
node dist/skills-index.js --root /absolute/path/to/workspace
```

Story teller server:

```bash
node dist/story-teller-index.js --root /absolute/path/to/stories
```

For the file and story servers, `MCP_ROOT` can be used instead of `--root`. `--quiet` and `-q` suppress per-tool logs. The skills server uses `MCP_SKILLS_ROOTS` or `MCP_SKILLS_ROOT` when `--root` is omitted and accepts multiple `--root` values.

Development mode:

```bash
npm run dev
npm run dev:skills
npm run dev:story
```

## Story Reader App

The reader supports finalized `story.json` blueprints and premise-only creative stories. It does not ask the model to call MCP tools. The app owns scene progression and builds each request itself.

1. Start LM Studio's local server and load a model. The default API URL is `http://127.0.0.1:1234/api/v1`.
2. Build and start the reader:

```powershell
npm run build:all
node dist/reader-server.js --root C:\tmp\stories
```

3. Open `http://127.0.0.1:4317`.

Optional settings:

```powershell
node dist/reader-server.js `
	--root C:\tmp\stories `
	--port 4317 `
	--host 127.0.0.1 `
	--lmstudio-url http://127.0.0.1:1234/api/v1
```

To read from another device on your local network, opt in explicitly with a Folio password:

```powershell
node dist/reader-server.js `
	--root C:\tmp\stories `
	--serve-on-lan `
	--folio-password "choose-a-long-password"
```

`--serve-on-lan` binds Folio to `0.0.0.0`; the terminal prints its port, and you open `http://<computer-LAN-IP>:4317` from the other device. `--folio-password` presents a login page and protects every UI and API route with a 24-hour browser session. `--folio-password` can also protect a localhost-only reader. The aliases `--serveonlan` and `--foliopassword` are accepted. Password-protected LAN access uses HTTP, so use it only on a trusted private network; it does not encrypt traffic.

Environment equivalents are `STORY_ROOT`, `STORY_READER_PORT`, `STORY_READER_HOST`, `LMSTUDIO_URL`, `FOLIO_SERVE_ON_LAN=true`, and `FOLIO_PASSWORD`. When LM Studio authentication is enabled, set `LMSTUDIO_API_TOKEN` to one of its active API keys before starting the reader. `npm run dev:reader -- --root C:\tmp\stories` builds the UI and runs the TypeScript server directly.

The reader provides:

- **Next:** accepts the current narration, advances exactly one beat, and treats entered text as an ongoing direction.
- **Regenerate:** discards the current draft and generates the same beat again; entered text applies to that revision.
- **Auto continue:** after a draft finishes, accepts it and generates the next beat until the final beat is reached. The preference is stored in the browser.
- **Review:** sends the exact saved system prompt, beat request, and resulting prose to a stateless editor pass. The reviewer opens its answer with one tag: `[VALID]` keeps the prose as-is, `[REPLACE]` supplies a full corrected beat, and `[APPEND]` supplies only the missing continuation when the prose stopped short of every required event. Folio shows the resulting change for approval; tags never appear in stored or displayed prose.
- **Review after generation:** immediately starts that review when generation finishes. Auto continue proceeds after an unchanged result and pauses when the reviewer suggests a revision.
- Applied replacements retain every displaced version in the beat's `revisions` array inside its `<story>/reader-runs/<run-id>.json` session file. Generated prose is not written into the authored `story.json` blueprint.
- A context selector when starting a narration: **Full narration context** retains LM Studio response IDs and the complete accepted prose, while **Previous beat events only** starts a stateless request for every beat and supplies compact prior `story.json` events instead.
- Story beats store an `events` array. Narration prompts list the current beat's events alongside story context and reader instructions.

### Reading Workflows

Choose a **Story workflow** before selecting **Begin**:

- **Authored** follows an existing finalized blueprint, as before.
- **Discovery** starts from a premise and optional title. The model invents one scene at a time and chooses a natural stopping point within **Maximum scene words**. **Next** continues from the actual ending; **End story** saves the current scene and closes the session.
- **Plan & Approve** proposes the next scene before writing it. Edit the **Scene plan**, select **Approve & Write**, or request a **New proposal**. **Auto-approve plans** skips manual approval on subsequent requests; **Auto continue** also approves plans while generating successive scenes. Use **Stop** to interrupt automatic generation.

All three workflows retain **Direct**, **Distinct**, and **Recurring improvement** drafting choices under **Model options**. Creative stories appear on the shelf under **Saved story** and can be resumed without creating an outline.

Creative setup fields are automatically retained in the current browser across reloads. Select **Save story** to save the premise, title, narration rules and settings to the story root without generating any scenes. A saved creative story needs no beats or finalized outline and remains available under **Saved story** after restarting Folio with the same root. **Begin** also saves the session before generation starts.

For creative stories, **Narration Rules** sits beside **Premise** and separately controls viewpoint, tense, voice and prose style. During reading, open **Narration Rules** and select **Save rules** to change them. Saved changes guide future planning, prose, improvement, review and explicit regeneration; existing prose stays unchanged, and factual summaries do not inherit the prose style.

Creative scene summaries are generated in a separate pass from saved prose, never displayed as part of the story, and refreshed after an applied review or regeneration. Older context uses these factual summaries and a bounded consolidated recap; recent scenes remain full prose according to **Recent beats carried as prose**. Full prose is always retained for reading. Summary failures preserve the draft so **Next** can retry summarization. Interrupted prose must be reviewed or regenerated before continuation.

Review criteria follow the workflow: authored events, creative continuity, or adherence to an approved scene plan. When **Suggest vocal cue tags** is enabled, review also checks supported lowercase tags, speaker attribution, placement, missing cues where appropriate, and excessive cues. Changed earlier scenes invalidate their summaries and flag later scenes for a continuity review; later prose is not silently rewritten. Proposals are not established history: only the resulting prose is summarized as canon.

### Story Authoring

Open `http://127.0.0.1:4317/author` or select **Write** in the reader. The authoring workspace can create and edit complete story blueprints, reorder or expand beats, validate references, and switch a story between draft and final status.

The model collaborator uses LM Studio's native stateful chat with the configured `story-teller` MCP server from `mcp.json`. Add the minimal `story-teller` server from **LM Studio Setup** above; you do not need the file or skills servers for Folio authoring. The API request restricts the collaborator to the story authoring tools it needs.

In LM Studio 0.4.0 or newer, enable **Require Authentication** and **Allow calling servers from mcp.json**, create an API key, then start the reader from the same terminal after setting it:

```powershell
$env:LMSTUDIO_API_TOKEN = "your-api-key"
node dist/reader-server.js --root C:\tmp\stories
```

If your `mcp.json` server entry uses a different name, pass the matching LM Studio plugin id. For an entry named `folio-story`, use `mcp/folio-story`:

```powershell
node dist/reader-server.js `
	--root C:\tmp\stories `
	--mcp-plugin-id mcp/folio-story
```

The environment equivalent is `STORY_READER_MCP_ID`.

To also allow a configured file-tools server, add `--file-tools-plugin-id mcp/file-tools` (environment: `STORY_READER_FILE_TOOLS_MCP_ID`). The suffix must match its server entry name in LM Studio's MCP configuration. File tools are opt-in and expose all tools from that server, including writes and deletion. Keep its root aligned with Folio's root. The collaborator prefers story tools for blueprint changes and is instructed to validate blueprints changed through file tools.

```powershell
node dist/reader-server.js --root C:\tmp\tale-spin --file-tools-plugin-id mcp/file-tools --tts-profile chatterbox
```

The authoring model picker includes only LLMs that LM Studio's `/api/v1/models` reports with `capabilities.trained_for_tool_use: true`. Models with missing capability metadata are excluded; update LM Studio if no tool-capable models are reported. This flag indicates training, not guaranteed tool-call reliability. The reader's narration model picker remains unrestricted.

The structured editor remains available when LM Studio is offline.

Reader sessions are stored separately under `<story>/reader-runs/`. Existing MCP telling sessions remain under `<story>/runs/` and the `telling_start`, `next_beat`, and `telling_status` tools are unchanged.

### Local Read-Aloud

Folio can read saved beats using a local OpenAI-compatible text-to-speech (TTS) service. Audio is off by default. **Folio does not install Docker, a TTS server, model weights, or voices.** Install and start one of the speech services below first; Folio sends it the text and plays/caches the returned WAV clips.

#### Kokoro

Kokoro is the recommended lightweight starting point. Install and start Docker Desktop (Linux containers), then from the Folio repository:

```powershell
docker compose -f compose.audio.yml --profile cpu up -d
```

This downloads the TTS container and model files on first run. Wait until the Kokoro UI at `http://127.0.0.1:8880/web` is ready. Then start Folio with your story directory:

```powershell
npm run build:all
node dist/reader-server.js --root C:\path\to\stories --tts-profile kokoro
```

The same CPU service works on Windows, macOS, and Linux where Docker Desktop/Engine is supported. It does not require a compatible GPU.

For an NVIDIA GPU with Docker GPU support, stop the CPU container and select the CUDA profile instead:

```powershell
docker compose -f compose.audio.yml --profile cpu down
docker compose -f compose.audio.yml --profile cuda up -d
```

Both variants use the same Folio settings and port; do not start them simultaneously. On Windows, Docker GPU passthrough requires Docker Desktop's WSL 2 backend and NVIDIA support. Intel/AMD acceleration is not configured by these Docker profiles. The `KOKORO_TAG` environment variable can pin an image release instead of `latest`.

#### Chatterbox

Chatterbox requires a separate server. On Windows, install Git, then clone and start the [community Chatterbox TTS server](https://github.com/devnen/Chatterbox-TTS-Server):

```powershell
git clone https://github.com/devnen/Chatterbox-TTS-Server.git
Set-Location .\Chatterbox-TTS-Server
.\start.bat
```

Follow its hardware selection menu. The launcher installs the server dependencies and downloads the chosen model on first launch. The server's current Windows launcher documents CPU and NVIDIA paths; select the appropriate option there. Its Docker deployment is also available from the project README, but NVIDIA GPU Docker needs the NVIDIA Container Toolkit/runtime configured for your platform.

After the server reports ready, start Folio with:

```powershell
node dist/reader-server.js --root C:\path\to\stories --tts-profile chatterbox
```

The Chatterbox community server documents an OpenAI-compatible API, large-text chunking, predefined/reference voices, and switchable engines. Folio queries its predefined voice list when it starts, displays the friendly names, and sends the matching filename (for example, `Emily.wav`). If your saved voice is unavailable, Folio selects the first installed voice. Refresh the list after adding voices. Select Turbo in the Chatterbox UI for inline vocal cues; Folio does not choose the engine or install it. Confirm the API port shown by the server. If it differs from `8004`, set `--tts-url http://127.0.0.1:<port>/v1`.

Folio sends each complete story paragraph to the speech service as one request, so it never cuts a paragraph at an arbitrary character boundary. Chatterbox can perform its own sentence-aware chunking inside that paragraph. Folio renders paragraphs sequentially as internal checkpoints and automatically merges them into one saved beat file when complete. Rendering runs on the Folio server, independently of playback and browser tabs. A paragraph over Folio's 20,000-character request limit is reported as an error rather than truncated. Folio requests WAV by default because MP3 encoding requires FFmpeg and fails if that executable is unavailable to the Chatterbox server. Install/configure FFmpeg for the Chatterbox process, verify MP3 export in its own UI, then opt into MP3 from Folio with `--tts-format mp3`. The Chatterbox server's audiobook UI settings are not otherwise controlled by Folio. Import predefined voices or upload clean reference audio for cloning in the Chatterbox UI. Chatterbox's Temperature and other model controls remain in that server. Its synthesis Speed Factor is experimental and can cause echo; Folio leaves it at the provider default. Folio's separate speed slider changes browser playback rate and does not re-render audio.

#### Reader Controls And Configuration

Use the play icon beside the voice field to preview the narrator without generating a story or loading an LM Studio model. Select **Read aloud** on a saved beat to resume its missing clips, merge the result, and play the complete beat. Existing matching recordings are reused. The shared **Audio beat** selector and arrow buttons switch between complete saved beats; when playback ends, it advances to the next ready beat. Native audio controls provide pause, resume, seek, and volume. The square icon stops playback only; **Stop generation** separately stops the server queue without deleting completed checkpoints. Speed changes playback rate without re-rendering. The refresh icon loads available voices; a voice ID can also be entered manually.

**Generate audio** renders all existing narrated beats in the current reading session without playing them or generating new story prose. It skips unchanged complete recordings and resumes partial work. Interrupted drafts and unresolved review revisions are skipped. Progress is separate from the selected playback beat: rendering another beat does not replace what you are listening to. The job continues if you reload or close the browser; reopen the session to see its progress. Restarting Folio stops the job, but selecting **Generate audio** again resumes from disk checkpoints.

Recordings and partial checkpoints are saved on disk and restored when you reopen the session. The download-arrow icon exports the selected complete beat, as one WAV or MP3 matching the configured format. Filenames include the story title, beat order, beat title, and stable beat ID, for example `Tidewrack_001_The_Arrival_b01.wav`; unnamed creative scenes use their scene number. Names are sanitized for Windows. Files are stored separately per reading session. Renaming a story or beat updates the filename on the next generation request without resynthesizing unchanged audio. Folio bundles FFmpeg for joining clips; this does not install FFmpeg inside a separate Chatterbox environment.

Regeneration, applied reviews, and other prose edits do not delete existing audio. The next **Read aloud** or **Generate audio** detects changed prose or voice/provider settings, including the reported Chatterbox engine, and asks once before replacing the affected saved recordings. Cancel keeps the earlier audio, which remains selectable as outdated. Confirm replaces those beat renditions; unchanged paragraphs can still reuse the shared cache. Browser playback speed and title changes do not require new synthesis. If source narration changes during a render, the job stops with an error and keeps its checkpoints so you can review and restart it.

Before synthesis, Folio converts em/en dashes to comma pauses and removes the known Chatterbox bracket tokens whenever the active provider reports that it does not support paralinguistic tags. For Chatterbox, Folio checks `/api/model-info`: Turbo's `supports_paralinguistic_tags` preserves the tokens; Original and other engines have them stripped. If capability detection is unavailable, Folio errs on the side of stripping. These adjustments apply only to text sent to TTS; generated prose and saved narration remain unchanged. This prevents unsupported `[gasp]` markers from being read aloud and reduces abrupt dash pauses in speech.

When the Chatterbox provider is configured, **Model options** includes the optional **Suggest Chatterbox vocal cues** setting. Enable it before starting a run to add a persistent narration instruction; it applies to every beat in that run and is retained when you resume it. It is off by default and hidden for Kokoro. The instruction asks the writing model to add only occasional, story-appropriate bracket cues. Select **Turbo** in the Chatterbox server for these cues; other engines/providers may ignore them or read them as text. The tags remain in the story prose.

The official [Chatterbox Turbo tokenizer file](https://huggingface.co/ResembleAI/chatterbox-turbo/blob/main/added_tokens.json) defines 19 special tokens. The emotion/delivery versus vocal-reaction groupings and descriptions below are documented by the community [ComfyUI-ChatterBox-Turbo node](https://github.com/wobba/ComfyUI-ChatterBox-Turbo#emotion--paralinguistic-tags), not an official guarantee of how each tag will sound. Audition tags with your selected voice and engine.

| Delivery / emotion cues | Vocal reaction cues |
| --- | --- |
| `[angry]`, `[fear]`, `[surprised]`, `[whispering]`, `[advertisement]` | `[laugh]`, `[chuckle]`, `[gasp]`, `[sigh]`, `[groan]` |
| `[dramatic]`, `[narration]`, `[crying]`, `[happy]`, `[sarcastic]` | `[sniff]`, `[cough]`, `[clear throat]`, `[shush]` |

Use an emotion/delivery cue at the start of the sentence or line it affects. Put a reaction cue where it belongs, possibly mid-sentence. Spell every tag exactly as shown, in lowercase: the special-token matching is case-sensitive, so `[Sigh]` may be spoken as text instead of recognized as `[sigh]`. Avoid stacking cues or tagging every line. These controls steer delivery; they do not guarantee an exact acting performance.

Provider presets are aliases for service defaults, not machine or GPU detection:

| Folio preset | Default service base URL | Model | Voice | Output / request boundary |
| --- | --- | --- | --- | --- |
| `kokoro` | `http://127.0.0.1:8880/v1` | `kokoro` | `af_heart` | WAV / complete paragraph |
| `chatterbox` | `http://127.0.0.1:8004/v1` | `chatterbox` | First installed voice | WAV / complete paragraph; service chunks internally |
| `portable` | `http://127.0.0.1:8880/v1` | `kokoro` | `af_heart` | WAV / complete paragraph |

`--tts-profile` also accepts the earlier `laptop` and `desktop` aliases for compatibility. All profiles accept `--tts-url`, `--tts-model`, `--tts-voice`, and `--tts-format wav|mp3` overrides. Environment equivalents are `FOLIO_TTS_URL`, `FOLIO_TTS_MODEL`, `FOLIO_TTS_VOICE`, and `FOLIO_TTS_FORMAT`. URLs are API base URLs including `/v1`, not `/audio/speech`. Supplying `--tts-url` enables audio without a preset. Device selection belongs to the TTS service; Folio does not infer hardware or silently switch model/voice.

Environment equivalents are `FOLIO_TTS_PROFILE`, `FOLIO_TTS_URL`, `FOLIO_TTS_MODEL`, `FOLIO_TTS_VOICE`, `FOLIO_TTS_FORMAT`, and optional `FOLIO_TTS_API_TOKEN`. Requests go through Folio, including its existing password protection, so phone browsers do not need direct access to the TTS port. Keep the TTS service bound to localhost unless deliberately configuring a trusted remote service.

Completed clips are cached under `<root>/.folio-audio-cache/` by service URL, model, text, voice, format, and synthesis settings. Beat playlists, their saved clips, and assembled downloads live beneath its `beats/` directory, keyed by reading session and beat index. Existing matching paragraph cache files are adopted when preparing a beat, including clips rendered before beat playlists were introduced. Kokoro clips are WAV; Chatterbox clips are WAV by default or MP3 when configured. Saved clips and complete beats remain playable/downloadable with the TTS service offline. Stop an active render before retrying another clip. One render runs at a time, each paragraph request is limited to 20,000 characters and 30 MB of audio, and provider requests time out after three minutes. The cache has no automatic eviction; replacing a saved beat rendition does not remove shared paragraph cache files. Remove the cache folder while Folio is stopped to reclaim all space or after replacing model weights behind the same service/model ID. Complete-beat export does not combine multiple beats into a whole story.

This first version does not yet include cast assignment, generated vocal/effect cues, whole-story export, or verified Intel GPU acceleration. The [audio research and design](docs/folio-audio.md) covers those follow-ups and the NVIDIA/Intel hardware requirements.

## File Tools

- `get_root`
- `list_files`
- `list_folders`
- `read_file`
- `read_json`
- `add_json`
- `update_json`
- `plan_create`
- `plan_list_tasks`
- `plan_get_open_task`
- `plan_add_task`
- `plan_update_task`
- `plan_show`
- `add_file`
- `replace_file`
- `append_file`
- `add_folder`
- `remove_file`
- `remove_folder`

All paths are sandboxed relative to the configured root.

## Skills + Workflows

Skills server tools:

- `list_skills`
- `load_skill`
- `read_skill_file`

Workflow tools are auto-registered when a workflows directory exists under the workspace root:

- `list_workflows`
- `workflow_open`
- `workflow_current_step`
- `workflow_submit_step`
- `workflow_status`
- `workflow_block`
- `workflow_unblock`

Workflows are markdown files with `## Step N: ...` headings and an optional `### Verify` section.

## Story Teller

Authoring tools:

- `story_create`
- `story_add_character`
- `story_add_location`
- `story_add_narration_mode`
- `story_add_fact`
- `story_add_state`
- `story_add_beat`
- `story_validate`
- `story_finalize`

Telling tools:

- `telling_start`
- `next_beat`
- `telling_status`

Story blueprints are stored as `<story>/story.json`. Each telling stores only its next beat index and status under `<story>/runs/`. `next_beat` atomically advances progress and returns instructions for one beat. Narrated prose and emergent details remain in the model's chat context and are not persisted by the MCP.

### Blueprint Shape (`story-v3`)

Nothing in a blueprint is referenced by position. Characters, locations, narration modes, facts and beats all carry an `id`, and every cross-reference names one, so a beat can be inserted, moved or renamed without renumbering the file. Beat order is the order beats appear in the `beats` array.

Three kinds of canon, each with one correct home:

| Kind | Where it lives | Example |
| --- | --- | --- |
| True for the whole story | The subject's `description`, `appearance`, `attributes` or `details` | "Sixty, salt-cracked hands" |
| Changes during the story | A `states` entry on that character or location | "Shoulder bandaged, arm in a sling" |
| World or plot canon owned by nobody | A `facts` entry | "The light may never go dark" |

States and facts are bounded by beat ids. `from` names the beat during which the entry begins and `until` the beat during which it ends:

```json
{
  "id": "mara",
  "name": "Mara Kest",
  "description": "Smuggler washed off a foundering cutter.",
  "states": [
    { "id": "wounded",  "state": "Deep gash across the left shoulder.",   "from": "b02", "until": "b04" },
    { "id": "bandaged", "state": "Shoulder bandaged, arm in a sling.",    "from": "b04", "until": "b06" },
    { "id": "scarred",  "state": "A stiff white scar.",                   "from": "b06" }
  ]
}
```

A state that replaces another shares the earlier one's `until` with its own `from`, which is why a healing wound reads as a chain. A state is active *entering* beat N when `from` is before N and `until` is N or later, so a state does not apply to the beat it begins in — that beat is where it comes about.

#### Where a fact applies

A fact answers two independent questions, and conflating them loses information. `from` and `until` say **when the narrator may know it**, on the same beat-id basis as a state, except inclusive at `from` because a reveal is known from the beat that reveals it. A selector says **where it is worth repeating**. A fact carries at most one selector, and the first match wins:

| Authored | Applies at | Use for |
| --- | --- | --- |
| `beats: ["b08", "b11"]` | exactly those beats | one-off canon, and parallel storylines — the only way to say "beats 8 and 11" without dragging the fact through 9 and 10 |
| `subjects: ["elara", "burrow"]` | beats in the window where any of those characters or locations is on stage | following a storyline into beats that do not exist yet |
| neither | every beat in the window | world rules, and reveals gated by `from` |

A pinned fact **ignores** its window rather than intersecting it, so a pin the author chose can never be silently hidden; validation warns when both are set. Reaching for `beats` where a window would do is worth a second look: a standing arrangement or an ability is usually canon from a beat onwards, and only a genuine one-off — a birth, a single overheard remark — wants a pin.

Canon about a single character or location does not belong here at all: permanent traits go in that subject's `description`, `appearance`, `attributes` or `details`, and anything that changes goes in a `states` entry.

#### Beats

`events` on a beat are postconditions, not a script: each must be true when the beat ends, and how they come about is left to the narrator. Set a beat's optional `time` whenever it does not open where the previous beat stopped.

A beat's optional `title` is a navigation label only. The reader lists every title in an always-visible beat map beside the manuscript, and nothing in the prompts or the prose ever shows it, so it may name an outcome the reader has not reached yet only at the cost of spoiling the beat map. Beats without a title fall back to their id.

Everything else the prompts need is derived, never authored: which beats already established a character or location, the folded state entering a beat, which facts are in scope, and whether a beat continues the previous scene or opens a new one. Because the derivation is a pure function of the blueprint, every context mode sees the same context, and regenerating an earlier beat recomputes correctly.

A beat's prompt carries state only for subjects on stage in it. State belonging to an absent character is context the narrator cannot act on, and a small local model absorbs it anyway — a wound on someone three locations away turns up in the prose. If an absent character's condition matters to a scene, it belongs to a subject that is present, or to a fact. A state change is still reported in the beat's postconditions and its history even when the beat never shows the subject.

Each narration mode has a `kind` of `replace` (default) or `supplemental`. A `replace` mode's rules are used on their own whenever a beat selects it. A `supplemental` mode's rules are layered on top of the story's default mode's rules, so a beat only needs to describe what is different for that scene instead of repeating the whole rule set. The default narration mode itself always behaves as `replace`.

### Story Workflow

1. `story_create` creates a draft blueprint beneath the story server root.
2. Add narration modes, characters, locations, world facts, and ordered beats.
3. Add `story_add_state` entries for anything that changes during the story. States and fact selectors reference beat ids, so add them after the beats they bound.
4. Run `story_validate`, repair errors, then run `story_finalize`.
5. `telling_start` creates an isolated telling run and returns its ID plus the story title, premise, type, default narration mode, beat-size guidance, and beat count.
6. `next_beat` advances the run by one and returns one narration packet. Every packet repeats the title, premise, and story type so global canon does not depend on conversation memory.
7. The model narrates that beat directly to the user, using the current chat as memory for prior prose.
8. The model waits for the user to continue before calling `next_beat` again.

### Migrating An Older Blueprint

`story-v2` blueprints are converted in place, with the original kept beside each story as `story.v2.json`:

```powershell
npm run build
npm run migrate:stories -- --root C:\tmp\stories --dry-run
npm run migrate:stories -- --root C:\tmp\stories
```

Fact selection carries over exactly — a v2 `beat.facts` listing becomes the fact's own `beats` pins, and `fact.subjects` stays as it was. One case changes meaning and is reported per story: a fact that no beat listed and no subject scoped was never shown under v2, and v3 has no way to express "never", so it becomes canon in every beat. Review each id the migration names and either give it a selector or delete it.

`story-v1` blueprints are reported and left untouched.

**Commit or copy a story root before migrating.** The migration rewrites `story.json` in place, and `story.v2.json` is only a sibling file — it is not a substitute for version control if the pre-migration state matters.

## Troubleshooting

- **Server fails at startup:** confirm Node.js is on `PATH`, `npm run build` created `dist/`, and every configured root already exists.
- **Tools are missing after a change:** rebuild the project and restart the MCP integration in LM Studio.
- **Skills are not listed:** confirm the exact layout is `<root>/Skills/<skill-name>/SKILL.md`, then restart `lmstudio-skills`.
- **A story cannot be edited:** finalized blueprints are immutable. Create a new draft story folder.
- **A beat was fetched but not narrated:** progress has already advanced. Use the packet still present in the chat; do not call `next_beat` again for that beat.
- **Different tellings vary in details:** this is expected. Hard canon belongs to `story.json`; emergent details live only in each chat context.

## Build and Test

```bash
npm run build
npm test
```

For real browser interaction tests, install the Playwright browser once and run:

```bash
npx playwright install chromium
npm run test:browser
```

The browser suite builds the reader, starts the real Fastify reader server against a temporary finalized story, and uses a local HTTP mock for LM Studio streaming responses. It therefore exercises UI clicks, SSE updates, iterative draft replacement, and persisted run behavior without requiring LM Studio.
