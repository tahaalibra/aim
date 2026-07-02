import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { MODELS_DIR } from './paths.js';

const MODEL_EXT = /\.(gguf|safetensors|npz)$/;

function dirEntries(p) {
  try {
    return readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeSize(p) {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/**
 * Inspect a single directory and classify it as a model repo.
 * Returns { hasModel, ggufs (largest-first), isMlx }.
 */
function classifyRepo(repoPath) {
  const files = dirEntries(repoPath).filter(e => e.isFile());
  const ggufs = files
    .filter(e => e.name.endsWith('.gguf'))
    .map(e => ({ name: e.name, size: safeSize(join(repoPath, e.name)) }))
    .sort((a, b) => b.size - a.size)
    .map(e => e.name);
  const hasSafetensors = files.some(e => e.name.endsWith('.safetensors'));
  const hasConfig = files.some(e => e.name === 'config.json');
  const hasModel = files.some(e => MODEL_EXT.test(e.name));
  const isMlx = hasConfig && hasSafetensors;
  return { hasModel, ggufs, isMlx };
}

function makeRepo(baseDir, path, info) {
  return {
    path,
    relPath: path.slice(baseDir.length + 1),
    ggufs: info.ggufs,
    hasGguf: info.ggufs.length > 0,
    isMlx: info.isMlx,
  };
}

/**
 * Discover model repos under baseDir, scanning up to two levels deep
 * (e.g. `org/repo`). Only directories that actually contain a model file
 * (.gguf/.safetensors/.npz) are returned.
 *
 * Returns [{ path, relPath, ggufs, hasGguf, isMlx }].
 */
export function findModelRepos(baseDir = MODELS_DIR) {
  const repos = [];
  if (!existsSync(baseDir)) return repos;

  for (const entry of dirEntries(baseDir)) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const topPath = join(baseDir, entry.name);
    const top = classifyRepo(topPath);
    if (top.hasModel) {
      repos.push(makeRepo(baseDir, topPath, top));
      continue;
    }

    // Otherwise treat it as an org dir and look one level deeper.
    for (const sub of dirEntries(topPath)) {
      if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
      const repoPath = join(topPath, sub.name);
      const info = classifyRepo(repoPath);
      if (info.hasModel) repos.push(makeRepo(baseDir, repoPath, info));
    }
  }

  return repos;
}

/**
 * The GGUF model file to load (largest non-mmproj), or null.
 */
export function pickModelGguf(ggufs) {
  return ggufs.find(f => !f.toLowerCase().includes('mmproj')) || null;
}

/**
 * The mmproj (multimodal projector) GGUF file, or null.
 */
export function pickMmproj(ggufs) {
  return ggufs.find(f => f.toLowerCase().includes('mmproj')) || null;
}

function hasGgufDeep(dir) {
  for (const entry of dirEntries(dir)) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isFile()) {
      if (entry.name.endsWith('.gguf')) return true;
    } else if (entry.isDirectory()) {
      if (hasGgufDeep(join(dir, entry.name))) return true;
    }
  }
  return false;
}

/**
 * Pick a concrete backend to run a model with: 'llama.cpp' if any GGUF is
 * present (searched recursively), otherwise 'mlx'. Used when launching a server.
 */
export function detectBackend(modelDir) {
  return hasGgufDeep(modelDir) ? 'llama.cpp' : 'mlx';
}

/**
 * Resolve which backend to launch a model with, applying precedence:
 *   explicit CLI flag  >  ini `backend=` field  >  on-disk detection.
 * `explicit` and `configBackend` may be undefined/null.
 */
export function resolveBackend({ explicit, configBackend, modelDir }) {
  return explicit || configBackend || detectBackend(modelDir);
}

/**
 * Infer a backend for display purposes: 'llama.cpp', 'mlx', or 'unknown'.
 * Stricter than detectBackend — does not assume mlx as a fallback.
 */
export function inferBackend(modelDir) {
  const files = dirEntries(modelDir);
  if (files.some(e => e.isFile() && e.name.endsWith('.gguf'))) return 'llama.cpp';
  const hasConfig = files.some(e => e.isFile() && e.name === 'config.json');
  const hasWeights = files.some(e => e.isFile() && /\.(safetensors|npz)$/.test(e.name));
  if (hasConfig && hasWeights) return 'mlx';
  return 'unknown';
}
