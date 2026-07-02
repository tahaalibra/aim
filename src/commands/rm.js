import { rmSync, existsSync } from 'fs';
import { join, resolve, sep } from 'path';
import chalk from 'chalk';
import { MODELS_DIR, BACKENDS_DIR, BIN_DIR, LLAMA_CPP_DIR, LLAMA_SERVER_BIN, MLX_VENV_DIR } from '../paths.js';
import { fail, success, info, warn } from '../utils.js';

export function registerModelRm(program) {
  program
    .command('rm')
    .argument('<target>', 'Repository name to remove (e.g. unsloth/gemma-4-26B-A4B-it-GGUF)')
    .description('Remove a downloaded model')
    .action(async (target) => {
      try {
        await removeModel(target);
      } catch (err) {
        fail(`Remove failed: ${err.message}`);
      }
    });
}

export function registerBackendRm(program) {
  program
    .command('rm')
    .argument('<target>', 'Component to uninstall (e.g. llama.cpp, mlx)')
    .description('Uninstall a backend')
    .action(async (target) => {
      try {
        await removeBackend(target);
      } catch (err) {
        fail(`Remove failed: ${err.message}`);
      }
    });
}

async function removeBackend(target) {
  // First, check if it's a backend component
  if (target === 'llama.cpp') {
    info('Removing llama.cpp...');
    tryRm(LLAMA_CPP_DIR);
    
    // Remove symlinks
    const binaries = ['llama-server', 'llama-cli', 'llama-quantize', 'llama-bench'];
    for (const bin of binaries) {
      tryRm(join(BIN_DIR, bin));
    }
    success('llama.cpp removed');
    return;
  }

  if (target === 'mlx') {
    info('Removing mlx venv...');
    tryRm(MLX_VENV_DIR);
    success('mlx removed');
    return;
  }
  
  fail(`Target not found: ${target}`, `Available backends: llama.cpp, mlx`);
}

async function removeModel(target) {
  // Reject anything that would escape the models directory (path traversal).
  if (!target || target === '.' || target === '/' || target.includes('..')) {
    fail('Invalid target', 'Use a repo name like org/repo, e.g. aim model rm unsloth/gemma-3-GGUF');
  }

  const modelDir = join(MODELS_DIR, target);
  const resolved = resolve(modelDir);
  if (resolved !== resolve(MODELS_DIR) && !resolved.startsWith(resolve(MODELS_DIR) + sep)) {
    fail(`Refusing to remove path outside the models directory: ${target}`);
  }
  if (resolved === resolve(MODELS_DIR)) {
    fail('Refusing to remove the entire models directory');
  }

  if (existsSync(modelDir)) {
    info(`Removing model ${chalk.bold(target)}...`);
    tryRm(modelDir);
    
    // Clean up empty organization directory if necessary
    const parts = target.split('/');
    if (parts.length > 1) {
      const orgDir = join(MODELS_DIR, parts[0]);
      if (existsSync(orgDir)) {
        const { readdirSync } = await import('fs');
        const contents = readdirSync(orgDir);
        if (contents.length === 0) {
          tryRm(orgDir);
        }
      }
    }
    
    success(`Model ${target} removed`);
  } else {
    fail(`Target not found: ${target}`, `Run \`aim list\` to see available models and backends`);
  }
}

function tryRm(path) {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
}
