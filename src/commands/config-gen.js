import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { MODELS_DIR, AIM_MODELS_INI_PATH } from '../paths.js';
import { ensureDir, fail, info, success, parseIni } from '../utils.js';
import { findModelRepos, pickModelGguf, pickMmproj } from '../models.js';

export function registerConfigGen(program) {
  program
    .command('config-gen')
    .option('--prune', 'Remove sections whose model is no longer present on disk')
    .description('Generate or update aim-models.ini with all discovered models (preserves manual edits)')
    .action((options) => {
      try {
        const stats = updateModelsRegistry({ prune: !!options.prune });
        console.log();
        success('aim-models.ini generated successfully');
        const pruned = stats.pruned ? `, ${stats.pruned} pruned` : '';
        info(chalk.dim(`  ${stats.total} total models (${stats.preserved} preserved, ${stats.added} added${pruned})`));
      } catch (err) {
        fail(`config-gen failed: ${err.message}`);
      }
    });
}

/**
 * Generate or update aim-models.ini — the single source of truth for per-model
 * run configuration.
 *
 * - Preserves existing sections (manual user edits are not overwritten).
 * - Adds new model sections discovered on disk that don't already exist.
 * - With `prune`, removes sections whose model directory no longer exists.
 *
 * Returns counts: { total, added, preserved, pruned }.
 */
export function updateModelsRegistry({ prune = false } = {}) {
  ensureDir(MODELS_DIR);

  // Discover models on disk (two levels deep, only dirs with model files).
  const repos = findModelRepos(MODELS_DIR);
  const onDisk = new Set(repos.map(r => r.relPath));

  // Parse existing file if present.
  const existing = existsSync(AIM_MODELS_INI_PATH)
    ? parseIni(readFileSync(AIM_MODELS_INI_PATH, 'utf-8'))
    : new Map();

  const merged = new Map(existing);
  let prunedCount = 0;

  if (prune) {
    for (const name of [...merged.keys()]) {
      if (!onDisk.has(name)) {
        merged.delete(name);
        prunedCount++;
      }
    }
  }

  // Add newly discovered models, keeping existing sections untouched.
  let addedCount = 0;
  for (const repo of repos) {
    if (merged.has(repo.relPath)) continue;

    if (repo.hasGguf) {
      const sectionConfig = { backend: 'llama.cpp' };
      const modelGguf = pickModelGguf(repo.ggufs);
      if (modelGguf) sectionConfig.model = join(repo.relPath, modelGguf);
      const mmproj = pickMmproj(repo.ggufs);
      if (mmproj) sectionConfig.mmproj = join(repo.relPath, mmproj);
      merged.set(repo.relPath, sectionConfig);
      addedCount++;
    } else if (repo.isMlx) {
      merged.set(repo.relPath, { backend: 'mlx' });
      addedCount++;
    }
  }

  writeFileSync(AIM_MODELS_INI_PATH, serializeIni(merged));

  return {
    total: merged.size,
    added: addedCount,
    pruned: prunedCount,
    preserved: existing.size - prunedCount,
  };
}

/** Serialize a Map of section → config back to INI text. */
function serializeIni(sections) {
  let content = '';
  for (const [name, config] of sections) {
    content += `[${name}]\n`;
    for (const [key, value] of Object.entries(config)) {
      const str = String(value);
      const needsQuotes = str.includes(' ') || str.includes('"');
      content += `${key} = ${needsQuotes ? `"${str}"` : str}\n`;
    }
    content += '\n';
  }
  return content;
}
