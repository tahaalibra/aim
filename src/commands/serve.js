import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import chalk from 'chalk';
import {
  MODELS_DIR, LLAMA_SERVER_BIN, CONFIG_INI_PATH, AIM_MODELS_INI_PATH,
} from '../paths.js';
import {
  ensureDir, fail, streamExec, isUserAbort, passthroughArgs, parseIni, stripQuotes,
} from '../utils.js';
import { updateModelsRegistry } from './config-gen.js';
import { getSetting } from '../config.js';
import { buildBackendArgs, llamaArgsToPresetLines } from '../params.js';

export function registerServe(program) {
  program
    .command('serve [model]')
    .option('--port <port>', 'Server port (default: config defaultPort or 8080)')
    .option('--models-max <number>', 'Maximum number of models to load simultaneously', '1')
    .option('--no-models-autoload', 'Require explicit loads via the API/web UI instead of autoloading models on demand')
    .option('-d, --debug', 'Print the exact backend command before running')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .description('Serve downloaded llama.cpp models via the llama-server router. Models load on demand; pass MODEL to preload one at startup.')
    .action(async (model, options, command) => {
      try {
        await serveModels(model, options, command);
      } catch (err) {
        // Exit cleanly if user hits Ctrl+C (SIGINT/SIGTERM or code 130/143)
        if (isUserAbort(err)) process.exit(0);
        fail(`Serve failed: ${err.message}`);
      }
    });
}

async function serveModels(model, options, command) {
  // Resolve port: explicit flag > config defaultPort > 8080.
  options.port = options.port || getSetting('defaultPort') || '8080';

  if (!existsSync(LLAMA_SERVER_BIN)) {
    fail(
      'llama-server not found',
      'Install it with: aim backend install llama.cpp'
    );
  }

  ensureDir(MODELS_DIR);

  // Regenerate config.ini right before serving. If MODEL was given, mark that
  // entry to load immediately at startup (others still load on demand).
  const { preloadName } = updateConfigIni({ preload: model });

  if (!existsSync(CONFIG_INI_PATH) || !readFileSync(CONFIG_INI_PATH, 'utf-8').trim()) {
    fail(
      'No GGUF models found to serve.',
      'Download one first, e.g. aim model download <repo>'
    );
  }

  const serveArgs = [
    '--port', options.port,
    '--models-dir', MODELS_DIR,
    '--models-preset', CONFIG_INI_PATH,
    '--models-max', options.modelsMax,
  ];

  // Autoload is on by default: any model loads on demand when first requested
  // (capped by --models-max, LRU-evicted). --no-models-autoload opts out, which
  // commander exposes as options.modelsAutoload === false.
  if (options.modelsAutoload === false) serveArgs.push('--no-models-autoload');

  // Forward any unknown flags to llama-server (excluding the preload positional).
  serveArgs.push(...passthroughArgs(command, model ? [model] : []));

  console.log();
  console.log(chalk.bold.cyan('  Starting llama-server (Router Mode)'));
  console.log(chalk.dim(`  Models Dir: ${MODELS_DIR}`));
  console.log(chalk.dim(`  Preset:     ${CONFIG_INI_PATH}`));
  console.log(chalk.dim(`  Port:       ${options.port}`));
  console.log(chalk.dim(`  Autoload:   ${options.modelsAutoload === false ? 'off (load via API/web UI)' : 'on demand'}`));
  if (preloadName) console.log(chalk.dim(`  Preload:    ${preloadName}`));
  console.log();

  // Run from MODELS_DIR so the preset's model/mmproj paths (relative to the
  // models dir) resolve. The router spawns child instances that inherit this
  // cwd; without it they get a bare relative path and fail to open the GGUF.
  await streamExec(LLAMA_SERVER_BIN, serveArgs, { cwd: MODELS_DIR });
}

/**
 * Regenerate the llama-server router preset (config.ini).
 *
 * config.ini is a *derived* artifact: the registry (aim-models.ini) is the
 * single source of truth, so we refresh it first and then project the GGUF
 * entries into llama-server's preset format. Non-llama.cpp entries (mlx, vllm,
 * or anything the user pinned to those backends) are excluded — the router only
 * serves llama.cpp.
 *
 * Per-model run parameters (temp, ctx-size, thinking, …) set in the registry
 * are translated into preset options so `aim serve` honors the same tuning as
 * `aim run`. Unknown/unsupported keys are dropped by the translator.
 *
 * `preload` (a section name or trailing model name) marks one entry with
 * `load-on-startup = true` so the router loads it immediately; throws if the
 * name matches no servable (llama.cpp) entry.
 */
export function updateConfigIni({ prune = false, preload = null } = {}) {
  ensureDir(MODELS_DIR);

  // Keep the registry in sync with disk, then derive the preset from it.
  const stats = updateModelsRegistry({ prune });

  const sections = existsSync(AIM_MODELS_INI_PATH)
    ? parseIni(readFileSync(AIM_MODELS_INI_PATH, 'utf-8'))
    : new Map();

  // Expand each servable registry section into one router entry *per quant* on
  // disk, so llama-server exposes every quantization as its own selectable
  // model. A repo with a single GGUF keeps its plain section name; a repo with
  // several gets one entry each, suffixed with a short quant label.
  const entries = [];           // { id, repo, model, mmproj, config, isDefault }
  for (const [name, config] of sections) {
    if (!config.model || config.backend === 'mlx' || config.backend === 'vllm') continue;

    const modelRel = stripQuotes(config.model);
    const mmprojRel = config.mmproj ? stripQuotes(config.mmproj) : null;
    const repoRelDir = dirname(modelRel);
    const ggufs = listModelGgufs(join(MODELS_DIR, repoRelDir));

    if (ggufs.length > 1) {
      const defaultName = basename(modelRel);
      for (const gguf of ggufs) {
        entries.push({
          id: `${name}/${quantLabel(gguf, ggufs)}`,
          repo: name,
          model: join(repoRelDir, gguf),
          mmproj: mmprojRel,
          config,
          isDefault: gguf === defaultName,
        });
      }
    } else {
      // Single (or unreadable) repo — keep the existing one-entry behavior.
      entries.push({ id: name, repo: name, model: modelRel, mmproj: mmprojRel, config, isDefault: true });
    }
  }

  // Resolve an optional preload target. Match either a concrete entry id
  // (a specific quant) or a repo section name (→ that repo's default quant).
  let preloadId = null;
  if (preload) {
    const exact = entries.find(e => e.id === preload || e.id.endsWith(`/${preload}`));
    const repoMatch = entries.find(e => e.isDefault && (e.repo === preload || e.repo.endsWith(`/${preload}`)));
    const target = exact || repoMatch;
    if (!target) {
      const available = [...new Set(entries.map(e => e.id))];
      throw new Error(
        `Model not found to preload: ${preload}. ` +
        `Available: ${available.join(', ') || '(none)'}`
      );
    }
    preloadId = target.id;
  }

  let iniContent = '';
  for (const entry of entries) {
    // No surrounding quotes: llama-server's preset parser reads each value
    // verbatim to end-of-line (spaces included) and does NOT strip quotes, so
    // wrapping a path in quotes makes them part of the filename and the open fails.
    iniContent += `[${entry.id}]\n`;
    iniContent += `model = ${entry.model}\n`;
    if (entry.mmproj) iniContent += `mmproj = ${entry.mmproj}\n`;

    // Project per-model run params (sampling, ctx-size, thinking, …) so router
    // mode honors the same registry tuning as `aim run`. Quants of one repo
    // share the registry section's tuning.
    const { args } = buildBackendArgs('llama.cpp', entry.config);
    for (const line of llamaArgsToPresetLines(args)) iniContent += `${line}\n`;

    // Preload target: load this model as soon as the router starts.
    if (entry.id === preloadId) iniContent += 'load-on-startup = true\n';

    iniContent += '\n';
  }

  // Write even when empty so a stale preset is cleared once the last model goes.
  writeFileSync(CONFIG_INI_PATH, iniContent);

  // `preloadName` kept in the return for backward compatibility with callers.
  return { ...stats, preloadName: preloadId };
}

/** Non-mmproj GGUF basenames in a repo dir, largest-first ([] if unreadable). */
function listModelGgufs(repoDir) {
  let dirents;
  try { dirents = readdirSync(repoDir, { withFileTypes: true }); }
  catch { return []; }
  return dirents
    .filter(e => e.isFile() && e.name.endsWith('.gguf') && !e.name.toLowerCase().includes('mmproj'))
    .map(e => ({ name: e.name, size: safeSize(join(repoDir, e.name)) }))
    .sort((a, b) => b.size - a.size)
    .map(e => e.name);
}

function safeSize(p) {
  try { return statSync(p).size; } catch { return 0; }
}

/**
 * A short, unique label for one quant among `allNames`, formed by stripping the
 * shared filename prefix (trimmed back to a separator) and the .gguf extension:
 *   Qwen3.6-27B-UD-Q8_K_XL.gguf  →  Q8_K_XL
 * Falls back to the extension-less basename if the remainder would be empty.
 */
export function quantLabel(name, allNames) {
  const stem = (n) => n.replace(/\.gguf$/i, '');
  const stems = allNames.map(stem);
  let prefix = commonPrefix(stems);
  // Cut the shared prefix back to the last separator so labels start cleanly.
  const cut = Math.max(prefix.lastIndexOf('-'), prefix.lastIndexOf('_'), prefix.lastIndexOf('.')) + 1;
  prefix = prefix.slice(0, cut);
  const label = stem(name).slice(prefix.length).replace(/^[-_.]+/, '');
  return label || stem(name);
}

/** Longest common string prefix across a list of strings. */
function commonPrefix(strings) {
  if (strings.length === 0) return '';
  let prefix = strings[0];
  for (const s of strings.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}
