import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execaCommand } from 'execa';

const TEST_ROOT = join(process.cwd(), '.test-tmp', 'config-gen');
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

function setupHome() {
  const home = join(TEST_ROOT, 'home');
  mkdirSync(join(home, 'ai', 'models'), { recursive: true });
  return home;
}

function aim(home, ...args) {
  return execaCommand(
    `node ${BIN} model ${args.join(' ')}`,
    { stdio: 'pipe', reject: false, timeout: 10_000, env: { HOME: home, PATH: process.env.PATH } },
  );
}

describe('config-gen – CLI', () => {
  it('shows usage in --help', async () => {
    const { stdout, exitCode } = await aim(setupHome(), 'config-gen', '--help');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('aim-models.ini');
  });

  it('creates aim-models.ini for GGUF models', async () => {
    const home = setupHome();
    const modelDir = join(home, 'ai', 'models', 'org', 'llama-gguf');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'model.gguf'), '');

    const { exitCode, stdout } = await aim(home, 'config-gen');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('aim-models.ini generated successfully');

    const iniPath = join(home, 'ai', 'models', 'aim-models.ini');
    expect(existsSync(iniPath)).toBe(true);
    const content = readFileSync(iniPath, 'utf-8');
    expect(content).toContain('[org/llama-gguf]');
    expect(content).toContain('model.gguf');
  });

  it('creates aim-models.ini for MLX models', async () => {
    const home = setupHome();
    const modelDir = join(home, 'ai', 'models', 'org', 'mlx-model');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'config.json'), '{}');
    writeFileSync(join(modelDir, 'model.safetensors'), '');

    const { exitCode } = await aim(home, 'config-gen');
    expect(exitCode).toBe(0);

    const iniPath = join(home, 'ai', 'models', 'aim-models.ini');
    expect(existsSync(iniPath)).toBe(true);
    const content = readFileSync(iniPath, 'utf-8');
    expect(content).toContain('[org/mlx-model]');
  });

  it('preserves existing sections when regenerating', async () => {
    const home = setupHome();
    const modelDir = join(home, 'ai', 'models', 'org', 'llama-gguf');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'model.gguf'), '');

    // First generation
    await aim(home, 'config-gen');

    // Manually edit aim-models.ini to add custom config
    const iniPath = join(home, 'ai', 'models', 'aim-models.ini');
    let content = readFileSync(iniPath, 'utf-8');
    content += `temp = 0.3\ntop-p = 0.9\n`;
    writeFileSync(iniPath, content);

    // Second generation (should preserve custom edits)
    const { exitCode } = await aim(home, 'config-gen');
    expect(exitCode).toBe(0);

    content = readFileSync(iniPath, 'utf-8');
    expect(content).toContain('temp = 0.3');
    expect(content).toContain('top-p = 0.9');
  });

  it('adds new models while preserving existing ones', async () => {
    const home = setupHome();

    // First model: GGUF
    const ggufDir = join(home, 'ai', 'models', 'org', 'llama-gguf');
    mkdirSync(ggufDir, { recursive: true });
    writeFileSync(join(ggufDir, 'model.gguf'), '');

    // Generate with GGUF
    await aim(home, 'config-gen');

    // Second model: MLX (added after first generation)
    const mlxDir = join(home, 'ai', 'models', 'org', 'mlx-model');
    mkdirSync(mlxDir, { recursive: true });
    writeFileSync(join(mlxDir, 'config.json'), '{}');
    writeFileSync(join(mlxDir, 'model.safetensors'), '');

    // Regenerate — should add MLX and keep GGUF
    const { exitCode } = await aim(home, 'config-gen');
    expect(exitCode).toBe(0);

    const iniPath = join(home, 'ai', 'models', 'aim-models.ini');
    const content = readFileSync(iniPath, 'utf-8');
    expect(content).toContain('[org/llama-gguf]');
    expect(content).toContain('[org/mlx-model]');
  });

  it('handles empty models directory gracefully', async () => {
    const home = setupHome();
    const { exitCode } = await aim(home, 'config-gen');
    expect(exitCode).toBe(0);

    // File should still be created (empty)
    const iniPath = join(home, 'ai', 'models', 'aim-models.ini');
    expect(existsSync(iniPath)).toBe(true);
  });

  it('reports preserved and added counts', async () => {
    const home = setupHome();

    // First model
    const dir1 = join(home, 'ai', 'models', 'org', 'model-one');
    mkdirSync(dir1, { recursive: true });
    writeFileSync(join(dir1, 'model.gguf'), '');
    await aim(home, 'config-gen');

    // Add second model and regenerate
    const dir2 = join(home, 'ai', 'models', 'org', 'model-two');
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, 'model.gguf'), '');

    const { stdout } = await aim(home, 'config-gen');
    expect(stdout).toContain('preserved');
    expect(stdout).toContain('added');
  });
});
