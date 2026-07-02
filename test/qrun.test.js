import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { execaCommand } from 'execa';
import { detectBackend } from '../src/commands/run.js';

const TEST_ROOT = join(process.cwd(), '.test-tmp', 'qrun');
const BIN = join(process.cwd(), 'bin', 'aim.js');

function cleanup() {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
}

beforeEach(() => {
  cleanup();
  mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
  cleanup();
});

// Helper: create a fake HOME with ai structure
function setupHome(modelsDir) {
  const home = join(TEST_ROOT, 'home');
  mkdirSync(home, { recursive: true });
  if (modelsDir !== false) {
    mkdirSync(join(home, 'ai', 'models'), { recursive: true });
  }
  return home;
}

function writeAimModelsIni(home, content) {
  const path = join(home, 'ai', 'models', 'aim-models.ini');
  writeFileSync(path, content);
  return path;
}

function makeModel(home, rel, files) {
  const dir = join(home, 'ai', 'models', ...rel.split('/'));
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), '');
  return dir;
}

async function aim(home, ...args) {
  const { stdout, stderr, exitCode } = await execaCommand(
    `node ${BIN} ${args.join(' ')}`,
    { stdio: 'pipe', reject: false, timeout: 10_000, env: { HOME: home, PATH: process.env.PATH } }
  );
  return { stdout, stderr, exitCode };
}

// ─── run reads the registry ───────────────────────────────

describe('run – registry resolution', () => {
  it('matches a registry model by full path and checks the backend', async () => {
    const home = setupHome();
    makeModel(home, 'unsloth/gemma-GGUF', ['model.gguf']);
    writeAimModelsIni(home, `[unsloth/gemma-GGUF]\nbackend = llama.cpp\nmodel = "unsloth/gemma-GGUF/model.gguf"\n`);

    const { stderr, exitCode } = await aim(home, 'run', 'unsloth/gemma-GGUF');
    expect(exitCode).not.toBe(0);
    // llama-server isn't installed in the test env, so the launch is blocked there.
    expect(stderr).toContain('llama-server not found');
  });

  it('matches a registry model by trailing name (ends-with)', async () => {
    const home = setupHome();
    makeModel(home, 'org/phi-3-mini-gguf', ['model.gguf']);
    writeAimModelsIni(home, `[org/phi-3-mini-gguf]\nbackend = llama.cpp\nmodel = "org/phi-3-mini-gguf/model.gguf"\n`);

    const { stderr, exitCode } = await aim(home, 'run', 'phi-3-mini-gguf');
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('llama-server not found');
  });

  it('selects mlx backend from the registry backend= field', async () => {
    const home = setupHome();
    makeModel(home, 'mlx-model', ['config.json', 'model.safetensors']);
    writeAimModelsIni(home, `[mlx-model]\nbackend = mlx\ntemp = 0.8\n`);

    const { stderr, exitCode } = await aim(home, 'run', 'mlx-model');
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('MLX backend not installed');
  });

  it('fails when the model directory does not exist', async () => {
    const home = setupHome();
    writeAimModelsIni(home, `[ghost/model]\nmodel = "ghost/model/f16.gguf"\n`);

    const { stderr, exitCode } = await aim(home, 'run', 'ghost/model');
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Model not found');
  });

  it('treats an unknown model as a direct repo path (registry optional)', async () => {
    const home = setupHome();
    // No registry at all.
    const { stderr, exitCode } = await aim(home, 'run', 'some/repo');
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Model not found');
  });

  it('fails when no model is given and the registry is empty', async () => {
    const home = setupHome();
    writeAimModelsIni(home, `# empty config\n`);

    const { stderr, exitCode } = await aim(home, 'run');
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('registry is empty');
  });
});

// ─── registry parsing through the CLI ─────────────────────

describe('run – aim-models.ini parsing', () => {
  it('parses sections, quoted values, comments and blank lines', async () => {
    const home = setupHome();
    makeModel(home, 'org/model-gguf', ['f16.gguf']);
    writeAimModelsIni(
      home,
      `# comment\n; another\n\n[org/model-gguf]\nbackend = llama.cpp\nmodel = "org/model-gguf/f16.gguf"\ntemp = 0.7\n`,
    );

    const { stderr, exitCode } = await aim(home, 'run', 'org/model-gguf');
    expect(exitCode).not.toBe(0);
    // Reached the backend launch (so the section + model path parsed correctly).
    expect(stderr).toContain('llama-server not found');
  });
});

// ─── qrun deprecated alias ────────────────────────────────

describe('qrun – deprecated alias', () => {
  it('is hidden from the top-level help', async () => {
    const { stdout } = await aim(setupHome(), '--help');
    expect(stdout).not.toContain('qrun');
  });

  it('prints a deprecation warning and delegates to run', async () => {
    const home = setupHome();
    makeModel(home, 'mlx-model', ['config.json', 'model.safetensors']);
    writeAimModelsIni(home, `[mlx-model]\nbackend = mlx\n`);

    const { stderr, exitCode } = await aim(home, 'qrun', 'mlx-model');
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('deprecated');
    expect(stderr).toContain('MLX backend not installed');
  });
});

// ─── detectBackend (shared) ───────────────────────────────

describe('run – detectBackend', () => {
  it('detects llama.cpp when .gguf files are present', () => {
    const dir = join(TEST_ROOT, 'gguf');
    mkdirSync(dir);
    writeFileSync(join(dir, 'model.gguf'), '');
    expect(detectBackend(dir)).toBe('llama.cpp');
  });

  it('detects mlx when no .gguf files exist', () => {
    const dir = join(TEST_ROOT, 'mlx');
    mkdirSync(dir);
    writeFileSync(join(dir, 'config.json'), '{}');
    writeFileSync(join(dir, 'model.safetensors'), '');
    expect(detectBackend(dir)).toBe('mlx');
  });
});
