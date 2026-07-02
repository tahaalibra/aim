<div align="center">

# 🎯 `aim`

### AI Model Manager — your local LLM workflow, handled.

*Download models from HuggingFace, install backends, and serve inference — all driven by one registry.*

<br/>

[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Backends](https://img.shields.io/badge/backends-llama.cpp%20%7C%20MLX-blue)](#-backends)
[![Platform](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Apple%20Silicon-black?logo=apple)](#)
[![License](https://img.shields.io/badge/license-ISC-green.svg)](#-license)

</div>

---

```bash
aim model download unsloth/gemma-3-GGUF --include "*UD-Q8_K_XL*"
aim backend install llama.cpp
aim serve unsloth/gemma-3-GGUF --port 8080
#  → OpenAI-compatible endpoint at http://localhost:8080/v1
```

## ✨ Highlights

|   |   |
|---|---|
| 🗂️ **One registry, two modes** | `aim-models.ini` is the single source of truth — the same per-model tuning drives both single-model `run` and the multi-model `serve` router. |
| 🔌 **Pluggable backends** | First-class **llama.cpp** (Metal) and **MLX**, auto-detected from the files on disk — plus opt-in **vLLM** (CUDA) for raw HuggingFace safetensors. |
| 🎛️ **Smart params** | One schema maps canonical keys (`temp`, `ctx-size`, `flash-attn`, `thinking`, …) to each backend's native flags — unsupported params warn, never silently vanish. |
| 🚦 **On-demand serving** | The router exposes every model and loads them lazily, capped by `--models-max` with LRU eviction. |
| 🧭 **Zero-config layout** | Everything lives tidily under `~/ai/` — models, backends, binaries, settings. |
| 🐛 **`-d` everything** | A global `--debug` prints the exact backend command (and cwd) before it runs. |

## 🚀 Install

```bash
npm install -g .   # from the project directory
# or, for development:
npm link
```

> **Requires Node.js 20+.** macOS / Apple Silicon recommended (Metal acceleration).

## 🗃️ Directory layout

`aim` keeps everything under `~/ai/`:

```
~/ai/
├── models/                # downloaded HuggingFace models, as {org}/{repo}/
│   ├── aim-models.ini     # ⭐ the model registry — source of truth (aim-owned)
│   └── config.ini         # 🔧 llama-server router preset — derived from the registry
├── backends/              # installed backend runtimes
│   ├── llama.cpp/         # cloned + built llama.cpp
│   ├── mlx/               # mlx-lm Python venv
│   └── vllm/              # vllm Python venv (opt-in, CUDA)
├── bin/                   # symlinked binaries (llama-server, …)
└── config.json            # global aim settings (see `aim config`)
```

## 💡 Concepts

### ⭐ The model registry (`aim-models.ini`)

The single source of truth for **how each model runs** — one section per model,
holding structural keys (`backend`, `model`, `mmproj`) plus run parameters:

```ini
[unsloth/gemma-3-GGUF]
backend     = llama.cpp
model       = unsloth/gemma-3-GGUF/gemma-3-27b-it-UD-Q8_K_XL.gguf
mmproj      = unsloth/gemma-3-GGUF/mmproj-BF16.gguf
ctx-size    = 32768
temp        = 1.0
top-p       = 0.95
top-k       = 64
flash-attn  = on
n-gpu-layers = 99
# thinking  = true          # enables jinja + enable_thinking
```

Generated/updated by `aim model config` (or `config-gen`) and it **preserves
your hand edits**. `config.ini` (the `llama-server` router preset) is a *derived*
artifact — you don't touch it; it's regenerated from the registry on every
download and serve.

### 🔀 Backend selection & parameter translation

Backend resolution precedence:

```
--backend flag   >   registry backend=   >   on-disk detection
                                              (.gguf → llama.cpp,
                                               config.json + .safetensors/.npz → mlx)
```

> 🐧 **vLLM is opt-in.** It reads the same safetensors layout as MLX, so it's
> never auto-detected — choose it explicitly with `--backend vllm` or
> `backend = vllm` in the registry. Reach for it on CUDA boxes, or for raw
> HuggingFace models MLX can't run (e.g. brand-new architectures like
> `cohere2_moe`). Sampling knobs are per-request in vLLM, so they don't apply at
> launch; `ctx-size` maps to `--max-model-len` and `alias` to `--served-model-name`.

A single schema (`src/params.js`) translates registry params into each backend's
native flags — e.g. `temp` → `--temp` (llama.cpp) / `--temperature` (MLX). Apply
the *same* tuning whether you `run` one model or `serve` many. A param a backend
doesn't support (e.g. `thinking` on MLX) **warns** instead of disappearing.

<details>
<summary><b>📋 Supported parameter keys</b></summary>

| Group | Keys |
|---|---|
| **Sampling** | `temp`, `top-p`, `top-k`, `min-p`, `max-tokens`, `seed`, `presence-penalty`, `frequency-penalty`, `repeat-penalty` |
| **Runtime** | `ctx-size`, `flash-attn`, `n-gpu-layers` |
| **Speculative / MTP** | `spec-type`, `spec-draft-n-max` |
| **Template** | `alias`, `jinja`, `thinking` |
| **vLLM-only** | `dtype`, `tensor-parallel`, `gpu-mem-util`, `quantization`, `max-num-seqs`, `trust-remote-code` |

</details>

## 🌐 Global flags

| Flag | Effect |
|---|---|
| `-d, --debug` | Print every backend/subprocess command (and its cwd) before it runs. Works at the root or on a subcommand: `aim -d serve` ≡ `aim serve -d`. |

## 🛠️ Commands

### `aim run [model]` — single-model server

Auto-detects the backend and reads defaults from the registry; CLI flags
override. Omit the model to pick one interactively.

```bash
aim run unsloth/gemma-3-GGUF --port 8001 --thinking
aim run gemma-3-GGUF --temp 0.8 --top-p 0.95        # registry defaults + overrides
aim run mlx-community/gemma-3-12b-it-4bit --backend mlx
aim run CohereLabs/BLS-Mini-Code-1.0 --backend vllm  # raw safetensors via vLLM
aim run                                              # 🔍 interactive picker
```

<details>
<summary>Flags</summary>

`--port` · `--backend` · `--mmproj <glob>` · `--no-mmproj` · `--thinking` ·
`--alias` · `--temp` · `--top-p` · `--top-k` · `--min-p` · `--ctx-size` ·
`--online`. Unrecognized flags are forwarded straight to the underlying server.

</details>

> 💤 `aim qrun` is a deprecated alias for `aim run`, kept for one release.

---

### `aim serve [model]` — multi-model router

Serve downloaded llama.cpp models via the `llama-server` router. Refreshes the
registry and regenerates `config.ini` first. Models **load on demand** (capped by
`--models-max`, LRU-evicted). Pass a `MODEL` to preload one at startup.

```bash
aim serve                              # serve all, load on demand
aim serve --port 8080 --models-max 2   # keep up to 2 resident
aim serve unsloth/gemma-3-GGUF         # ⚡ preload one at startup
aim serve --no-models-autoload         # require explicit loads via API/web UI
```

| Option | Default | Notes |
|---|---|---|
| `--port <port>` | `8080` | or `config defaultPort` |
| `--models-max <n>` | `1` | resident-model cap (LRU eviction) |
| `--no-models-autoload` | off | require explicit `/models/load` |

> 🧠 On a unified-memory Mac, `--models-max` defaults to **1** so a second model
> evicts the first instead of risking an out-of-memory load. Raise it only when
> you know the resident set fits.

---

### `aim model <subcommand>` — manage models

| Command | What it does |
|---|---|
| `aim model download <repo>` | Download from HuggingFace (auto-updates registry + preset). Supports `--include`/`--exclude`. |
| `aim model list` | List downloaded models, sizes, and inferred backend. |
| `aim model rm <repo>` | Delete a downloaded model. |
| `aim model config [--prune]` | Update the registry **and** regenerate the serve preset. |
| `aim model config-gen [--prune]` | Update the registry only. |

```bash
aim model download unsloth/gemma-3-GGUF --include "*mmproj-BF16*" --include "*UD-Q8_K_XL*"
aim model download mlx-community/gemma-3-12b-it-4bit
```

---

### `aim backend <subcommand>` — manage engines

| Command | What it does |
|---|---|
| `aim backend install <component>` | Install `llama.cpp`, `mlx`, `vllm`, `huggingface`, or `all` (`--force` to rebuild). `vllm` is opt-in and excluded from `all`. |
| `aim backend list` | Installed backends and versions. |
| `aim backend rm <component>` | Uninstall a backend. |
| `aim backend check` | Verify each backend is actually functional. |

```bash
aim backend install llama.cpp
aim backend install vllm        # opt-in CUDA backend
aim backend install all
```

---

### `aim agent <target> [--update]` — export to agent runtimes

Export the registry into an external agent's config, pointed at your local
OpenAI-compatible server. Targets: **`pi`**, **`zed`**. Without `--update` it's a
dry run; with it, merges into the target (preserving entries it doesn't manage)
after a `.bak` backup.

```bash
aim agent pi             # 👀 dry run
aim agent pi --update    # write ~/.pi/agent/models.json
aim agent zed --update   # write ~/.config/zed/settings.json
```

> ⚠️ Third-party config schemas vary by version — review the output and adjust
> the renderer in `src/commands/agent.js` if your version differs.

---

### `aim config [key] [value]` — global defaults

```bash
aim config                          # list all settings
aim config defaultPort 8081         # set
aim config preferredQuant "*Q8_K_XL*"
```

Supported keys: `defaultPort`, `defaultBackend`, `preferredQuant`.

---

### `aim status` — system & component health

Shows OS / Apple Silicon, Node & Python paths, and the status + version of each
backend (llama.cpp, MLX, vLLM, HuggingFace CLI).

## 🧩 Backends

| Backend | Detected from | Selection | Acceleration |
|---|---|---|---|
| **llama.cpp** | `.gguf` files | auto | Metal (Apple Silicon) |
| **MLX** | `config.json` + `.safetensors`/`.npz` | auto | Apple MLX |
| **vLLM** | same safetensors layout as MLX | opt-in (`--backend vllm` / `backend = vllm`) | CUDA (NVIDIA/AMD GPUs) |

## 🧪 Development

```bash
npm install
npm test            # run tests (vitest)
npm run test:watch  # watch mode
```

## 📄 License

ISC

<div align="center">
<sub>Built with ❤️ on <a href="https://github.com/ggml-org/llama.cpp">llama.cpp</a> &amp; <a href="https://github.com/ml-explore/mlx-lm">MLX</a>.</sub>
</div>
</content>
