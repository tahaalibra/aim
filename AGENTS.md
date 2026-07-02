# AI Model Manager (aim) — Agent Reference

## Overview

`aim` is a Node.js CLI for managing local LLM workflows: downloading models from
HuggingFace, installing backends (llama.cpp, MLX, vLLM), and running inference
servers.

**Tech stack:**
- Node.js 20+, ES Modules (`"type": "module"`), no build step
- CLI framework: Commander.js
- Subprocess execution: execa
- Testing: Vitest
- Misc: chalk, ora (spinners), pretty-bytes, glob

## Project structure

```
aim/
├── bin/
│   └── aim.js              # CLI entry point — registers commands, global -d/--debug
├── src/
│   ├── paths.js            # Path constants (~/ai/ layout)
│   ├── config.js           # Global settings (~/ai/config.json) + `aim config` command
│   ├── utils.js            # Output, exec, ini parsing, hf helpers, debug flag
│   ├── models.js           # Model discovery + backend detection/resolution
│   ├── params.js           # Canonical run-param schema → backend flag translation
│   └── commands/
│       ├── agent.js        # aim agent — export registry to agent runtimes (pi, zed)
│       ├── check.js        # backend check — verify backends work
│       ├── config-gen.js   # model config-gen — generate/update aim-models.ini
│       ├── download.js     # model download
│       ├── install.js      # backend install
│       ├── list.js         # model/backend list
│       ├── rm.js           # model/backend rm
│       ├── qrun.js         # deprecated alias → run
│       ├── run.js          # run — single model server (unified launcher)
│       ├── serve.js        # serve — multi-model llama-server router
│       └── status.js       # status
├── test/
├── package.json
├── README.md
└── AGENTS.md
```

## Architecture

### Core concepts

1. **Path management** (`src/paths.js`)
   - All data lives under `~/ai/`.
   - Models: `~/ai/models/{org}/{repo}/`; backends: `~/ai/backends/`; binaries:
     `~/ai/bin/` (symlinks).
   - Registry: `~/ai/models/aim-models.ini`; serve preset: `~/ai/models/config.ini`.

2. **Backend detection / resolution** (`src/models.js`)
   - `.gguf` → `llama.cpp`; `config.json` + `.safetensors`/`.npz` → `mlx` (the
     on-disk default for safetensors on this Apple-Silicon-first tool).
   - **vLLM is opt-in:** it shares the same safetensors layout as mlx, so it is
     never auto-detected — select it with `--backend vllm` or `backend = vllm`
     in the registry. Use it for CUDA/safetensors models (incl. architectures
     mlx can't run, e.g. `cohere2_moe`).
   - Resolution precedence: explicit CLI flag > registry `backend=` > disk detection.

3. **Parameter translation** (`src/params.js`)
   - `PARAM_SCHEMA` maps canonical registry keys to per-backend flags;
     `STRUCTURAL_KEYS` (`backend`, `model`, `mmproj`) are resolved into paths, not
     sampling flags.
   - `buildBackendArgs(backend, config)` → `{ args, warnings }`. Unknown or
     backend-unsupported keys are collected as warnings, never silently dropped.
   - `llamaArgsToPresetLines(args)` converts llama.cpp arg arrays into
     `config.ini` preset lines (used by serve).
   - Keys: sampling (`temp`, `top-p`, `top-k`, `min-p`, `max-tokens`, `seed`,
     `presence-penalty`, `frequency-penalty`, `repeat-penalty`); runtime
     (`ctx-size`, `flash-attn`, `n-gpu-layers`); MTP/speculative (`spec-type`,
     `spec-draft-n-max`); template (`alias`, `jinja`, `thinking`); vLLM-only
     (`dtype`, `tensor-parallel`, `gpu-mem-util`, `quantization`, `max-num-seqs`,
     `trust-remote-code`).
   - vLLM caveat: sampling knobs are per-request in vLLM, so they map to `null`
     (warn). `ctx-size` → `--max-model-len`, `alias` → `--served-model-name`.

4. **Command pattern**
   - Each command module exports a `register*` function taking a Commander
     program/command instance.
   - Flow: register → action → try/catch → `fail()` on error (SIGINT/SIGTERM exit 0).

### Config files

- **`aim-models.ini`** — source of truth. One section per model. Generated/updated
  by `aim model config-gen` (and `aim model config`); preserves manual edits and
  only adds newly discovered models.
- **`config.ini`** — `llama-server` router preset consumed by `aim serve`
  (`--models-preset`). A *derived* artifact: llama.cpp (GGUF) entries only, mlx
  and vllm excluded. Built by `updateConfigIni()`, which projects each registry section's
  run params through `params.js`. Paths are written **unquoted** (the preset
  parser reads values verbatim and does not strip quotes). A preload target gets
  `load-on-startup = true`.

### Key files

- **`bin/aim.js`** — registers all commands. Top-level: `run`, `qrun`, `serve`,
  `status`, `config`, `agent`. `model` group: `download`, `list`, `rm`, `config`,
  `config-gen`. `backend` group: `install`, `list`, `rm`, `check`. Defines the
  global `-d/--debug` option and a `preAction` hook that enables debug whether the
  flag lands on the root or a subcommand.
- **`src/paths.js`** — filesystem path constants relative to `~/ai/`.
- **`src/config.js`** — `loadConfig`/`saveConfig`/`getSetting`, the `SETTINGS`
  schema, and the `aim config` command.
- **`src/utils.js`** — `ensureDir`, `dirSize`; output (`fail`/`warn`/`success`/
  `info`); exec (`streamExec`/`quietExec`); `setDebug`/`isDebug`/`printCommand`
  (streamExec auto-prints the command + cwd when debug is on); `isUserAbort`,
  `passthroughArgs`, `parseIni`, `stripQuotes`, `matchGlob`, `resolveHfCli`,
  `getHfVersion`, `isAppleSilicon`, `nproc`.
- **`src/models.js`** — `findModelRepos` (single disk scanner, dirs with model
  files only), `pickModelGguf`/`pickMmproj`, `detectBackend`, `resolveBackend`.
- **`src/params.js`** — `PARAM_SCHEMA`, `STRUCTURAL_KEYS`, `buildBackendArgs`,
  `llamaArgsToPresetLines`.
- **`src/commands/run.js`** — the unified single-model launcher. Loads the
  registry, merges CLI overrides, resolves the backend, translates params, and
  launches llama.cpp, mlx, or vllm (`vllm.entrypoints.openai.api_server` from the
  backend venv, served name defaulting to the registry section; local-only by
  default like mlx, `--online` opts in). Interactive picker when no model is
  named; passthrough of unknown flags.
- **`src/commands/qrun.js`** — thin deprecated alias that warns and delegates to
  `run.js`.
- **`src/commands/serve.js`** — `llama-server` router mode. `updateConfigIni({
  prune, preload })` regenerates `config.ini` from the registry (projecting run
  params; marks `preload` with `load-on-startup`). Autoload is on by default
  (models load on demand, capped by `--models-max`, default 1); `--no-models-autoload`
  opts out. The router is launched with `cwd = MODELS_DIR` so the preset's
  relative paths resolve.
- **`src/commands/download.js`** — HuggingFace CLI (`hf` preferred); `--include`/
  `--exclude`; auto-updates registry + preset after download.
- **`src/commands/install.js`** — llama.cpp (clone + cmake + Metal + symlink),
  MLX (venv via `uv` preferred), vLLM (venv + `pip install vllm`; opt-in, not
  part of `all`; warns on Apple Silicon), HuggingFace CLI; `--force`.
- **`src/commands/agent.js`** — exports the registry to agent runtimes (`pi`,
  `zed`) as OpenAI-compatible endpoints; `--update` merges with a `.bak` backup.
- **`src/commands/list.js`** — `model list` (size/backend), `backend list` (versions).
- **`src/commands/check.js`** — verifies each backend is actually functional.
- **`src/commands/rm.js`** — `model rm` (path-traversal guarded), `backend rm`.
- **`src/commands/status.js`** — OS, Apple Silicon, Node/Python, backend status.

## Testing strategy

- **Framework:** Vitest. **Run:** `npm test` (once), `npm run test:watch` (watch).
- Tests use real filesystem operations with temp dirs under `.test-tmp/`, isolated
  by overriding `HOME`.
- Integration tests (`cli.test.js`) spawn the actual CLI; unit tests cover
  individual functions and the registry→preset projection (`serve.test.js`).

## Key patterns

1. **Error handling:** commands wrap actions in try/catch; SIGINT/SIGTERM exit 0;
   `fail()` prints error + hint and exits 1.
2. **Passthrough args:** unknown flags are forwarded to the underlying server via
   `passthroughArgs()` (commander leaves them in `command.args`).
3. **Backend resolution:** explicit flag > registry `backend=` > disk detection.
4. **Param translation:** all config→flag mapping goes through `params.js`; `run`
   and `serve` share it so registry tuning applies identically.
5. **Config auto-update:** registry + `config.ini` regenerated after downloads and
   before serving.
6. **Global debug:** `aim -d` / `aim <cmd> -d` sets a shared flag; `streamExec`
   echoes each subprocess command (and cwd) before running it.
7. **Serve = router:** all GGUF models exposed, loaded on demand (LRU-evicted at
   `--models-max`); optional `[model]` preload at startup.
8. **MLX via uv:** `aim backend install mlx` prefers `uv pip install --python
   <venv_python>` when available, bypassing broken ensurepip.

## Development notes

- ES modules; all imports use `.js` extensions; no build step.
- CLI targets Node.js 20+.
- Apple Silicon detection enables Metal acceleration for llama.cpp.

## Post-change checklist (agent)

After making code changes, verify before declaring a change complete:

1. **Run tests:** `npm test` — all existing tests must pass (no regressions).
2. **Add/update tests** for new or changed functionality.
3. **Smoke-test the CLI** for affected commands to confirm no runtime errors.
4. **Update this AGENTS.md and README.md** if structure, commands, or patterns changed.
</content>
