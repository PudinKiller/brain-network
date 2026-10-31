# Privacy check

Checked 2026-10-31. [hands-on] Searches ran from the repository root using ripgrep. Searches are case-insensitive fixed substrings, so matches inside longer words count.

Scope: the whole directory, including hidden files, ignored files, and local Git metadata. Binary PNGs are skipped by ripgrep's default binary detection; the generated images were also visually inspected. The five runtime basenames below are always excluded to avoid reading private runtime content. File inventory confirmed that none are present. No temporary tool cache remains.

## Commands run

The script runs each of the 17 terms separately with the same options to build the table. These combined searches were also run:

```powershell
rg --hidden --no-ignore --sort path --with-filename --no-text -n -i -F --glob '!data.json' --glob '!status.json' --glob '!runs.jsonl' --glob '!replies.jsonl' --glob '!hook-state.json' --glob '!PRIVACY_CHECK.md' -e 'duncan' -e 'Ken' -e 'Deng' -e '留美' -e 'moshuixin' -e 'gmail' -e 'Knowledge Base' -e 'C:\Users' -e 'Epic' -e 'Stormbound' -e 'Carnegie' -e 'CMU' -e 'visa' -e 'resume' -e 'token' -e 'gho_' -e 'sk-ant' .
rg --hidden --no-ignore --sort path --with-filename --no-text -n -i -F --glob '!data.json' --glob '!status.json' --glob '!runs.jsonl' --glob '!replies.jsonl' --glob '!hook-state.json' -e 'duncan' -e 'Ken' -e 'Deng' -e '留美' -e 'moshuixin' -e 'gmail' -e 'Knowledge Base' -e 'C:\Users' -e 'Epic' -e 'Stormbound' -e 'Carnegie' -e 'CMU' -e 'visa' -e 'resume' -e 'token' -e 'gho_' -e 'sk-ant' .
rg -n -i -F -e 'PudinKiller' -- manifest.json demo-vault/.obsidian/plugins/brain-network/manifest.json
```

The first search omits this report so each source hit can be explained below. The second includes the finished report. Report matches are intentional: the requested search terms, the commands, the table, and explanations of source matches. Report line numbers below identify every such matching line.

## Results

| Pattern | Matching lines outside report | Report line numbers | Total matching lines |
| --- | ---: | --- | ---: |
| `duncan` | 1 | 12, 13, 23, 43 | 5 |
| `Ken` | 59 | 12, 13, 24, 37, 47, 49, 51, 52, 53, 54, 56, 105 | 71 |
| `Deng` | 1 | 12, 13, 25, 58 | 5 |
| `留美` | 1 | 12, 13, 26, 62 | 5 |
| `moshuixin` | 1 | 12, 13, 27, 66 | 5 |
| `gmail` | 1 | 12, 13, 28, 70 | 5 |
| `Knowledge Base` | 1 | 12, 13, 29, 74 | 5 |
| `C:\Users` | 0 | 12, 13, 30 | 3 |
| `Epic` | 1 | 12, 13, 31, 78 | 5 |
| `Stormbound` | 1 | 12, 13, 32, 82 | 5 |
| `Carnegie` | 1 | 12, 13, 33, 86 | 5 |
| `CMU` | 1 | 12, 13, 34, 90 | 5 |
| `visa` | 3 | 12, 13, 35, 94, 96 | 8 |
| `resume` | 22 | 12, 13, 36, 99 | 26 |
| `token` | 33 | 12, 13, 37, 105 | 37 |
| `gho_` | 1 | 12, 13, 38, 112 | 5 |
| `sk-ant` | 1 | 12, 13, 39, 116 | 5 |

Every hit outside this report is listed by file and line below. Repeated bundled-source hits come from the required demo plugin copy. No unexplained hits were found. A text search cannot establish that arbitrary future content is safe to publish.

### `duncan`

- `tools/check_privacy.cjs`, lines 9 — Intentional search vocabulary, report text, or audit logic in this script.

### `Ken`

- `.git/hooks/applypatch-msg.sample`, lines 3 — Substring in the word taken in a stock Git hook comment. This metadata is not a published project file.
- `.git/hooks/fsmonitor-watchman.sample`, lines 11, 12, 13, 19, 22, 83, 90, 91, 92, 151 — Stock Git file-watcher state identifiers and comments; no credential value. This metadata is not a published project file.
- `demo-vault/.obsidian/plugins/brain-network/main.js`, lines 86, 90, 151, 1604, 1605, 1982, 2286, 2293, 2664, 2908, 2909, 3162, 3219, 3233, 3278, 3290, 3294 — Substring in broken-front-matter identifiers or context-usage words; no person is named.
- `demo-vault/.obsidian/plugins/brain-network/styles.css`, lines 339, 340, 341 — Substring in the .bn-broken warning selector; no person is named.
- `main.js`, lines 86, 90, 151, 1604, 1605, 1982, 2286, 2293, 2664, 2908, 2909, 3162, 3219, 3233, 3278, 3290, 3294 — Substring in broken-front-matter identifiers or context-usage words; no person is named.
- `styles.css`, lines 339, 340, 341 — Substring in the .bn-broken warning selector; no person is named.
- `tools/check_privacy.cjs`, lines 9, 25, 26, 28, 30, 32, 34 — Intentional search vocabulary, report text, or audit logic in this script.
- `tools/check_yaml.cjs`, lines 80 — Substring in the model.broken assertion for malformed front matter; no person is named.

### `Deng`

- `tools/check_privacy.cjs`, lines 9 — Intentional search vocabulary, report text, or audit logic in this script.

### `留美`

- `tools/check_privacy.cjs`, lines 9 — Intentional search vocabulary, report text, or audit logic in this script.

### `moshuixin`

- `tools/check_privacy.cjs`, lines 9 — Intentional search vocabulary, report text, or audit logic in this script.

### `gmail`

- `tools/check_privacy.cjs`, lines 9 — Intentional search vocabulary, report text, or audit logic in this script.

### `Knowledge Base`

- `tools/check_privacy.cjs`, lines 9 — Intentional search vocabulary, report text, or audit logic in this script.

### `Epic`

- `tools/check_privacy.cjs`, lines 9 — Intentional search vocabulary, report text, or audit logic in this script.

### `Stormbound`

- `tools/check_privacy.cjs`, lines 9 — Intentional search vocabulary, report text, or audit logic in this script.

### `Carnegie`

- `tools/check_privacy.cjs`, lines 9 — Intentional search vocabulary, report text, or audit logic in this script.

### `CMU`

- `tools/check_privacy.cjs`, lines 9 — Intentional search vocabulary, report text, or audit logic in this script.

### `visa`

- `.git/hooks/pre-commit.sample`, lines 39 — Substring in the word advisable in a stock Git hook message. This metadata is not a published project file.
- `tools/check_privacy.cjs`, lines 9, 27 — Intentional search vocabulary, report text, or audit logic in this script.

### `resume`

- `demo-vault/.obsidian/plugins/brain-network/main.js`, lines 2290, 2340, 2668, 2945, 3215, 3241, 3242, 3312, 3331, 3361 — Session continuation identifiers/flags, or the audio-context method; no employment document.
- `main.js`, lines 2290, 2340, 2668, 2945, 3215, 3241, 3242, 3312, 3331, 3361 — Session continuation identifiers/flags, or the audio-context method; no employment document.
- `tools/check_privacy.cjs`, lines 9, 31 — Intentional search vocabulary, report text, or audit logic in this script.

### `token`

- `.git/hooks/fsmonitor-watchman.sample`, lines 11, 12, 13, 19, 22, 83, 90, 91, 92, 151 — Stock Git file-watcher state identifiers and comments; no credential value. This metadata is not a published project file.
- `demo-vault/.obsidian/plugins/brain-network/main.js`, lines 1982, 2286, 2293, 2664, 3162, 3219, 3233, 3278, 3290, 3294 — Context-usage labels, counters, or API usage field names; no credential value.
- `main.js`, lines 1982, 2286, 2293, 2664, 3162, 3219, 3233, 3278, 3290, 3294 — Context-usage labels, counters, or API usage field names; no credential value.
- `tools/check_privacy.cjs`, lines 9, 28, 32 — Intentional search vocabulary, report text, or audit logic in this script.

### `gho_`

- `tools/check_privacy.cjs`, lines 9 — Intentional search vocabulary, report text, or audit logic in this script.

### `sk-ant`

- `tools/check_privacy.cjs`, lines 9 — Intentional search vocabulary, report text, or audit logic in this script.

## Public author handle

The exact public handle `PudinKiller` appears as the author in both manifests (line 7). These two hits are expected. The README also identifies the author by this public handle.

## Reproduce

Run `node tools/check_privacy.cjs`. It rewrites this report, repeats the full-directory searches, checks the resulting counts, and fails on an unexplained source hit. After adding screenshots or a clip, inspect those files separately and rerun this audit.
