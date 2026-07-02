import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execaCommand } from 'execa';

const TEST_ROOT = join(process.cwd(), '.test-tmp', 'config');
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
  mkdirSync(join(home, 'ai'), { recursive: true });
  return home;
}

async function aim(home, ...args) {
  return execaCommand(
    `node ${BIN} ${args.join(' ')}`,
    { stdio: 'pipe', reject: false, timeout: 10_000, env: { HOME: home, PATH: process.env.PATH } },
  );
}

describe('config – CLI', () => {
  it('lists settings when called with no args', async () => {
    const { stdout, exitCode } = await aim(setupHome(), 'config');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('defaultPort');
    expect(stdout).toContain('preferredQuant');
    expect(stdout).toContain('(unset)');
  });

  it('sets and persists a setting', async () => {
    const home = setupHome();
    const { exitCode } = await aim(home, 'config', 'defaultPort', '9090');
    expect(exitCode).toBe(0);

    const cfgPath = join(home, 'ai', 'config.json');
    expect(existsSync(cfgPath)).toBe(true);
    expect(JSON.parse(readFileSync(cfgPath, 'utf-8')).defaultPort).toBe('9090');
  });

  it('gets a previously set value', async () => {
    const home = setupHome();
    await aim(home, 'config', 'preferredQuant', '*Q8_K_XL*');
    const { stdout, exitCode } = await aim(home, 'config', 'preferredQuant');
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('*Q8_K_XL*');
  });

  it('rejects unknown keys', async () => {
    const { stderr, exitCode } = await aim(setupHome(), 'config', 'bogusKey', 'x');
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Unknown setting');
  });
});
