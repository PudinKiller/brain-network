# Demo notes

Lantern Fox Games and Mosslight Courier are fictional. Mira handles art, Tobi handles tools, and Neri handles trailers and play sessions. The sample snapshot is dated 2026-10-24. Handoffs and replies are invented history. The six art PNGs are labelled placeholders.

The vault contains eight brains, 36 items, nine plan entries, and 33 resolved dependencies. Nine note items were added for the deeper demo. Existing notes retain their outcomes. Missing asks and result locations were filled in.

| Brain | Items | Purpose |
| --- | ---: | --- |
| Studio | 4 | Scope and studio priorities |
| Shader Lab | 6 | Material and lighting direction |
| Lantern Shader | 4 | Reusable night material, under Shader Lab |
| Level Tools | 5 | Room authoring and route tools |
| Launch Trailer | 6 | Edit and capture direction |
| Store Page | 3 | Offline page packet, under Launch Trailer |
| Playtest | 6 | Session and control-card preparation |
| Accessibility | 2 | Shared controls, with Playtest and Level Tools as parents |

Every brain has a front page, AGENTS.md, and Decision Log. Parent links express priority relationships. Cross-brain dependencies connect the palette, session script, grid rules, title card, and shot board to downstream outcomes.

Lantern Shader shows four distinct outcomes along one dependency chain: Night Palette is done, Night Backdrop waits on the owner, Pulse Envelope has a Codex draft awaiting Claude's verification, and Flicker Clamp is a Claude-led brief queued for Codex. Night Palette contains Brief, Result, Claude verification, and Owner review sections. The chain's unfinished dependencies remain explicit.

[hands-on] `node tools/check_yaml.cjs` parses the restricted YAML syntax used here and runs the plugin's actual model and review resolver against a metadata fixture. It checks all six states, four gate types, three hierarchy levels, the two-parent brain, asks, result links, dependencies, and bundle equality. Fourteen review references resolve to six 1000 × 600 PNGs. Eight path/link forms and a missing file are checked. The safe demo settings require dispatch off. The fixture is not a general YAML parser.

[hands-on] The open demo vault in Obsidian 1.14.5 reports eight brains and 36 items. Each of the eight review forms decoded to a 1000 × 600 image in the running app. A moon click and lightbox navigation showed both review images. `dev:errors` and `dev:console level=error` reported no captured errors after the walkthrough. These buffers cover the observed session.

[hands-on] The three screenshots in [docs](docs/README.md) come from `dev:screenshot`. The clip uses those CLI-driven views, readable brief/result notes, captions, crossfades, and gentle camera movement. It is an edited screenshot walkthrough. `tools/capture_demo.cjs` drives only demo-vault and refuses dispatch on. `tools/render_clip.py` uses ffmpeg from the external media environment.

[hands-on] `node tools/check_privacy.cjs` checks 17 fixed search patterns and writes [PRIVACY_CHECK.md](PRIVACY_CHECK.md). Review the screenshots and clip separately because text scanning does not audit their pixels.

Live Claude dispatch, Codex launching, the registered reply hook, and reply submission were not exercised. Browsing and capture sent no messages. No game source, performance measurements, or accessibility study is bundled. Obsidian was not restarted or reloaded; only the demo plugin was reloaded. No Git push was performed.

The project uses the [MIT license](LICENSE), copyright 2026 PudinKiller.
