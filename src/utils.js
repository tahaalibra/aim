import { existsSync, mkdirSync, statSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { execa } from 'execa';
import chalk from 'chalk';
import os from 'os';

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Print an error message with an actionable hint and exit.
 */
export function fail(message, hint) {
  console.error(chalk.red('✖ ') + message);
  if (hint) {
    console.error(chalk.dim('  → ' + hint));
  }
  process.exit(1);
}

/**
 * Print a warning message.
 */
export function warn(message) {
  console.warn(chalk.yellow('⚠ ') + message);
}

/**
 * Print a success message.
 */
export function success(message) {
  console.log(chalk.green('✔ ') + message);
}

/**
 * Print an info message.
 */
export function info(message) {
  console.log(chalk.blue('ℹ ') + message);
}

/**
 * True if an execa error represents the user aborting (Ctrl+C) rather than a
 * real failure. Used so commands can exit cleanly instead of printing an error.
 */
export function isUserAbort(err) {
  return (
    err.isCanceled ||
    err.signal === 'SIGINT' ||
    err.signal === 'SIGTERM' ||
    err.exitCode === 130 ||
    err.exitCode === 143
  );
}

/**
 * Extract passthrough args (unknown flags forwarded to the backend) from a
 * Commander command. Commander strips declared options into `command.args`,
 * leaving the declared positionals followed by any unknown options/values.
 * We drop the positionals that were actually provided.
 *
 * Requires the command to set `.allowUnknownOption(true)` and
 * `.allowExcessArguments(true)`.
 */
export function passthroughArgs(command, providedPositionals = []) {
  return command.args.slice(providedPositionals.length);
}

/**
 * Strip a single pair of surrounding single/double quotes from a value.
 */
export function stripQuotes(value) {
  return value.replace(/^["']|["']$/g, '');
}

/**
 * Parse a minimal INI string into a Map of section name → { key: value }.
 * Comments (# or ;) and blank lines are ignored; values are unquoted.
 */
export function parseIni(content) {
  const sections = new Map();
  let currentSection = null;
  let currentConfig = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;

    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      if (currentSection !== null) sections.set(currentSection, currentConfig);
      currentSection = sectionMatch[1].trim();
      currentConfig = {};
      continue;
    }

    if (currentSection !== null) {
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex > 0) {
        const key = trimmed.slice(0, eqIndex).trim();
        const value = stripQuotes(trimmed.slice(eqIndex + 1).trim());
        currentConfig[key] = value;
      }
    }
  }

  if (currentSection !== null) sections.set(currentSection, currentConfig);
  return sections;
}

// Global debug flag, toggled by the top-level `aim -d/--debug` option (see
// bin/aim.js). When on, streamExec echoes every subprocess it spawns.
let DEBUG = false;
export function setDebug(value) { DEBUG = !!value; }
export function isDebug() { return DEBUG; }

/**
 * Print a copy-pasteable representation of a command and its args (for --debug).
 */
export function printCommand(command, args = [], cwd) {
  const fmt = args.map(a => (/[\s"']/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a));
  console.log(chalk.dim('  → backend command:'));
  if (cwd) console.log(chalk.dim(`    (cwd: ${cwd})`));
  console.log(chalk.cyan(`    ${command} ${fmt.join(' ')}`));
}

/**
 * Run a command, streaming output to the terminal.
 * Returns the result or throws with a clean message.
 * With `aim --debug`, the exact command (and cwd, if set) is printed first.
 */
export async function streamExec(command, args = [], options = {}) {
  if (DEBUG) printCommand(command, args, options.cwd);
  const proc = execa(
    command,
    args,
    {
      stdio: 'inherit',
      ...options,
    }
  );
  return proc;
}

/**
 * Run a command silently, returning trimmed stdout (or null on failure).
 *
 * Pass `{ mergeStderr: true }` to fall back to stderr when stdout is empty —
 * some tools (e.g. `llama-server --version`) print to stderr.
 */
export async function quietExec(command, args = [], options = {}) {
  const { mergeStderr = false, ...execaOptions } = options;
  try {
    const { stdout, stderr } = await execa(
      command,
      args,
      {
        stdio: 'pipe',
        ...execaOptions,
      }
    );
    return stdout.trim() || (mergeStderr ? stderr.trim() : '') || null;
  } catch {
    return null;
  }
}

/**
 * Check if a command is available in the system PATH.
 */
export async function checkCommand(command) {
  const result = await quietExec('which', [command]);
  return !!result;
}

/**
 * Get total size of a directory recursively (in bytes).
 */
export function dirSize(dirPath) {
  let total = 0;
  if (!existsSync(dirPath)) return 0;

  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isFile()) {
      total += statSync(fullPath).size;
    } else if (entry.isDirectory()) {
      total += dirSize(fullPath);
    }
  }
  return total;
}

/**
 * Get number of CPU cores for parallel builds.
 */
export function nproc() {
  return os.availableParallelism?.() ?? os.cpus().length;
}

/**
 * Check if running on Apple Silicon.
 */
export function isAppleSilicon() {
  const { platform, arch } = process;
  return platform === 'darwin' && arch === 'arm64';
}

/**
 * Resolve a glob pattern against a list of filenames.
 * Supports simple wildcard patterns like "*Q4_K_XL*".
 */
export function matchGlob(pattern, filenames) {
  // Convert glob pattern to regex
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const regex = new RegExp(`^${escaped}$`, 'i');
  return filenames.filter(f => regex.test(f));
}

/**
 * Resolve the HuggingFace CLI binary.
 * Prefers `hf` (new Rust CLI) over `huggingface-cli` (deprecated Python CLI).
 * Returns the command name or null if neither is found.
 */
export async function resolveHfCli() {
  const hf = await quietExec('which', ['hf']);
  if (hf) return 'hf';
  const hfCli = await quietExec('which', ['huggingface-cli']);
  if (hfCli) return 'huggingface-cli';
  return null;
}

/**
 * Get the HuggingFace CLI version string.
 * Returns { cli, version } or null.
 */
export async function getHfVersion() {
  // Try `hf` first
  const hfVersion = await quietExec('hf', ['--version']);
  if (hfVersion) return { cli: 'hf', version: hfVersion };
  // Fallback to huggingface-cli
  const hfCliVersion = await quietExec('huggingface-cli', ['--version']);
  if (hfCliVersion) return { cli: 'huggingface-cli', version: hfCliVersion };
  return null;
}
