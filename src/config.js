import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import chalk from 'chalk';
import { CONFIG_PATH } from './paths.js';
import { ensureDir, fail, success } from './utils.js';

/**
 * Global aim settings, persisted at ~/ai/config.json. These are user defaults
 * that individual commands fall back to when a flag isn't given.
 */
export const SETTINGS = {
  defaultPort:    'Default server port for run/serve (e.g. 8080)',
  defaultBackend: 'Preferred backend hint when detection is ambiguous (llama.cpp|mlx)',
  preferredQuant: 'Default --include glob for downloads (e.g. *Q8_K_XL*)',
};

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

export function saveConfig(config) {
  ensureDir(dirname(CONFIG_PATH));
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

/** Read a single setting, or undefined if unset. */
export function getSetting(key) {
  return loadConfig()[key];
}

export function registerConfig(program) {
  program
    .command('config [key] [value]')
    .description('Get or set global aim settings (~/ai/config.json)')
    .action((key, value) => {
      const config = loadConfig();

      // No key → list everything.
      if (!key) {
        console.log();
        console.log(chalk.bold('  aim config') + chalk.dim(`   ${CONFIG_PATH}`));
        console.log();
        for (const [k, desc] of Object.entries(SETTINGS)) {
          const v = config[k];
          const shown = v != null ? chalk.green(String(v)) : chalk.dim('(unset)');
          console.log(`    ${chalk.bold(k.padEnd(16))} ${shown}`);
          console.log(`    ${chalk.dim(desc)}`);
          console.log();
        }
        return;
      }

      if (!(key in SETTINGS)) {
        fail(`Unknown setting: ${key}`, `Valid keys: ${Object.keys(SETTINGS).join(', ')}`);
      }

      // Key only → get.
      if (value === undefined) {
        const v = config[key];
        console.log(v != null ? String(v) : '');
        return;
      }

      // Key + value → set.
      config[key] = value;
      saveConfig(config);
      success(`Set ${key} = ${value}`);
    });
}
