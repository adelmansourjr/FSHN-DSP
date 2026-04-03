# Recommender Benchmark

This folder contains a benchmark harness for the recommender the app uses.

It benchmarks two surfaces:
- `internal`: the recommender service directly, with controllable ablations
- `route`: the app-visible `/recommend` HTTP output, if a route URL is provided

The reduced internal matrix is:
- `heuristic_off`
- `auto_off`
- `heuristic_hybrid`
- `auto_hybrid`

The benchmark uses:
- prompt cases from [prompts/core.json](/Users/adelmansour/Desktop/fshn/testing-rec/prompts/core.json)
- gold rubrics from [rubrics/core.json](/Users/adelmansour/Desktop/fshn/testing-rec/rubrics/core.json)
- defaults from [config/default.json](/Users/adelmansour/Desktop/fshn/testing-rec/config/default.json)
- richer internal-catalog config from [config/fuller-catalog.json](/Users/adelmansour/Desktop/fshn/testing-rec/config/fuller-catalog.json)

## Run

Run from the repo root with the `tsx` loader already installed in `tryon-local`:

```bash
node --import ./tryon-local/node_modules/tsx/dist/loader.mjs ./testing-rec/scripts/run-benchmark.ts
```

Common variants:

```bash
node --import ./tryon-local/node_modules/tsx/dist/loader.mjs ./testing-rec/scripts/run-benchmark.ts --smoke
node --import ./tryon-local/node_modules/tsx/dist/loader.mjs ./testing-rec/scripts/run-benchmark.ts --surface internal --configs heuristic_off,auto_off,heuristic_hybrid,auto_hybrid
node --import ./tryon-local/node_modules/tsx/dist/loader.mjs ./testing-rec/scripts/run-benchmark.ts --surface route --route-url http://127.0.0.1:8787/recommend
```

Use the fuller local catalog instead of the tiny snapshot:

```bash
node --import ./tryon-local/node_modules/tsx/dist/loader.mjs ./testing-rec/scripts/run-benchmark.ts --config testing-rec/config/fuller-catalog.json
```

Fast smoke on the fuller local catalog:

```bash
node --import ./tryon-local/node_modules/tsx/dist/loader.mjs ./testing-rec/scripts/run-benchmark.ts \
  --config testing-rec/config/fuller-catalog.json \
  --surface internal \
  --configs auto_off,auto_hybrid \
  --cases men_old_money_stage1,women_dinner_stage1,men_kanye,women_gym \
  --output-stem fuller-catalog-smoke
```

## Outputs

Runs write to:
- [results/raw/](/Users/adelmansour/Desktop/fshn/testing-rec/results/raw)
- [results/summary/](/Users/adelmansour/Desktop/fshn/testing-rec/results/summary)

Main outputs:
- raw JSONL run records
- case summaries
- metric summaries
- overall summaries
- ablation deltas with bootstrap confidence intervals
- subset summaries for `all` and `embedding_sensitive`
- focused embedding-impact tables comparing `auto_hybrid` vs `auto_off`

The chart-ready internal bar data is the config metric summary for:
- `heuristic_off`
- `auto_off`
- `heuristic_hybrid`
- `auto_hybrid`

The simplest embedding story lives in:
- `*.subset-summary.json`
- `*.embedding-impact.json`

Those files are meant to answer:
- how the 4 configs do on all prompts
- how they do on embedding-sensitive prompts only
- how much `auto_hybrid` beats `auto_off` on `overall`, `selection`, `semantic`, `pool_quality`, and `diversity`

## Visuals

Generate zero-dependency PNG charts from the latest benchmark run:

```bash
python3 ./testing-rec/scripts/generate_visuals.py
```

Or target a specific run stem:

```bash
python3 ./testing-rec/scripts/generate_visuals.py --stem 2026-03-30T01-20-03-554Z
```

Charts are written to:
- [results/visuals/](/Users/adelmansour/Desktop/fshn/testing-rec/results/visuals)

The generator creates:
- overall accuracy by config
- key metric comparison across configs
- subset comparison for `all` vs `embedding_sensitive`
- `auto_hybrid` vs `auto_off` impact bars
- semantic share / semantic frontier share bars
- per-case `auto_hybrid` overall scores
- per-case `auto_hybrid - auto_off` deltas
- a small `visual-summary.json` manifest

## Notes

- `internal` uses the prepared local recommender assets in `tryon-local/recommender-assets`.
- The default local asset pair is a very small snapshot. If you want a more production-like internal benchmark, use [config/fuller-catalog.json](/Users/adelmansour/Desktop/fshn/testing-rec/config/fuller-catalog.json), which points directly at:
  - [src/data/index.classifiedfarfetch.json](/Users/adelmansour/Desktop/fshn/src/data/index.classifiedfarfetch.json)
  - [src/data/index.classified.embeddingsfarfetch.json](/Users/adelmansour/Desktop/fshn/src/data/index.classified.embeddingsfarfetch.json)
- `route` is optional and is skipped unless a URL is supplied.
- `auto_*` configs may require Gemini access or warm parse caches, depending on your environment.
