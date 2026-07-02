import chalk from 'chalk';
import { MODELS_DIR } from '../paths.js';
import { ensureDir, fail, info, warn, streamExec, resolveHfCli, isUserAbort, passthroughArgs } from '../utils.js';
import { updateConfigIni } from './serve.js';
import { getSetting } from '../config.js';
import { join } from 'path';

export function registerDownload(program) {
  program
    .command('download')
    .argument('<repo>', 'HuggingFace repository (e.g. unsloth/gemma-4-26B-A4B-it-GGUF)')
    .option('--include <patterns...>', 'Include file patterns (passed to hf download)')
    .option('--exclude <patterns...>', 'Exclude file patterns (passed to hf download)')
    .option('--local-dir <dir>', 'Override download destination')
    .option('-d, --debug', 'Print each subprocess command before it runs')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .description('Download a model from HuggingFace')
    .action(async (repo, options, command) => {
      try {
        await downloadModel(repo, options, command);
      } catch (err) {
        if (isUserAbort(err)) process.exit(0);
        fail(
          `Download failed: ${err.message}`,
          'Make sure the HuggingFace CLI is installed — run `brew install hf` or `aim backend install huggingface`'
        );
      }
    });
}

async function downloadModel(repo, options, command) {
  const hfCli = await resolveHfCli();
  if (!hfCli) {
    fail(
      'HuggingFace CLI not found',
      'Install it with: brew install hf (recommended) or aim backend install huggingface'
    );
  }

  const localDir = options.localDir || join(MODELS_DIR, repo);
  ensureDir(localDir);

  info(`Downloading ${chalk.bold(repo)} → ${chalk.dim(localDir)}`);

  // Fall back to the configured preferred quant when no --include is given.
  let includes = options.include;
  if (!includes) {
    const preferred = getSetting('preferredQuant');
    if (preferred) {
      includes = [preferred];
      warn(`Using preferred quant from config: ${preferred} (override with --include)`);
    }
  }

  // Build args
  const args = ['download', repo, '--local-dir', localDir];

  if (includes) {
    for (const pattern of includes) {
      args.push('--include', pattern);
    }
  }

  if (options.exclude) {
    for (const pattern of options.exclude) {
      args.push('--exclude', pattern);
    }
  }

  // Forward any unknown flags straight to the hf CLI.
  args.push(...passthroughArgs(command, [repo]));

  await streamExec(hfCli, args);

  // Automatically regenerate the config.ini preset for llama-server
  try {
    updateConfigIni();
  } catch (err) {
    // Ignore errors updating config.ini
  }

  console.log();
  console.log(chalk.green('✔ ') + `Downloaded ${chalk.bold(repo)}`);
}
