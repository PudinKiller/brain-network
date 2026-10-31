# Brain Network

Brain Network is an Obsidian plugin. It maps projects, their work items, and who has the next turn.

Status: Personal tool. Desktop-only. v0.1.0. Built with AI coding agents (Claude Code and Codex) directed by the author, PudinKiller.

## Notes drive the map

A brain is a folder with a front-page note containing `brain: <name>`. The front page uses `brain-parents` to link parent brains. A root brain can use `brain-parents: []`.

An item is a note in a brain folder with `brain-state`, or an entry in a note's `brain-plan` list. The closest containing brain folder owns the item.

| State | Meaning in the map |
| --- | --- |
| `owner` | Waiting on you |
| `claude` | Waiting on Claude |
| `codex` | Queued for Codex |
| `done` | Finished |
| `planned` | Planned |
| `parked` | Parked |

`brain-gate` marks an `art`, `decision`, `look`, or `approval` gate. `brain-ask` holds the question. `brain-review` lists review images or clips. The map shows review media beside the selected item.

`brain-stream` groups items into streams. `brain-after` links dependencies. Front pages can set stream order with `brain-streams`.

```yaml
brain-state: owner
brain-gate: art
brain-stream: Materials
brain-ask: "Choose the glow: concept A or concept B?"
brain-review:
  - "Assets/lantern-concept-a.png"
brain-after:
  - "[[Shader Lab/Palette Baseline]]"
```

Plan entries use `title`, `stream`, `state`, `gate`, `ask`, `link`, `review`, and `after` inside `brain-plan`. The demo includes examples.

Owner replies update the item's state, add a dated line under the note's `## Owner review`, and append to the plugin's `replies.jsonl`. `hooks/replies.cjs` hands pending replies to Claude Code on its next prompt when registered as a `UserPromptSubmit` hook. Copying the hook file does not register it.

The Chat can run Claude Code's CLI in the vault. **Start Codex** asks Claude to launch Codex using the brain's collaboration rules. The plugin also looks for recent local Codex session logs that name a queued brief. CLI login and agent setup are separate from installing the map.

## Install

1. Create `<vault>/.obsidian/plugins/brain-network/`.
2. Copy `main.js`, `styles.css`, `manifest.json`, and `hooks/replies.cjs` there, keeping the `hooks/` folder.
3. Reload Obsidian. Enable **Brain Network** under **Settings → Community plugins**.
4. Run **Brain Network: Open the map** from the command palette, or click the brain ribbon icon.

## Open the demo vault

In desktop Obsidian, choose **Open folder as vault** and select `demo-vault/`. Enable community plugins if prompted. Brain Network is already bundled and listed in the vault's enabled plugins.

Open `Studio Home.md`, then run **Brain Network: Open the map**. Double-click a brain to open its roadmap. Select **Lantern Glow**, **Route Readability**, or **Shot Board** to inspect sample gates and images.

The demo vault ships with **Settings → Brain Network → Send messages to Claude** turned off, so browsing and replying never start an agent. The plugin's own default is on, with Claude Code CLI permissions set to `bypassPermissions` (no permission checks). Review that setting before turning sending on in any vault.

The studio, people, work history, and art in this vault are fictional. The six PNGs are labelled placeholders. Validation and remaining checks are recorded in [DEMO_NOTES.md](DEMO_NOTES.md).

## Screenshots

- TODO: `docs/01-studio-map.png` — all five brains.
- TODO: `docs/02-shader-roadmap.png` — streams and dependencies.
- TODO: `docs/03-owner-review.png` — a gate, its images, and an owner reply.
- TODO: `docs/brain-network-60s.mp4` — a 60-second walkthrough.
