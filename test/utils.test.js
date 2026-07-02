import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ensureDir, dirSize, matchGlob, nproc, isAppleSilicon,
} from '../src/utils.js';

// Use a temp dir inside the workspace to avoid polluting the system
const TEST_ROOT = join(process.cwd(), '.test-tmp', 'utils');

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

// ─── ensureDir ──────────────────────────────────────────────

describe('ensureDir', () => {
  it('creates a directory that does not exist', () => {
    const dir = join(TEST_ROOT, 'new', 'nested', 'dir');
    expect(existsSync(dir)).toBe(false);
    ensureDir(dir);
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it('does nothing if the directory already exists', () => {
    const dir = join(TEST_ROOT, 'existing');
    mkdirSync(dir, { recursive: true });
    // Should not throw
    ensureDir(dir);
    expect(existsSync(dir)).toBe(true);
  });
});

// ─── dirSize ────────────────────────────────────────────────

describe('dirSize', () => {
  it('returns 0 for a non-existent directory', () => {
    expect(dirSize(join(TEST_ROOT, 'nope'))).toBe(0);
  });

  it('returns 0 for an empty directory', () => {
    const dir = join(TEST_ROOT, 'empty');
    mkdirSync(dir);
    expect(dirSize(dir)).toBe(0);
  });

  it('computes the size of files in a flat directory', () => {
    const dir = join(TEST_ROOT, 'flat');
    mkdirSync(dir);
    writeFileSync(join(dir, 'a.txt'), 'hello'); // 5 bytes
    writeFileSync(join(dir, 'b.txt'), 'world!'); // 6 bytes
    expect(dirSize(dir)).toBe(11);
  });

  it('computes size recursively through nested directories', () => {
    const dir = join(TEST_ROOT, 'nested');
    const sub = join(dir, 'sub');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(dir, 'top.txt'), '12345'); // 5 bytes
    writeFileSync(join(sub, 'deep.txt'), '1234567890'); // 10 bytes
    expect(dirSize(dir)).toBe(15);
  });
});

// ─── matchGlob ──────────────────────────────────────────────

describe('matchGlob', () => {
  const files = [
    'gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf',
    'mmproj-BF16.gguf',
    'config.json',
    'README.md',
    'model.safetensors',
  ];

  it('matches a wildcard prefix and suffix pattern', () => {
    const result = matchGlob('*Q4_K_XL*', files);
    expect(result).toEqual(['gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf']);
  });

  it('matches an mmproj pattern', () => {
    const result = matchGlob('*mmproj-BF16*', files);
    expect(result).toEqual(['mmproj-BF16.gguf']);
  });

  it('matches a full filename exactly', () => {
    const result = matchGlob('config.json', files);
    expect(result).toEqual(['config.json']);
  });

  it('matches case-insensitively', () => {
    const result = matchGlob('*MMPROJ*', files);
    expect(result).toEqual(['mmproj-BF16.gguf']);
  });

  it('returns empty array for no match', () => {
    const result = matchGlob('*nonexistent*', files);
    expect(result).toEqual([]);
  });

  it('handles *.gguf pattern', () => {
    const result = matchGlob('*.gguf', files);
    expect(result).toEqual([
      'gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf',
      'mmproj-BF16.gguf',
    ]);
  });

  it('handles ? single-character wildcard', () => {
    const result = matchGlob('README.m?', files);
    expect(result).toEqual(['README.md']);
  });
});

// ─── nproc ──────────────────────────────────────────────────

describe('nproc', () => {
  it('returns a positive integer', () => {
    const n = nproc();
    expect(n).toBeGreaterThan(0);
    expect(Number.isInteger(n)).toBe(true);
  });
});

// ─── isAppleSilicon ─────────────────────────────────────────

describe('isAppleSilicon', () => {
  it('returns a boolean', () => {
    expect(typeof isAppleSilicon()).toBe('boolean');
  });

  it('matches expected value for this platform', () => {
    const expected = process.platform === 'darwin' && process.arch === 'arm64';
    expect(isAppleSilicon()).toBe(expected);
  });
});
