import { existsSync } from 'fs';
import os from 'os';
import chalk from 'chalk';
import {
  LLAMA_SERVER_BIN, MLX_PYTHON, VLLM_PYTHON, AI_HOME,
} from '../paths.js';
import { quietExec, isAppleSilicon, getHfVersion } from '../utils.js';

export function registerStatus(program) {
  program
    .command('status')
    .description('Show system info and component versions')
    .action(async () => {
      console.log();
      console.log(chalk.bold('  aim status'));
      console.log(chalk.dim('  ─────────────────────────────'));
      console.log();

      // System
      console.log(chalk.bold('  System'));
      console.log(`    OS:             ${os.type()} ${os.release()} (${os.arch()})`);
      console.log(`    Apple Silicon:  ${isAppleSilicon() ? chalk.green('Yes') : chalk.yellow('No')}`);
      console.log(`    Node.js:        ${process.version}`);
      console.log(`    aim home:       ${chalk.dim(AI_HOME)}`);
      console.log();

      // Python
      const pyVersion = await quietExec('python3', ['--version']);
      const pyPath = await quietExec('which', ['python3']);
      console.log(chalk.bold('  Python'));
      console.log(`    Version:        ${pyVersion || chalk.red('not found')}`);
      console.log(`    Path:           ${chalk.dim(pyPath || 'N/A')}`);
      console.log();

      // llama.cpp
      console.log(chalk.bold('  llama.cpp'));
      if (existsSync(LLAMA_SERVER_BIN)) {
        // llama-server prints its version to stderr, e.g. "version: 1 (a731805)".
        const raw = await quietExec(LLAMA_SERVER_BIN, ['--version'], { mergeStderr: true });
        const v = raw ? raw.split('\n')[0].replace(/^version:\s*/, '') : null;
        console.log(`    Status:         ${chalk.green('✓ installed')}`);
        console.log(`    Version:        ${v || 'unknown'}`);
        console.log(`    Binary:         ${chalk.dim(LLAMA_SERVER_BIN)}`);
      } else {
        console.log(`    Status:         ${chalk.red('✗ not installed')}`);
        console.log(chalk.dim('    → aim backend install llama.cpp'));
      }
      console.log();

      // MLX
      console.log(chalk.bold('  MLX'));
      if (existsSync(MLX_PYTHON)) {
        const v = await quietExec(MLX_PYTHON, [
          '-c', 'import mlx_lm; print(mlx_lm.__version__)',
        ]);
        console.log(`    Status:         ${chalk.green('✓ installed')}`);
        console.log(`    mlx-lm:         ${v || 'unknown'}`);
      } else {
        console.log(`    Status:         ${chalk.red('✗ not installed')}`);
        console.log(chalk.dim('    → aim backend install mlx'));
      }
      console.log();

      // vLLM
      console.log(chalk.bold('  vLLM'));
      if (existsSync(VLLM_PYTHON)) {
        const v = await quietExec(VLLM_PYTHON, [
          '-c', 'import vllm; print(vllm.__version__)',
        ]);
        console.log(`    Status:         ${chalk.green('✓ installed')}`);
        console.log(`    vllm:           ${v || 'unknown'}`);
      } else {
        console.log(`    Status:         ${chalk.red('✗ not installed')}`);
        console.log(chalk.dim('    → aim backend install vllm'));
      }
      console.log();

      // HuggingFace
      console.log(chalk.bold('  HuggingFace'));
      const hfInfo = await getHfVersion();
      if (hfInfo) {
        console.log(`    Status:         ${chalk.green('✓ installed')}`);
        console.log(`    CLI:            ${hfInfo.cli}`);
        console.log(`    Version:        ${hfInfo.version}`);
      } else {
        console.log(`    Status:         ${chalk.red('✗ not installed')}`);
        console.log(chalk.dim('    → brew install hf (recommended) or aim backend install huggingface'));
      }
      console.log();
    });
}
