import { existsSync, unlinkSync, symlinkSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import {
  BACKENDS_DIR, BIN_DIR, LLAMA_CPP_DIR,
  MLX_VENV_DIR, MLX_PYTHON,
  VLLM_VENV_DIR, VLLM_PYTHON
} from '../paths.js';
import {
  ensureDir, fail, success, info, warn,
  streamExec, quietExec, isAppleSilicon, checkCommand, nproc, getHfVersion
} from '../utils.js';

export function registerInstall(program) {
  program
    .command('install')
    .argument('<component>', 'Component to install (llama.cpp, mlx, vllm, huggingface, all)')
    .option('--force', 'Force reinstall/rebuild even if already installed')
    .option('-d, --debug', 'Print each subprocess command before it runs')
    .description('Install or update a backend component')
    .action(async (component, options) => {
      try {
        await installComponent(component, options);
      } catch (err) {
        fail(`Install failed: ${err.message}`);
      }
    });
}

async function installComponent(component, options) {
  const handlers = {
    'llama.cpp': installLlamaCpp,
    'mlx': installMlx,
    'vllm': installVllm,
    'huggingface': installHuggingface,
    'all': async (opts) => {
      await installHuggingface(opts);
      await installLlamaCpp(opts);
      await installMlx(opts);
    },
  };

  const handler = handlers[component];
  if (!handler) {
    fail(
      `Unknown component: ${component}`,
      `Supported: ${Object.keys(handlers).join(', ')}`
    );
  }

  await handler(options);
}

// `all` intentionally skips vllm: it's a large, CUDA/Linux-oriented install that
// doesn't fit the Apple-Silicon default path, so it's opt-in only.

// ─── llama.cpp ──────────────────────────────────────────────

async function installLlamaCpp(options) {
  console.log();
  console.log(chalk.bold.cyan('  llama.cpp'));
  console.log(chalk.dim('  ─────────────────────────'));

  if (!(await checkCommand('git'))) fail('git is not installed', 'Install git first');
  if (!(await checkCommand('cmake'))) fail('cmake is not installed', 'Install cmake first (e.g. brew install cmake)');

  ensureDir(BACKENDS_DIR);
  ensureDir(BIN_DIR);

  const alreadyCloned = existsSync(join(LLAMA_CPP_DIR, '.git'));

  if (alreadyCloned) {
    // Update an existing shallow clone. `pull --ff-only` breaks when upstream
    // force-pushes or the shallow tip can't fast-forward, so fetch + reset.
    info(options.force ? 'Force rebuild — updating llama.cpp…' : 'llama.cpp already cloned — updating…');
    await streamExec('git', ['-C', LLAMA_CPP_DIR, 'fetch', '--depth', '1', 'origin', 'HEAD']);
    await streamExec('git', ['-C', LLAMA_CPP_DIR, 'reset', '--hard', 'FETCH_HEAD']);
  } else {
    info('Cloning llama.cpp…');
    await streamExec('git', [
      'clone', '--depth', '1',
      'https://github.com/ggml-org/llama.cpp.git',
      LLAMA_CPP_DIR,
    ]);
  }

  // Build
  console.log();
  info('Building llama.cpp…');
  const buildDir = join(LLAMA_CPP_DIR, 'build');

  const cmakeArgs = ['-B', buildDir, '-DCMAKE_BUILD_TYPE=Release'];

  // Enable Metal on Apple Silicon
  if (isAppleSilicon()) {
    cmakeArgs.push('-DGGML_METAL=ON');
    info('Apple Silicon detected — enabling Metal acceleration');
  }

  await streamExec('cmake', cmakeArgs, { cwd: LLAMA_CPP_DIR });

  await streamExec('cmake', ['--build', buildDir, '-j', String(nproc())], {
    cwd: LLAMA_CPP_DIR,
  });

  // Symlink binaries to ~/ai/bin/
  console.log();
  info('Symlinking binaries to ~/ai/bin/…');

  const binaries = ['llama-server', 'llama-cli', 'llama-quantize', 'llama-bench'];
  let linkedServer = false;
  for (const bin of binaries) {
    const srcPaths = [
      join(buildDir, 'bin', bin),
      join(buildDir, bin),
    ];
    const src = srcPaths.find(p => existsSync(p));
    if (src) {
      const dest = join(BIN_DIR, bin);
      try { unlinkSync(dest); } catch { /* ignore */ }
      symlinkSync(src, dest);
      if (bin === 'llama-server') linkedServer = true;
      console.log(`  ${chalk.dim('→')} ${bin}`);
    }
  }

  if (!linkedServer) {
    fail(
      'Build finished but llama-server binary was not found',
      `Check the build output above. Expected under ${buildDir}/bin/`,
    );
  }

  console.log();
  success('llama.cpp installed successfully');
}

// ─── MLX ────────────────────────────────────────────────────

async function installMlx(options) {
  console.log();
  console.log(chalk.bold.magenta('  MLX'));
  console.log(chalk.dim('  ─────────────────────────'));

  if (!isAppleSilicon()) {
    warn('MLX requires Apple Silicon. Installation may not work on this system.');
  }

  // Prefer stable Python versions (3.12 > 3.11 > 3.13 > python3)
  const pythonCandidates = ['python3.12', 'python3.11', 'python3.13', 'python3'];
  let python = null;
  for (const candidate of pythonCandidates) {
    if (await checkCommand(candidate)) {
      python = candidate;
      break;
    }
  }
  if (!python) fail('Python 3 is not installed', 'Install via: brew install python@3.12');

  const pyVersion = await quietExec(python, ['-c', "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"]);
  info(`Using ${python} (${pyVersion})`);

  // Detect package manager: prefer uv over pip (avoids ensurepip issues)
  const useUv = await checkCommand('uv');

  ensureDir(BACKENDS_DIR);

  const venvExists = existsSync(join(MLX_VENV_DIR, 'bin', 'python'));

  if (!venvExists || options.force) {
    if (venvExists && options.force) {
      info('Force reinstall — recreating venv…');
    } else {
      info('Creating Python venv for MLX…');
    }

    if (useUv) {
      await streamExec('uv', ['venv', MLX_VENV_DIR, '--python', python]);
    } else {
      await streamExec(python, ['-m', 'venv', MLX_VENV_DIR]);
    }
  }

  info('Installing/upgrading mlx-lm…');

  if (useUv) {
    // uv pip install --python <path> doesn't need pip in the venv at all
    await streamExec('uv', ['pip', 'install', '--python', MLX_PYTHON, '-q', 'mlx-lm']);
  } else {
    await streamExec(MLX_PYTHON, ['-m', 'pip', 'install', '-U', 'mlx-lm']);
  }

  // Verify installation
  const version = await quietExec(MLX_PYTHON, [
    '-c', 'import mlx_lm; print(mlx_lm.__version__)',
  ]);

  if (version) {
    console.log();
    success(`mlx-lm ${chalk.bold(version)} installed successfully`);
  } else {
    console.log();
    warn('mlx-lm installed but could not verify version');
  }
}


// ─── vLLM ───────────────────────────────────────────────────

async function installVllm(options) {
  console.log();
  console.log(chalk.bold.green('  vLLM'));
  console.log(chalk.dim('  ─────────────────────────'));

  if (isAppleSilicon()) {
    warn('vLLM targets Linux + NVIDIA/AMD GPUs. On Apple Silicon the install may');
    warn('fail or fall back to a slow CPU build — vLLM has no Metal backend.');
  }

  // Prefer stable Python versions (3.12 > 3.11 > 3.13 > python3)
  const pythonCandidates = ['python3.12', 'python3.11', 'python3.13', 'python3'];
  let python = null;
  for (const candidate of pythonCandidates) {
    if (await checkCommand(candidate)) {
      python = candidate;
      break;
    }
  }
  if (!python) fail('Python 3 is not installed', 'Install via: brew install python@3.12');

  const pyVersion = await quietExec(python, ['-c', "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"]);
  info(`Using ${python} (${pyVersion})`);

  // Detect package manager: prefer uv over pip (avoids ensurepip issues)
  const useUv = await checkCommand('uv');

  ensureDir(BACKENDS_DIR);

  const venvExists = existsSync(join(VLLM_VENV_DIR, 'bin', 'python'));

  if (!venvExists || options.force) {
    if (venvExists && options.force) {
      info('Force reinstall — recreating venv…');
    } else {
      info('Creating Python venv for vLLM…');
    }

    if (useUv) {
      await streamExec('uv', ['venv', VLLM_VENV_DIR, '--python', python]);
    } else {
      await streamExec(python, ['-m', 'venv', VLLM_VENV_DIR]);
    }
  }

  info('Installing/upgrading vllm (this pulls a large CUDA wheel and can take a while)…');

  if (useUv) {
    await streamExec('uv', ['pip', 'install', '--python', VLLM_PYTHON, '-U', 'vllm']);
  } else {
    await streamExec(VLLM_PYTHON, ['-m', 'pip', 'install', '-U', 'vllm']);
  }

  // Verify installation
  const version = await quietExec(VLLM_PYTHON, [
    '-c', 'import vllm; print(vllm.__version__)',
  ]);

  if (version) {
    console.log();
    success(`vllm ${chalk.bold(version)} installed successfully`);
  } else {
    console.log();
    warn('vllm installed but could not verify version (it may need a GPU to import)');
  }
}



// ─── HuggingFace ────────────────────────────────────────────

async function installHuggingface(options) {
  console.log();
  console.log(chalk.bold.yellow('  HuggingFace CLI'));
  console.log(chalk.dim('  ─────────────────────────'));

  const existing = await getHfVersion();
  if (existing && !options.force) {
    info(`Already installed: ${chalk.bold(`${existing.cli} ${existing.version}`)}`);
    info('Use --force to upgrade');
    return;
  }

  // System pip is often externally managed (PEP 668, e.g. Homebrew Python),
  // so prefer package managers that isolate the install: brew > uv > pipx.
  if (await checkCommand('brew')) {
    const brewInstalled = (await quietExec('brew', ['list', 'hf'])) !== null;
    if (brewInstalled) {
      info('Upgrading hf via Homebrew…');
      await streamExec('brew', ['upgrade', 'hf']);
    } else {
      info('Installing hf via Homebrew…');
      await streamExec('brew', ['install', 'hf']);
    }
  } else if (await checkCommand('uv')) {
    info('Installing hf via uv tool…');
    await streamExec('uv', ['tool', 'install', '--upgrade', 'huggingface_hub[cli]']);
  } else if (await checkCommand('pipx')) {
    info('Installing hf via pipx…');
    if (options.force) {
      await streamExec('pipx', ['install', '--force', 'huggingface_hub[cli]']);
    } else {
      await streamExec('pipx', ['install', 'huggingface_hub[cli]']);
    }
  } else if (await checkCommand('pip3')) {
    // Last resort — fails on externally-managed Pythons (PEP 668).
    info('Installing/upgrading huggingface_hub[cli] via pip3…');
    try {
      await streamExec('pip3', ['install', '-U', 'huggingface_hub[cli]']);
    } catch (err) {
      fail(
        `pip3 install failed: ${err.message}`,
        'Your system Python is likely externally managed (PEP 668). Install brew (https://brew.sh), uv, or pipx and re-run: aim backend install huggingface'
      );
    }
  } else {
    fail(
      'No suitable installer found (brew, uv, pipx, or pip3)',
      'Install Homebrew (https://brew.sh) then re-run: aim backend install huggingface'
    );
  }

  const version = await getHfVersion();
  if (version) {
    console.log();
    success(`${version.cli} ${chalk.bold(version.version)} installed`);
  } else {
    console.log();
    warn('Installed, but the hf CLI was not found on PATH — you may need to restart your shell');
  }
}
