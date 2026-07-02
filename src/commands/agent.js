import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import chalk from 'chalk';
import { AIM_MODELS_INI_PATH, MODELS_DIR } from '../paths.js';
import { ensureDir, fail, success, info, warn, parseIni, stripQuotes } from '../utils.js';
import { getSetting } from '../config.js';

/**
 * `aim agent <target> [--update]` exports the model registry (aim-models.ini)
 * into an external agent runtime's config, pointing it at the local inference
 * server (OpenAI-compatible, http://localhost:<port>/v1).
 *
 * Without --update the command is a dry run: it prints the config it would
 * write. With --update it merges into the target file (preserving entries it
 * doesn't manage) after taking a `.bak` backup.
 *
 * NOTE: the exact on-disk schemas for these third-party tools can change between
 * versions. Each exporter documents the shape it writes; review the result and
 * adjust the renderer if your tool version differs.
 */

const EXPORTERS = {
  pi: {
    label: 'pi',
    targetPath: () => join(homedir(), '.pi', 'agent', 'models.json'),
    render: renderPi,
  },
  zed: {
    label: 'Zed',
    targetPath: () => join(homedir(), '.config', 'zed', 'settings.json'),
    render: renderZed,
  },
};

export function registerAgent(program) {
  program
    .command('agent <target>')
    .option('--update', 'Write the config (otherwise prints a dry-run preview)')
    .option('--port <port>', 'Local server port the agent should connect to')
    .description(`Export the model registry to an agent runtime (${Object.keys(EXPORTERS).join(', ')})`)
    .action((target, options) => {
      const exporter = EXPORTERS[target];
      if (!exporter) {
        fail(`Unknown agent target: ${target}`, `Supported: ${Object.keys(EXPORTERS).join(', ')}`);
      }

      const models = loadRegistryModels();
      if (models.length === 0) {
        fail('No models in the registry', 'Build it first: aim model config');
      }

      const port = options.port || getSetting('defaultPort') || '8080';
      const baseUrl = `http://localhost:${port}/v1`;

      const path = exporter.targetPath();
      const existing = readJsonSafe(path);
      const next = exporter.render(existing, models, baseUrl);
      const rendered = JSON.stringify(next, null, 2) + '\n';

      if (!options.update) {
        console.log();
        info(`Dry run for ${chalk.bold(exporter.label)} → ${chalk.dim(path)}`);
        info(`${models.length} model(s), endpoint ${chalk.dim(baseUrl)}`);
        console.log(chalk.dim('  Re-run with --update to write.'));
        console.log();
        console.log(rendered);
        return;
      }

      ensureDir(dirname(path));
      if (existsSync(path)) {
        copyFileSync(path, path + '.bak');
        info(`Backed up existing config → ${chalk.dim(path + '.bak')}`);
      }
      writeFileSync(path, rendered);
      success(`Updated ${exporter.label} with ${models.length} model(s) → ${path}`);
    });
}

// ─── Registry → model list ──────────────────────────────────

function loadRegistryModels() {
  if (!existsSync(AIM_MODELS_INI_PATH)) return [];
  const sections = parseIni(readFileSync(AIM_MODELS_INI_PATH, 'utf-8'));
  const models = [];
  for (const [name, config] of sections) {
    const backend = config.backend || 'llama.cpp';
    // The id must match what the server actually serves the model under:
    //   - llama.cpp: the `--alias` we pass (config alias, else the section name)
    //   - mlx: mlx_lm.server has no alias, so it serves under the model path it
    //     was launched with. Requesting by repo id instead re-resolves to the HF
    //     cache (and re-downloads/404s), so advertise the local path.
    const id = backend === 'mlx'
      ? join(MODELS_DIR, name)
      : (config.alias ? stripQuotes(config.alias) : name);
    models.push({ id, backend });
  }
  return models;
}

function readJsonSafe(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    warn(`Existing ${path} is not valid JSON — it will be replaced (a .bak is kept).`);
    return null;
  }
}

// ─── Exporters ──────────────────────────────────────────────

const MANAGED = 'aim'; // marker used by older versions; cleaned up on re-export.
const PI_PROVIDER = 'AIM'; // the pi provider aim manages.

/**
 * pi (~/.pi/agent/models.json): models are grouped under a named provider with
 * an OpenAI-compatible endpoint. aim manages a provider named "AIM"; other
 * providers (and all other top-level keys) are preserved.
 *
 *   { "providers": { "AIM": { baseUrl, api, apiKey, models: [{ id }] } } }
 */
function renderPi(existing, models, baseUrl) {
  const base = existing && typeof existing === 'object' ? { ...existing } : {};

  base.providers = { ...(base.providers || {}) };
  base.providers[PI_PROVIDER] = {
    baseUrl,
    api: 'openai-completions',
    apiKey: 'no-key',
    models: models.map(m => ({ id: m.id })),
  };

  // Clean up the top-level `models` array written by older aim versions.
  if (Array.isArray(base.models)) {
    const kept = base.models.filter(m => m?.managed_by !== MANAGED);
    if (kept.length) base.models = kept;
    else delete base.models;
  }

  return base;
}

/**
 * Zed (~/.config/zed/settings.json): a custom OpenAI-compatible endpoint under
 * `language_models.openai`. We set `api_url` and `available_models`. Other
 * settings keys are preserved.
 *
 * NOTE: this schema is unverified against current Zed versions — review the
 * output before relying on it.
 */
function renderZed(existing, models, baseUrl) {
  const base = existing && typeof existing === 'object' ? { ...existing } : {};
  const languageModels = { ...(base.language_models || {}) };
  const openai = { ...(languageModels.openai || {}) };

  openai.api_url = baseUrl;
  openai.available_models = models.map(m => ({
    name: m.id,
    display_name: m.id,
    max_tokens: 8192,
  }));

  languageModels.openai = openai;
  base.language_models = languageModels;
  return base;
}
