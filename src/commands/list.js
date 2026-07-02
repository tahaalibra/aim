import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import prettyBytes from 'pretty-bytes';
import chalk from 'chalk';
import {
  MODELS_DIR, LLAMA_SERVER_BIN,
  MLX_VENV_DIR, MLX_PYTHON,
  VLLM_VENV_DIR, VLLM_PYTHON,
  AIM_MODELS_INI_PATH,
} from '../paths.js';
import { dirSize, quietExec, info, getHfVersion, parseIni } from '../utils.js';
import { findModelRepos, inferBackend } from '../models.js';
import { execa } from 'execa';

// Re-exported for backward compatibility (and tests).
export { inferBackend };

// Display order + tint for backend groups.
const BACKEND_GROUPS = [
  ['llama.cpp', chalk.cyan],
  ['mlx', chalk.magenta],
  ['vllm', chalk.green],
  ['unknown', chalk.dim],
];

export function registerModelList(program) {
  program
    .command('list')
    .option('--sort <field>', 'Sort by: size (default), name', 'size')
    .option('--json', 'Output machine-readable JSON instead of the formatted view')
    .description('List downloaded models, grouped by backend')
    .action(async (options) => {
      await listModels(options);
    });
}

export function registerBackendList(program) {
  program
    .command('list')
    .description('List installed backends')
    .action(async () => {
      await listBackends();
    });
}

async function listModels(options) {
  if (!existsSync(MODELS_DIR)) {
    if (options.json) { console.log('[]'); return; }
    info('No models directory found.'); return;
  }

  const models = buildModelList(MODELS_DIR);
  sortModels(models, options.sort);

  if (options.json) {
    console.log(JSON.stringify(models.map(toJson), null, 2));
    return;
  }

  if (!models.length) {
    info('No models downloaded yet.'); return;
  }
  renderHuman(models);
}

/**
 * Describe every downloaded model: backend, total on-disk size, quantizations
 * (largest-first, with the registry default flagged), and capability tags.
 * Pure (no I/O beyond the filesystem) so it can be tested directly.
 */
export function buildModelList(baseDir = MODELS_DIR) {
  const defaults = loadRegistryDefaults();
  return findModelRepos(baseDir).map((repo) => {
    const name = repo.relPath;
    const backend = inferBackend(repo.path);
    const sizeBytes = dirSize(repo.path);

    const modelGgufs = repo.ggufs.filter(f => !f.toLowerCase().includes('mmproj'));
    const vision = repo.ggufs.some(f => f.toLowerCase().includes('mmproj'));
    const defaultFile = defaults.get(name);

    const quants = modelGgufs.map(file => ({
      label: quantTag(file),
      file,
      sizeBytes: safeSize(join(repo.path, file)),
    }));
    // Default quant: the registry's pick, else the largest (first) on disk.
    const def = quants.find(q => q.file === defaultFile)?.label
      ?? quants[0]?.label
      ?? null;

    // MLX/safetensors repos have no GGUF quants; surface bit-width if the name
    // encodes one (…-8bit, …-4bit) so the row isn't bare.
    const bits = backend !== 'llama.cpp'
      ? (name.match(/(\d+)\s*bit/i)?.[0]?.replace(/\s+/g, '').toLowerCase() ?? null)
      : null;

    return { name, path: repo.path, backend, sizeBytes, vision, default: def, bits, quants };
  });
}

/** Map of registry section → default GGUF basename (from aim-models.ini). */
function loadRegistryDefaults() {
  const map = new Map();
  if (!existsSync(AIM_MODELS_INI_PATH)) return map;
  try {
    for (const [name, cfg] of parseIni(readFileSync(AIM_MODELS_INI_PATH, 'utf-8'))) {
      if (cfg.model) map.set(name, basename(cfg.model));
    }
  } catch { /* ignore a malformed registry */ }
  return map;
}

/** Extract a short quant tag from a GGUF filename (Q4_K_XL, BF16, …). */
export function quantTag(file) {
  const stem = file.replace(/\.gguf$/i, '');
  const m = stem.match(/I?Q\d+(_[A-Z0-9]+)*|BF16|F16|F32|\d+bit/i);
  return m ? m[0] : stem;
}

function safeSize(p) {
  try { return statSync(p).size; } catch { return 0; }
}

function sortModels(models, sort) {
  if (sort === 'name') models.sort((a, b) => a.name.localeCompare(b.name));
  else models.sort((a, b) => b.sizeBytes - a.sizeBytes);
}

function toJson(m) {
  return {
    name: m.name,
    backend: m.backend,
    sizeBytes: m.sizeBytes,
    vision: m.vision,
    default: m.default,
    ...(m.bits ? { bits: m.bits } : {}),
    quants: m.quants,
  };
}

// ─── Human rendering ────────────────────────────────────────

const NAME_W = 40;  // model-name column width
const META_W = 16;  // quant/capability column width
const SIZE_W = 9;   // right-aligned size column width

function renderHuman(models) {
  const totalBytes = models.reduce((s, m) => s + m.sizeBytes, 0);
  console.log();
  console.log(`  ${chalk.bold('Models in')} ${chalk.dim(MODELS_DIR)}`);
  console.log(`  ${chalk.dim(`${models.length} model${models.length === 1 ? '' : 's'} · ${prettyBytes(totalBytes)}`)}`);

  for (const [backend, color] of BACKEND_GROUPS) {
    const group = models.filter(m => m.backend === backend);
    if (!group.length) continue;
    console.log();
    console.log(`  ${color.bold(backend)} ${chalk.dim(`(${group.length})`)}`);

    // Sub-group by model family (gemma-4, Qwen3.6, Phi-4, …). Family order
    // follows the already-applied sort (largest member first under --sort size).
    for (const { family, models: fam } of groupByFamily(group)) {
      console.log();
      console.log(`    ${chalk.bold(family)} ${chalk.dim(`(${fam.length})`)}`);
      for (const m of fam) renderModel(m, 6);
    }
  }
  console.log();
}

/**
 * Group models by family, preserving the input order so family order tracks the
 * active sort. Family is derived from the repo name's leading name+version.
 */
function groupByFamily(models) {
  const map = new Map();
  for (const m of models) {
    const fam = familyOf(m.name);
    if (!map.has(fam)) map.set(fam, []);
    map.get(fam).push(m);
  }
  return [...map].map(([family, models]) => ({ family, models }));
}

/**
 * Derive a model family from a repo path, e.g.
 *   unsloth/Qwen3.6-27B-MTP-GGUF   → Qwen3.6   (version already in token 0)
 *   unsloth/gemma-4-31B-it-GGUF    → gemma-4   (name + numeric version)
 *   CohereLabs/BLS-Mini-Code-1.0   → BLS
 */
export function familyOf(name) {
  const base = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
  const tokens = base.split('-');
  if (/\d/.test(tokens[0])) return tokens[0];
  if (tokens[1] && /^\d+(\.\d+)?$/.test(tokens[1])) return `${tokens[0]}-${tokens[1]}`;
  return tokens[0];
}

function renderModel(m, indent) {
  const multi = m.quants.length > 1;

  // Meta column: quant count for multi-quant models, else the single quant
  // tag (or MLX bit-width), plus a vision tag when an mmproj is present.
  const tags = [];
  if (multi) tags.push(`${m.quants.length} quants`);
  else if (m.quants.length === 1) tags.push(m.quants[0].label);
  else if (m.bits) tags.push(m.bits);
  if (m.vision) tags.push('vision');

  printRow(indent, m.name, tags.join('·'), prettyBytes(m.sizeBytes), chalk.bold, chalk.dim, chalk.dim);

  if (multi) {
    for (const q of m.quants) printQuant(q.label, prettyBytes(q.sizeBytes), indent);
  }
}

/** A top-level model row: name … meta … size, padded on plain-text widths. */
function printRow(indent, name, meta, size, nameColor, metaColor, sizeColor) {
  const nameStr = name.length > NAME_W ? name.slice(0, NAME_W - 1) + '…' : name;
  console.log(
    ' '.repeat(indent) +
    nameColor(nameStr.padEnd(NAME_W)) +
    metaColor(meta.padEnd(META_W)) +
    sizeColor(size.padStart(SIZE_W)),
  );
}

/** A nested quant row under a multi-quant model, indented two past the model. */
function printQuant(label, size, parentIndent) {
  // Align the size under the parent model's size column (independent of indent).
  const fieldW = NAME_W + META_W - 2;
  const fill = ' '.repeat(Math.max(1, fieldW - label.length));
  console.log(' '.repeat(parentIndent + 2) + chalk.dim(label) + fill + chalk.dim(size.padStart(SIZE_W)));
}

export function findRepos(base) {
  return findModelRepos(base).map(r => r.path);
}

export function getFiles(p) {
  return readdirSync(p, { withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => ({ name: e.name, size: statSync(join(p, e.name)).size }))
    .sort((a, b) => b.size - a.size);
}

async function listBackends() {
  console.log(`\n  ${chalk.bold('Backends')}\n`);

  const llamaOk = existsSync(LLAMA_SERVER_BIN);
  let llamaV = '';
  if (llamaOk) {
    try {
      const { stderr } = await execa(LLAMA_SERVER_BIN, ['--version'], { stdio: 'pipe' });
      const m1 = stderr.match(/version:\s*(.+)$/im);
      llamaV = m1 ? m1[1].trim() : '';
    } catch { /* ignore */ }
  }
  row('llama.cpp', llamaOk, llamaV, llamaOk ? LLAMA_SERVER_BIN : '');

  const mlxOk = existsSync(MLX_PYTHON);
  let mlxV = mlxOk ? (await quietExec(MLX_PYTHON, ['-c', 'import mlx_lm; print(f"mlx-lm {mlx_lm.__version__}")']) || '') : '';
  row('mlx', mlxOk, mlxV, mlxOk ? MLX_VENV_DIR : '');

  const vllmOk = existsSync(VLLM_PYTHON);
  let vllmV = vllmOk ? (await quietExec(VLLM_PYTHON, ['-c', 'import vllm; print(f"vllm {vllm.__version__}")']) || '') : '';
  row('vllm', vllmOk, vllmV, vllmOk ? VLLM_VENV_DIR : '');

  const hfInfo = await getHfVersion();
  row('huggingface', !!hfInfo, hfInfo?.version || '', '');
  console.log();
}

function row(name, ok, ver, path) {
  const st = ok ? chalk.green('✓ installed'.padEnd(18)) : chalk.red('✗ not installed'.padEnd(18));
  console.log(`  ${chalk.bold(name.padEnd(14))} ${st} ${chalk.dim((ver || '').padEnd(30))} ${chalk.dim(path)}`);
}
