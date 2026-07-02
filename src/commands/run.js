import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, basename } from 'path';
import { createInterface } from 'readline';
import chalk from 'chalk';
import prettyBytes from 'pretty-bytes';
import {
  MODELS_DIR, LLAMA_SERVER_BIN, MLX_PYTHON, VLLM_PYTHON, AIM_MODELS_INI_PATH,
} from '../paths.js';
import {
  fail, info, warn,
  streamExec, matchGlob, isUserAbort, passthroughArgs, parseIni, stripQuotes,
} from '../utils.js';
import { detectBackend, resolveBackend } from '../models.js';
import { buildBackendArgs } from '../params.js';
import { getSetting, loadConfig, saveConfig } from '../config.js';

// Re-exported for backward compatibility (and tests).
export { detectBackend };

export function registerRun(program) {
  program
    .command('run [model]')
    .option('--backend <backend>', 'Backend to use (llama.cpp, mlx, vllm). Overrides the registry/disk.')
    .option('--port <port>', 'Server port (default: config defaultPort or 8080)')
    .option('--mmproj <pattern>', 'Multimodal projector glob pattern (llama.cpp only)')
    .option('--no-mmproj', 'Skip the multimodal projector (run text-only)')
    .option('--thinking', 'Enable thinking mode (llama.cpp only)')
    .option('--alias <alias>', 'Model alias (llama.cpp only)')
    .option('--temp <temp>', 'Temperature')
    .option('--top-p <value>', 'Top-p sampling')
    .option('--top-k <value>', 'Top-k sampling')
    .option('--min-p <value>', 'Min-p sampling')
    .option('--ctx-size <value>', 'Context size')
    .option('-d, --debug', 'Print the exact backend command before running')
    .option('--online', 'Allow the backend to fetch from HuggingFace (default: local-only)')
    .option('-q, --quick', 'Skip all prompts. With no MODEL, re-run the last model+quant.')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .description(
      'Run a model server (llama.cpp, MLX, or vLLM). Reads defaults from aim-models.ini; ' +
      'CLI flags override. Omit MODEL to pick from a list (or -q to repeat the last run). ' +
      'When a model has several GGUF quantizations, you are prompted to choose one.',
    )
    .action(async (model, options, command) => {
      try {
        await runModel(model, options, command);
      } catch (err) {
        // Exit cleanly if the user hits Ctrl+C (SIGINT/SIGTERM or code 130/143).
        if (isUserAbort(err)) process.exit(0);
        const hint = /--mmproj|projector|clip\.cpp/.test(err.message)
          ? 'If this crashed loading the projector, retry text-only with --no-mmproj.'
          : undefined;
        fail(`Run failed: ${err.message}`, hint);
      }
    });
}

/**
 * Unified model launcher used by both `aim run` and the deprecated `aim qrun`.
 * Resolves the target (registry entry or direct repo path), merges registry
 * defaults with CLI overrides, picks a backend, translates params, and launches.
 */
export async function runModel(model, options, command) {
  // Resolve port: explicit flag > config defaultPort > 8080.
  options.port = options.port || getSetting('defaultPort') || '8080';

  const registry = loadRegistry();

  // `-q`/`--quick` with no model: replay the last run (same model + quant),
  // skipping every prompt. The remembered quant is threaded through as a hint.
  if (!model && options.quick) {
    const last = getSetting('lastRun');
    if (!last?.section) {
      fail(
        'Nothing to repeat — no previous run recorded',
        'Run a model once first: aim run <model>',
      );
    }
    model = last.section;
    options.lastGguf = last.gguf || null;
  }

  let sectionName, sectionConfig;
  const matched = model ? matchSection(registry, model) : null;

  if (matched) {
    ({ key: sectionName, config: sectionConfig } = matched);
  } else if (model) {
    // Not in the registry — treat the argument as a direct repo path on disk.
    sectionName = model;
    sectionConfig = {};
  } else {
    // No model given — pick one from the registry.
    if (registry.size === 0) {
      fail(
        'No model specified and the registry is empty',
        'Pass a model (e.g. aim run org/repo) or build the registry: aim model config',
      );
    }
    const picked = await promptModelSelection(registry);
    if (!picked) fail('No model selected.');
    sectionName = picked;
    sectionConfig = registry.get(picked) || {};
  }

  const modelDir = join(MODELS_DIR, sectionName);
  if (!existsSync(modelDir)) {
    fail(`Model not found: ${sectionName}`, `Download it first: aim download ${sectionName}`);
  }

  // Merge registry defaults with CLI overrides into one canonical config.
  const config = mergeConfig(sectionConfig, options);

  // Backend precedence: --backend flag > ini backend= > disk detection.
  const backend = resolveBackend({
    explicit: options.backend,
    configBackend: config.backend,
    modelDir,
  });
  info(`Using backend: ${chalk.bold(backend)}`);

  // Translate the canonical config into backend-native flags.
  const { args: paramArgs, warnings } = buildBackendArgs(backend, config);
  for (const w of warnings) warn(w);

  // Forward unknown flags straight to the backend server.
  const passthrough = passthroughArgs(command, model ? [model] : []);

  if (backend === 'llama.cpp') {
    await runLlamaCpp(sectionName, config, modelDir, options, paramArgs, passthrough);
  } else if (backend === 'mlx') {
    await runMlx(sectionName, modelDir, options, paramArgs, passthrough);
  } else if (backend === 'vllm') {
    await runVllm(sectionName, modelDir, options, paramArgs, passthrough);
  } else {
    fail(`Unknown backend: ${backend}`, 'Supported backends: llama.cpp, mlx, vllm');
  }
}

// ─── Registry & config merge ────────────────────────────────

function loadRegistry() {
  if (!existsSync(AIM_MODELS_INI_PATH)) return new Map();
  try {
    return parseIni(readFileSync(AIM_MODELS_INI_PATH, 'utf-8'));
  } catch {
    return new Map();
  }
}

/** Find a registry section by full path or trailing model name. */
function matchSection(registry, model) {
  for (const [name, config] of registry) {
    if (name === model || name.endsWith(`/${model}`)) return { key: name, config };
  }
  return null;
}

/** Apply CLI overrides on top of the registry section (CLI wins). */
function mergeConfig(section, options) {
  const config = { ...section };
  const set = (key, val) => { if (val != null) config[key] = val; };
  set('temp', options.temp);
  set('top-p', options.topP);
  set('top-k', options.topK);
  set('min-p', options.minP);
  set('ctx-size', options.ctxSize);
  set('alias', options.alias);
  if (options.thinking) config.thinking = 'true';
  return config;
}

// ─── Interactive picker ─────────────────────────────────────

function promptModelSelection(registry) {
  const models = [...registry.keys()];
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log();
  console.log(chalk.bold('  Available models:'));
  models.forEach((m, i) => {
    const backend = registry.get(m)?.backend;
    const tag = backend ? chalk.dim(` (${backend})`) : '';
    console.log(chalk.dim(`    ${i + 1}. ${m}`) + tag);
  });
  console.log();

  return new Promise((resolve) => {
    rl.question(chalk.cyan('  Select a model (number or name): '), (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (!trimmed) {
        resolve(null);
        return;
      }
      const idx = parseInt(trimmed, 10) - 1;
      if (idx >= 0 && idx < models.length) {
        resolve(models[idx]);
        return;
      }
      for (const m of models) {
        if (m.endsWith(trimmed) || m.includes(trimmed)) {
          resolve(m);
          return;
        }
      }
      console.log(chalk.yellow(`  ⚠ "${trimmed}" does not match any model.`));
      resolve(null);
    });
  });
}

export function getAllFiles(dir) {
  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isFile()) {
      results.push(entry.name);
    } else if (entry.isDirectory()) {
      const sub = getAllFiles(join(dir, entry.name));
      results.push(...sub.map(f => join(entry.name, f)));
    }
  }
  return results;
}

function safeSize(p) {
  try { return statSync(p).size; } catch { return 0; }
}

// ─── Quant selection ────────────────────────────────────────

/**
 * Choose a model GGUF (quantization) from `modelGgufs` by trying each name in
 * `candidateNames` in order, matching on basename so registry paths like
 * `org/repo/file.gguf` line up with the on-disk entry. Falls back to the first
 * (largest) GGUF when nothing matches. Returns a path relative to the model dir.
 */
export function pickQuant(modelGgufs, candidateNames = []) {
  for (const name of candidateNames) {
    if (!name) continue;
    const hit = modelGgufs.find(f => basename(f) === basename(stripQuotes(name)));
    if (hit) return hit;
  }
  return modelGgufs[0];
}

/** Remember the model + quant just launched, for `aim run -q`. Best-effort. */
function recordLastRun(section, gguf) {
  try {
    const config = loadConfig();
    config.lastRun = { section, gguf: gguf || null };
    saveConfig(config);
  } catch { /* persistence is non-essential */ }
}

/** Interactively pick a quantization; Enter accepts `defaultRel`. */
function promptQuantSelection(modelGgufs, modelDir, defaultRel) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const defIdx = Math.max(0, modelGgufs.indexOf(defaultRel));

  console.log();
  console.log(chalk.bold('  Available quantizations:'));
  modelGgufs.forEach((f, i) => {
    const size = prettyBytes(safeSize(join(modelDir, f)));
    const line = `    ${i + 1}. ${basename(f).padEnd(42)} ${size.padStart(10)}`;
    console.log(chalk.dim(line) + (i === defIdx ? chalk.green('  (default)') : ''));
  });
  console.log();

  return new Promise((resolve) => {
    rl.question(chalk.cyan(`  Select a quantization [${defIdx + 1}]: `), (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (!trimmed) return resolve(modelGgufs[defIdx]);
      const idx = parseInt(trimmed, 10) - 1;
      if (idx >= 0 && idx < modelGgufs.length) return resolve(modelGgufs[idx]);
      // Otherwise treat the input as a name/substring (e.g. "Q4").
      const hit = modelGgufs.find(f => basename(f).toLowerCase().includes(trimmed.toLowerCase()));
      if (hit) return resolve(hit);
      console.log(chalk.yellow(`  ⚠ "${trimmed}" did not match — using the default.`));
      resolve(modelGgufs[defIdx]);
    });
  });
}

// ─── llama.cpp ──────────────────────────────────────────────

async function runLlamaCpp(sectionName, config, modelDir, options, paramArgs, passthrough) {
  if (!existsSync(LLAMA_SERVER_BIN)) {
    fail('llama-server not found', 'Install it with: aim backend install llama.cpp');
  }

  const allFiles = getAllFiles(modelDir);
  const ggufFiles = allFiles.filter(f => f.endsWith('.gguf'));
  if (ggufFiles.length === 0) {
    fail('No .gguf files found in model directory', 'Did you download the right model?');
  }

  // Candidate quantizations: every non-mmproj GGUF, largest first.
  const modelGgufs = ggufFiles
    .filter(f => !basename(f).toLowerCase().includes('mmproj'))
    .sort((a, b) => safeSize(join(modelDir, b)) - safeSize(join(modelDir, a)));
  if (modelGgufs.length === 0) fail('Only mmproj GGUF files found — no model GGUF');

  // The registry default quant (config `model =`), matched by filename so a
  // path like org/repo/file.gguf lines up with the on-disk entry.
  const defaultRel = pickQuant(modelGgufs, [config.model]);

  // Choose the quant to load:
  //   --quick    → no prompt; reuse the remembered quant, else the default.
  //   1 quant    → just use it.
  //   many + TTY → ask which one (default pre-selected).
  //   else       → the registry default.
  let chosenRel;
  if (options.quick) {
    chosenRel = pickQuant(modelGgufs, [options.lastGguf, config.model]);
  } else if (modelGgufs.length > 1 && process.stdin.isTTY) {
    chosenRel = await promptQuantSelection(modelGgufs, modelDir, defaultRel);
  } else {
    chosenRel = defaultRel;
  }

  const modelPath = join(modelDir, chosenRel);
  recordLastRun(sectionName, chosenRel);

  const args = ['--model', modelPath, '--port', options.port];

  // Default alias from the filename unless one came from config/CLI (via paramArgs).
  if (!paramArgs.includes('--alias')) {
    args.push('--alias', sectionName || basename(modelPath).replace('.gguf', ''));
  }

  // mmproj resolution:
  //   --no-mmproj      → options.mmproj === false  → skip entirely (text-only)
  //   --mmproj <glob>  → options.mmproj is a string → glob override
  //   (neither)        → options.mmproj === true    → use the registry path
  if (options.mmproj !== false) {
    let mmprojPath = config.mmproj ? join(MODELS_DIR, stripQuotes(config.mmproj)) : null;
    if (typeof options.mmproj === 'string') {
      const matches = matchGlob(options.mmproj, ggufFiles.map(f => basename(f)));
      if (matches.length === 0) {
        fail(
          `No file matching mmproj pattern: ${options.mmproj}`,
          `Available GGUF files: ${ggufFiles.map(f => basename(f)).join(', ')}`,
        );
      }
      mmprojPath = join(modelDir, matches[0]);
    }
    if (mmprojPath && existsSync(mmprojPath)) {
      args.push('--mmproj', mmprojPath);
      info(`Multimodal projector: ${chalk.dim(basename(mmprojPath))}`);
    }
  }

  args.push(...paramArgs);
  args.push(...passthrough);

  console.log();
  console.log(chalk.bold.cyan('  Starting llama-server'));
  console.log(chalk.dim(`  Model: ${basename(modelPath)}`));
  console.log(chalk.dim(`  Port:  ${options.port}`));
  console.log();

  await streamExec(LLAMA_SERVER_BIN, args);
}

// ─── MLX ────────────────────────────────────────────────────

async function runMlx(sectionName, modelDir, options, paramArgs, passthrough) {
  if (!existsSync(MLX_PYTHON)) {
    fail('MLX backend not installed', 'Install it with: aim backend install mlx');
  }

  recordLastRun(sectionName, null);

  const args = ['-m', 'mlx_lm.server', '--model', modelDir, '--port', options.port];
  args.push(...paramArgs);
  args.push(...passthrough);

  // mlx_lm re-downloads from HuggingFace when a request names a model it didn't
  // load (e.g. a client using the repo id instead of the served path). Run
  // local-only by default so a mismatch errors instead of silently fetching
  // tens of GB. `--online` opts back in.
  const env = options.online
    ? process.env
    : { ...process.env, HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' };

  console.log();
  console.log(chalk.bold.magenta('  Starting MLX server'));
  console.log(chalk.dim(`  Model: ${sectionName}`));
  console.log(chalk.dim(`  Port:  ${options.port}`));
  if (!options.online) console.log(chalk.dim('  Mode:  local-only (HF_HUB_OFFLINE=1; use --online to allow fetching)'));
  console.log();

  await streamExec(MLX_PYTHON, args, { env });
}

// ─── vLLM ───────────────────────────────────────────────────

async function runVllm(sectionName, modelDir, options, paramArgs, passthrough) {
  if (!existsSync(VLLM_PYTHON)) {
    fail('vLLM backend not installed', 'Install it with: aim backend install vllm');
  }

  // Launch the OpenAI-compatible server module from the backend venv. Point
  // --model at the local repo dir so vLLM loads from disk. Default the served
  // name to the registry section so clients address it by its aim model id,
  // unless an --alias (→ --served-model-name) already came through paramArgs.
  recordLastRun(sectionName, null);

  const args = [
    '-m', 'vllm.entrypoints.openai.api_server',
    '--model', modelDir,
    '--port', options.port,
  ];
  if (!paramArgs.includes('--served-model-name')) {
    args.push('--served-model-name', sectionName);
  }
  args.push(...paramArgs);
  args.push(...passthrough);

  // Like MLX, vLLM can reach out to HuggingFace when something it didn't load is
  // requested. Run local-only by default so a mismatch errors instead of
  // silently fetching tens of GB; `--online` opts back in.
  const env = options.online
    ? process.env
    : { ...process.env, HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' };

  console.log();
  console.log(chalk.bold.green('  Starting vLLM server'));
  console.log(chalk.dim(`  Model: ${sectionName}`));
  console.log(chalk.dim(`  Port:  ${options.port}`));
  if (!options.online) console.log(chalk.dim('  Mode:  local-only (HF_HUB_OFFLINE=1; use --online to allow fetching)'));
  console.log();

  await streamExec(VLLM_PYTHON, args, { env });
}
