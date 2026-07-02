import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';

const TEST_ROOT = join(process.cwd(), '.test-tmp', 'serve');

function setupHome() {
  const home = join(TEST_ROOT, 'home');
  mkdirSync(join(home, 'ai', 'models', 'org', 'llama-gguf'), { recursive: true });
  writeFileSync(join(home, 'ai', 'models', 'org', 'llama-gguf', 'model.gguf'), '');
  return home;
}

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('updateConfigIni – registry → preset projection', () => {
  it('projects per-model run params from the registry into config.ini', async () => {
    const home = setupHome();
    process.env.HOME = home;

    // Import after HOME is set so paths.js resolves into the temp home.
    const { updateConfigIni } = await import('../src/commands/serve.js');

    const regPath = join(home, 'ai', 'models', 'aim-models.ini');
    const cfgPath = join(home, 'ai', 'models', 'config.ini');

    // First pass builds the registry + preset.
    updateConfigIni();

    // User tunes the source of truth (aim-models.ini).
    let reg = readFileSync(regPath, 'utf-8');
    reg = reg.replace('[org/llama-gguf]\n', '[org/llama-gguf]\nctx-size = 8192\ntemp = 0.3\nthinking = true\n');
    writeFileSync(regPath, reg);

    // Regenerate (what `aim serve` does on launch).
    updateConfigIni();

    const cfg = readFileSync(cfgPath, 'utf-8');
    // Paths are written unquoted: llama-server's preset parser reads values
    // verbatim and does not strip surrounding quotes.
    expect(cfg).toContain('model = org/llama-gguf/model.gguf');
    expect(cfg).toContain('ctx-size = 8192');
    expect(cfg).toContain('temp = 0.3');
    // `thinking` expands to llama-server's jinja + chat-template-kwargs.
    expect(cfg).toContain('jinja = true');
    expect(cfg).toContain('chat-template-kwargs = {"enable_thinking":true}');
  });

  it('marks the preload target with load-on-startup and matches by short name', async () => {
    const home = setupHome();
    process.env.HOME = home;
    const { updateConfigIni } = await import('../src/commands/serve.js');
    const cfgPath = join(home, 'ai', 'models', 'config.ini');

    // Match by the trailing model name (not the full org/repo path).
    const { preloadName } = updateConfigIni({ preload: 'llama-gguf' });
    expect(preloadName).toBe('org/llama-gguf');

    const cfg = readFileSync(cfgPath, 'utf-8');
    expect(cfg).toContain('[org/llama-gguf]');
    expect(cfg).toContain('load-on-startup = true');
  });

  it('does not add load-on-startup when no preload is requested', async () => {
    const home = setupHome();
    process.env.HOME = home;
    const { updateConfigIni } = await import('../src/commands/serve.js');
    const cfgPath = join(home, 'ai', 'models', 'config.ini');

    const { preloadName } = updateConfigIni();
    expect(preloadName).toBeNull();
    expect(readFileSync(cfgPath, 'utf-8')).not.toContain('load-on-startup');
  });

  it('throws when the preload name matches no servable model', async () => {
    const home = setupHome();
    process.env.HOME = home;
    const { updateConfigIni } = await import('../src/commands/serve.js');

    expect(() => updateConfigIni({ preload: 'does-not-exist' }))
      .toThrow(/Model not found to preload/);
  });
});

// ─── quantLabel ──────────────────────────────────────────────
// Imported dynamically (like updateConfigIni) so loading serve.js doesn't
// resolve paths.js against the real HOME and poison the module cache.

describe('quantLabel', () => {
  const names = [
    'Qwen3.6-27B-UD-Q8_K_XL.gguf',
    'Qwen3.6-27B-UD-Q6_K_XL.gguf',
    'Qwen3.6-27B-UD-Q4_K_XL.gguf',
  ];

  it('strips the shared prefix back to a separator boundary', async () => {
    const { quantLabel } = await import('../src/commands/serve.js');
    expect(quantLabel(names[0], names)).toBe('Q8_K_XL');
    expect(quantLabel(names[1], names)).toBe('Q6_K_XL');
    expect(quantLabel(names[2], names)).toBe('Q4_K_XL');
  });

  it('handles labels of differing length (BF16 vs Q4_K_M)', async () => {
    const { quantLabel } = await import('../src/commands/serve.js');
    const mixed = ['model-BF16.gguf', 'model-Q4_K_M.gguf'];
    expect(quantLabel(mixed[0], mixed)).toBe('BF16');
    expect(quantLabel(mixed[1], mixed)).toBe('Q4_K_M');
  });

  it('falls back to the stem when no shared prefix exists', async () => {
    const { quantLabel } = await import('../src/commands/serve.js');
    const distinct = ['alpha.gguf', 'beta.gguf'];
    expect(quantLabel(distinct[0], distinct)).toBe('alpha');
  });
});

// ─── per-quant expansion ─────────────────────────────────────

describe('updateConfigIni – per-quant expansion', () => {
  function setupMultiQuant() {
    const home = join(TEST_ROOT, 'home');
    const dir = join(home, 'ai', 'models', 'org', 'multi-gguf');
    mkdirSync(dir, { recursive: true });
    // Distinct sizes so largest-first ordering is deterministic.
    writeFileSync(join(dir, 'multi-Q8_K_XL.gguf'), 'x'.repeat(300));
    writeFileSync(join(dir, 'multi-Q6_K_XL.gguf'), 'x'.repeat(200));
    writeFileSync(join(dir, 'multi-Q4_K_XL.gguf'), 'x'.repeat(100));
    return home;
  }

  it('emits one router entry per quant when a repo has several GGUFs', async () => {
    const home = setupMultiQuant();
    process.env.HOME = home;
    const { updateConfigIni } = await import('../src/commands/serve.js');
    const cfgPath = join(home, 'ai', 'models', 'config.ini');

    updateConfigIni();
    const cfg = readFileSync(cfgPath, 'utf-8');

    expect(cfg).toContain('[org/multi-gguf/Q8_K_XL]');
    expect(cfg).toContain('[org/multi-gguf/Q6_K_XL]');
    expect(cfg).toContain('[org/multi-gguf/Q4_K_XL]');
    expect(cfg).toContain('model = org/multi-gguf/multi-Q8_K_XL.gguf');
    expect(cfg).toContain('model = org/multi-gguf/multi-Q4_K_XL.gguf');
  });

  it('preloads a specific quant by its expanded id', async () => {
    const home = setupMultiQuant();
    process.env.HOME = home;
    const { updateConfigIni } = await import('../src/commands/serve.js');
    const cfgPath = join(home, 'ai', 'models', 'config.ini');

    // First pass to create the registry, then preload one quant.
    updateConfigIni();
    const { preloadName } = updateConfigIni({ preload: 'org/multi-gguf/Q4_K_XL' });
    expect(preloadName).toBe('org/multi-gguf/Q4_K_XL');

    const cfg = readFileSync(cfgPath, 'utf-8');
    const block = cfg.split('[org/multi-gguf/Q4_K_XL]')[1].split('[')[0];
    expect(block).toContain('load-on-startup = true');
  });

  it('preloads the default quant when given just the repo name', async () => {
    const home = setupMultiQuant();
    process.env.HOME = home;
    const { updateConfigIni } = await import('../src/commands/serve.js');

    updateConfigIni();
    const { preloadName } = updateConfigIni({ preload: 'multi-gguf' });
    // Registry default is the largest quant (picked by config-gen).
    expect(preloadName).toBe('org/multi-gguf/Q8_K_XL');
  });
});
