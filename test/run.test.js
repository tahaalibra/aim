import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { detectBackend, getAllFiles } from '../src/commands/run.js';

const TEST_ROOT = join(process.cwd(), '.test-tmp', 'run');

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

// ─── getAllFiles ─────────────────────────────────────────────

describe('getAllFiles', () => {
  it('lists files in a flat directory', () => {
    const dir = join(TEST_ROOT, 'flat');
    mkdirSync(dir);
    writeFileSync(join(dir, 'a.gguf'), '');
    writeFileSync(join(dir, 'b.txt'), '');

    const files = getAllFiles(dir);
    expect(files).toContain('a.gguf');
    expect(files).toContain('b.txt');
    expect(files).toHaveLength(2);
  });

  it('lists files recursively with relative paths', () => {
    const dir = join(TEST_ROOT, 'nested');
    const sub = join(dir, 'sub');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(dir, 'top.txt'), '');
    writeFileSync(join(sub, 'deep.bin'), '');

    const files = getAllFiles(dir);
    expect(files).toContain('top.txt');
    expect(files).toContain(join('sub', 'deep.bin'));
    expect(files).toHaveLength(2);
  });

  it('returns empty array for an empty directory', () => {
    const dir = join(TEST_ROOT, 'empty');
    mkdirSync(dir);
    expect(getAllFiles(dir)).toEqual([]);
  });
});

// ─── detectBackend ──────────────────────────────────────────

describe('detectBackend', () => {
  it('detects llama.cpp when .gguf files are present', () => {
    const dir = join(TEST_ROOT, 'gguf-model');
    mkdirSync(dir);
    writeFileSync(join(dir, 'model-Q4_K.gguf'), '');
    writeFileSync(join(dir, 'mmproj-BF16.gguf'), '');

    expect(detectBackend(dir)).toBe('llama.cpp');
  });

  it('detects mlx when no .gguf files are present', () => {
    const dir = join(TEST_ROOT, 'mlx-model');
    mkdirSync(dir);
    writeFileSync(join(dir, 'config.json'), '{}');
    writeFileSync(join(dir, 'model.safetensors'), '');

    expect(detectBackend(dir)).toBe('mlx');
  });

  it('prefers llama.cpp when both gguf and safetensors exist', () => {
    const dir = join(TEST_ROOT, 'mixed-model');
    mkdirSync(dir);
    writeFileSync(join(dir, 'model.gguf'), '');
    writeFileSync(join(dir, 'config.json'), '{}');
    writeFileSync(join(dir, 'model.safetensors'), '');

    expect(detectBackend(dir)).toBe('llama.cpp');
  });

  it('defaults to mlx for empty directory', () => {
    const dir = join(TEST_ROOT, 'empty-model');
    mkdirSync(dir);

    expect(detectBackend(dir)).toBe('mlx');
  });

  it('detects gguf files in subdirectories', () => {
    const dir = join(TEST_ROOT, 'sub-gguf');
    const sub = join(dir, 'nested');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'model.gguf'), '');

    expect(detectBackend(dir)).toBe('llama.cpp');
  });
});

// ─── pickQuant ───────────────────────────────────────────────

import { pickQuant } from '../src/commands/run.js';

describe('pickQuant', () => {
  const ggufs = ['Qwen-Q8_K_XL.gguf', 'Qwen-Q6_K_XL.gguf', 'Qwen-Q4_K_XL.gguf'];

  it('returns the first (largest) when no candidates match', () => {
    expect(pickQuant(ggufs, [])).toBe('Qwen-Q8_K_XL.gguf');
    expect(pickQuant(ggufs, [null, undefined])).toBe('Qwen-Q8_K_XL.gguf');
  });

  it('matches a candidate by basename, ignoring directory prefixes', () => {
    expect(pickQuant(ggufs, ['org/repo/Qwen-Q4_K_XL.gguf'])).toBe('Qwen-Q4_K_XL.gguf');
  });

  it('honors candidate precedence (first match wins)', () => {
    expect(pickQuant(ggufs, ['Qwen-Q6_K_XL.gguf', 'Qwen-Q4_K_XL.gguf'])).toBe('Qwen-Q6_K_XL.gguf');
  });

  it('strips quotes from candidate names', () => {
    expect(pickQuant(ggufs, ['"Qwen-Q4_K_XL.gguf"'])).toBe('Qwen-Q4_K_XL.gguf');
  });

  it('falls back to the first when a candidate is absent', () => {
    expect(pickQuant(ggufs, ['Qwen-Q2_K.gguf'])).toBe('Qwen-Q8_K_XL.gguf');
  });
});
