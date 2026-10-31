# Demo notes

Lantern Fox Games is a fictional three-person studio making Mosslight Courier. Mira handles art, Tobi handles tools, and Neri handles the trailer and play sessions. The sample snapshot is dated 2026-10-24.

## File tree

```text
.
├── main.js
├── styles.css
├── manifest.json
├── hooks/replies.cjs
├── README.md
├── .gitignore
├── PRIVACY_CHECK.md
├── DEMO_NOTES.md
├── docs/README.md                     # three screenshots and a clip still TODO
├── tools/
│   ├── check_yaml.cjs
│   ├── check_privacy.cjs
│   └── generate-assets.ps1
└── demo-vault/
    ├── Studio Home.md
    ├── AGENTS.md
    ├── Decision Log.md
    ├── Demo Scope.md
    ├── Build Checklist.md
    ├── Shader Lab/                   # front page, rules, log, four items, outline brief
    ├── Level Tools/                  # front page, rules, log, four items, overlay brief
    ├── Launch Trailer/               # front page, rules, log, four items
    ├── Playtest/                     # front page, rules, log, four items
    ├── Assets/
    │   ├── lantern-concept-a.png
    │   ├── lantern-concept-b.png
    │   ├── room-route.png
    │   ├── trailer-board.png
    │   ├── title-card.png
    │   └── control-cards.png
    └── .obsidian/
        ├── community-plugins.json
        └── plugins/brain-network/
            ├── main.js
            ├── styles.css
            ├── manifest.json
            └── hooks/replies.cjs
```

Every brain has a front page, four or five rules, and a Decision Log. Front pages contain nine plan entries in total.

## What the brains show

| Brain | Items | Demonstration |
| --- | ---: | --- |
| Studio | 4 | Root with four child brains, scope approval, completed checklist, planned and parked scope |
| Shader Lab | 6 | Two streams, a two-image art gate, a filled Owner review, a queued brief, linked planned work |
| Level Tools | 5 | A route decision, a queued tool brief, dependency chain, a plan entry linked to a draft note |
| Launch Trailer | 6 | A look gate, a dependency on Shader Lab, a completed title card with Owner review, parked edit work |
| Playtest | 6 | An art gate, session questions, a planned note item, planned accessibility work, a parked idea |

## Checks

[hands-on] Run `node tools/check_yaml.cjs` from the repository root. It parses the YAML subset used by this demo, then runs the plugin's actual `buildModel` function against a metadata-cache fixture. The checker supports block mappings with JSON scalar/flow values and block sequences of JSON values. It rejects other syntax; it is not a general-purpose YAML parser. No external packages are needed.

The final run checked 39 Markdown files and parsed 23 front-matter blocks. The model produced five brains, 27 items, nine plan entries, and 22 resolved dependencies. State totals: owner 5, claude 4, codex 3, done 5, planned 6, parked 4. All four gate types are present. Every wiki link and plan link resolved in the fixture. Ten review references resolved to six existing PNGs. Two notes have dated Owner review lines.

[hands-on] All six PNGs were rendered and visually inspected together. Each is 1000 × 600 and clearly labelled as placeholder art. Regenerate them on Windows with `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/generate-assets.ps1`.

[hands-on] JavaScript syntax checks passed for the plugin, reply hook, and both check scripts. The bundled plugin contains exactly the four requested files and matches the root copies byte for byte. The only intentional edit to the supplied plugin files is the manifest author. No runtime data or license file is included. Runtime-file and workspace ignore rules were checked with `git check-ignore`.

[hands-on] Run `node tools/check_privacy.cjs` to reproduce the privacy audit. [PRIVACY_CHECK.md](PRIVACY_CHECK.md) lists the commands and explains every match, including source-code substrings and the audit's own search vocabulary.

## TODO and limits

- TODO: Capture the three screenshots and 60-second clip listed in `docs/README.md` and the README.
- [unverified] The vault has not been opened in desktop Obsidian. Map layout, thumbnails, plugin activation, and interactive reply behavior still need a walkthrough there.
- [unverified] Live Claude dispatch, the registered reply hook, and Codex launching were not exercised. Their README descriptions come from the supplied source. No live agent runs were started.
- [unverified] No full YAML-library or Obsidian parser was available. Validation covers the deliberately restricted YAML syntax used here and the plugin model with a fixture.

No GitHub repository was created and nothing was pushed. License selection remains with the owner.
