# Contributing

Thanks for your interest. This project is small on purpose: plain HTML, CSS and JavaScript, zero dependencies, runs from `file://`.

## Ground rules

- **No dependencies, no build step, no network calls.** If a change needs a package or a CDN, it is probably the wrong change.
- **Content first.** Most valuable contributions are new case-study missions, corrections to component facts, and better simulator levers.
- **Keep the engine pure.** `src/core/engine.js` must not touch the DOM; it is exercised by the Node tests and by mission checks.
- **Secure DOM.** Build nodes with the `h()` helper and `textContent`. Never assign `innerHTML` from data.
- **Teaching heuristics, not benchmarks.** Numbers in the simulator should move in the right direction by a believable amount. Don't tune them to a specific cluster.

## Development

```bash
xdg-open index.html     # or: npm start → http://localhost:8000
npm run test:all        # syntax check + unit tests + headless-Chrome UI spec
```

Requires Node.js ≥ 20 and a Chrome / Chromium binary for the UI spec (`CHROME_BIN` if it isn't on `PATH`).

## Style

- 2-space indentation, single quotes, semicolons (see `.editorconfig`).
- Component ids are lower-case and stable: they are stored in `localStorage` and referenced by presets, missions and tests.
- Every component needs: `n`, `d`, `fx`, and at least one of `conf` / `code`. Add `sim` flags if the component should change the job plan.
- User-facing copy: plain English, no exclamation marks, no marketing adjectives.

## Adding things

| I want to add… | Edit | Then |
| :-- | :-- | :-- |
| a component | `src/data/components.js` | `npm test` (catalogue tests check ids, slots, needs, conflicts and engines) |
| a simulator lever | `src/data/components.js` (`sim` flag) + `src/core/engine.js` (`planFor`) | add a lever test to `tests/engine.test.js` |
| a workload | `src/data/workloads.js` (`w`, `plan`, `code`) | check it shows a sensible plan with each preset |
| a mission | `src/data/missions.js` + `ENV` / `MORE` | read [docs/authoring-missions.md](docs/authoring-missions.md); `npm test` proves the answer |
| a preset or achievement | `src/data/workloads.js` | `npm test` |
| a second engine family | tag components `b: '<family>'`, add presets/missions, enable the button in `index.html` | update the README |

## Commits and pull requests

- One logical change per commit, imperative subject line (`Add bucketed-join lever to simulator`).
- Include a short *why* in the body when it is not obvious.
- Run `npm run test:all` before opening a pull request. CI runs the same.
- Screenshots in `docs/images` are regenerated at 1440×900 in headless Chrome; include updated ones if you change the UI materially.
