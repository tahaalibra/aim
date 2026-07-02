import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execaCommand } from 'execa';

const TEST_ROOT = join(process.cwd(), '.test-tmp', 'agent');
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
  writeFileSync(
    join(home, 'ai', 'models', 'aim-models.ini'),
    `[org/gemma-GGUF]\nbackend = llama.cpp\nalias = gemma\n\n[mlx-model]\nbackend = mlx\n`,
  );
  return home;
}

async function aim(home, ...args) {
  return execaCommand(
    `node ${BIN} ${args.join(' ')}`,
    { stdio: 'pipe', reject: false, timeout: 10_000, env: { HOME: home, PATH: process.env.PATH } },
  );
}

describe('agent – CLI', () => {
  it('rejects an unknown target', async () => {
    const { stderr, exitCode } = await aim(setupHome(), 'agent', 'bogus');
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Unknown agent target');
  });

  it('dry-runs without writing any file', async () => {
    const home = setupHome();
    const { stdout, exitCode } = await aim(home, 'agent', 'pi', '--port', '9000');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Dry run');
    expect(stdout).toContain('http://localhost:9000/v1');
    expect(existsSync(join(home, '.pi', 'agent', 'models.json'))).toBe(false);
  });

  it('writes pi models.json under the AIM provider', async () => {
    const home = setupHome();
    const { exitCode } = await aim(home, 'agent', 'pi', '--update', '--port', '8080');
    expect(exitCode).toBe(0);

    const path = join(home, '.pi', 'agent', 'models.json');
    expect(existsSync(path)).toBe(true);
    const json = JSON.parse(readFileSync(path, 'utf-8'));
    const aim_ = json.providers.AIM;
    expect(aim_.baseUrl).toBe('http://localhost:8080/v1');
    expect(aim_.api).toBe('openai-completions');
    const ids = aim_.models.map(m => m.id);
    expect(ids).toContain('gemma');                          // llama.cpp: from alias
    expect(ids.some(id => id.endsWith('/ai/models/mlx-model'))).toBe(true); // mlx: served path
    expect(json.models).toBeUndefined();                     // no bogus top-level array
  });

  it('preserves other providers and cleans up legacy top-level models', async () => {
    const home = setupHome();
    const path = join(home, '.pi', 'agent', 'models.json');
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(path, JSON.stringify({
      providers: { local: { baseUrl: 'http://localhost:8001/v1', models: [{ id: 'gpt-4' }] } },
      models: [{ id: 'old', managed_by: 'aim' }], // legacy junk from older aim
    }));

    await aim(home, 'agent', 'pi', '--update');
    const json = JSON.parse(readFileSync(path, 'utf-8'));
    expect(json.providers.local).toBeDefined();             // foreign provider preserved
    expect(json.providers.local.models[0].id).toBe('gpt-4');
    expect(json.providers.AIM).toBeDefined();               // our provider added
    expect(json.models).toBeUndefined();                    // legacy array removed
    expect(existsSync(path + '.bak')).toBe(true);           // backup taken
  });

  it('writes Zed settings under language_models.openai, preserving other keys', async () => {
    const home = setupHome();
    const path = join(home, '.config', 'zed', 'settings.json');
    mkdirSync(join(home, '.config', 'zed'), { recursive: true });
    writeFileSync(path, JSON.stringify({ theme: 'One Dark', vim_mode: true }));

    const { exitCode } = await aim(home, 'agent', 'zed', '--update', '--port', '7000');
    expect(exitCode).toBe(0);

    const json = JSON.parse(readFileSync(path, 'utf-8'));
    expect(json.theme).toBe('One Dark');
    expect(json.vim_mode).toBe(true);
    expect(json.language_models.openai.api_url).toBe('http://localhost:7000/v1');
    expect(json.language_models.openai.available_models.map(m => m.name)).toContain('gemma');
  });
});
