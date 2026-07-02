import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { findRepos, inferBackend, getFiles } from '../src/commands/list.js';

const TEST_ROOT = join(process.cwd(), '.test-tmp', 'list');

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

// ─── inferBackend ───────────────────────────────────────────

describe('inferBackend', () => {
  it('returns llama.cpp when directory has .gguf files', () => {
    const dir = join(TEST_ROOT, 'gguf-repo');
    mkdirSync(dir);
    writeFileSync(join(dir, 'model.gguf'), '');
    expect(inferBackend(dir)).toBe('llama.cpp');
  });

  it('returns mlx when directory has config.json + safetensors', () => {
    const dir = join(TEST_ROOT, 'mlx-repo');
    mkdirSync(dir);
    writeFileSync(join(dir, 'config.json'), '{}');
    writeFileSync(join(dir, 'model.safetensors'), '');
    expect(inferBackend(dir)).toBe('mlx');
  });

  it('returns mlx when directory has config.json + npz', () => {
    const dir = join(TEST_ROOT, 'npz-repo');
    mkdirSync(dir);
    writeFileSync(join(dir, 'config.json'), '{}');
    writeFileSync(join(dir, 'weights.npz'), '');
    expect(inferBackend(dir)).toBe('mlx');
  });

  it('returns unknown when files are ambiguous', () => {
    const dir = join(TEST_ROOT, 'ambiguous');
    mkdirSync(dir);
    writeFileSync(join(dir, 'README.md'), '');
    expect(inferBackend(dir)).toBe('unknown');
  });

  it('returns unknown for config.json without model weights', () => {
    const dir = join(TEST_ROOT, 'config-only');
    mkdirSync(dir);
    writeFileSync(join(dir, 'config.json'), '{}');
    expect(inferBackend(dir)).toBe('unknown');
  });

  it('returns llama.cpp even if config.json is also present with gguf', () => {
    const dir = join(TEST_ROOT, 'mixed');
    mkdirSync(dir);
    writeFileSync(join(dir, 'config.json'), '{}');
    writeFileSync(join(dir, 'model.gguf'), '');
    writeFileSync(join(dir, 'model.safetensors'), '');
    expect(inferBackend(dir)).toBe('llama.cpp');
  });
});

// ─── getFiles ───────────────────────────────────────────────

describe('getFiles', () => {
  it('returns files sorted by size descending', () => {
    const dir = join(TEST_ROOT, 'files');
    mkdirSync(dir);
    writeFileSync(join(dir, 'small.txt'), 'hi');          // 2 bytes
    writeFileSync(join(dir, 'big.bin'), 'x'.repeat(100)); // 100 bytes
    writeFileSync(join(dir, 'mid.dat'), 'y'.repeat(50));  // 50 bytes

    const files = getFiles(dir);
    expect(files).toHaveLength(3);
    expect(files[0].name).toBe('big.bin');
    expect(files[0].size).toBe(100);
    expect(files[1].name).toBe('mid.dat');
    expect(files[1].size).toBe(50);
    expect(files[2].name).toBe('small.txt');
    expect(files[2].size).toBe(2);
  });

  it('ignores subdirectories', () => {
    const dir = join(TEST_ROOT, 'with-subdir');
    mkdirSync(dir);
    mkdirSync(join(dir, 'subdir'));
    writeFileSync(join(dir, 'file.txt'), 'hello');
    writeFileSync(join(dir, 'subdir', 'nested.txt'), 'nested');

    const files = getFiles(dir);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('file.txt');
  });

  it('returns empty array for empty directory', () => {
    const dir = join(TEST_ROOT, 'empty-dir');
    mkdirSync(dir);
    expect(getFiles(dir)).toEqual([]);
  });
});

// ─── findRepos ──────────────────────────────────────────────

describe('findRepos', () => {
  it('finds a flat model repo with gguf files', () => {
    // models/my-model/model.gguf  (non-org layout)
    const modelDir = join(TEST_ROOT, 'my-model');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'model.gguf'), '');

    const repos = findRepos(TEST_ROOT);
    expect(repos).toHaveLength(1);
    expect(repos[0]).toBe(modelDir);
  });

  it('finds org-scoped repos (org/model)', () => {
    // models/unsloth/gemma-GGUF/model.gguf
    const orgDir = join(TEST_ROOT, 'unsloth');
    const repoDir = join(orgDir, 'gemma-GGUF');
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, 'model.gguf'), '');

    const repos = findRepos(TEST_ROOT);
    expect(repos).toHaveLength(1);
    expect(repos[0]).toBe(repoDir);
  });

  it('finds multiple repos across orgs', () => {
    // org1/model-a
    const repo1 = join(TEST_ROOT, 'org1', 'model-a');
    mkdirSync(repo1, { recursive: true });
    writeFileSync(join(repo1, 'model.gguf'), '');

    // org2/model-b
    const repo2 = join(TEST_ROOT, 'org2', 'model-b');
    mkdirSync(repo2, { recursive: true });
    writeFileSync(join(repo2, 'config.json'), '{}');
    writeFileSync(join(repo2, 'model.safetensors'), '');

    const repos = findRepos(TEST_ROOT);
    expect(repos).toHaveLength(2);
    expect(repos).toContain(repo1);
    expect(repos).toContain(repo2);
  });

  it('skips hidden directories', () => {
    const hidden = join(TEST_ROOT, '.cache');
    mkdirSync(hidden);
    writeFileSync(join(hidden, 'model.gguf'), '');

    const repos = findRepos(TEST_ROOT);
    expect(repos).toHaveLength(0);
  });

  it('returns empty for empty base directory', () => {
    expect(findRepos(TEST_ROOT)).toEqual([]);
  });

  it('handles safetensors model repos', () => {
    const modelDir = join(TEST_ROOT, 'mlx-model');
    mkdirSync(modelDir);
    writeFileSync(join(modelDir, 'model.safetensors'), '');

    const repos = findRepos(TEST_ROOT);
    expect(repos).toHaveLength(1);
    expect(repos[0]).toBe(modelDir);
  });
});

// ─── quantTag ────────────────────────────────────────────────

import { quantTag, buildModelList } from '../src/commands/list.js';

describe('quantTag', () => {
  it('extracts the quant token from a UD-quant filename', () => {
    expect(quantTag('Qwen3.6-27B-UD-Q8_K_XL.gguf')).toBe('Q8_K_XL');
    expect(quantTag('gemma-4-31B-it-qat-UD-Q4_K_XL.gguf')).toBe('Q4_K_XL');
  });

  it('recognizes float formats', () => {
    expect(quantTag('Phi-4-reasoning-plus-BF16.gguf')).toBe('BF16');
  });

  it('does not mistake digits in the model name for a quant', () => {
    // "Qwen3.6" must not match before the real Q8 token.
    expect(quantTag('Qwen3.6-27B-UD-Q6_K_XL.gguf')).toBe('Q6_K_XL');
  });

  it('falls back to the stem when no known quant token is present', () => {
    expect(quantTag('weird-model.gguf')).toBe('weird-model');
  });
});

// ─── buildModelList ──────────────────────────────────────────

describe('buildModelList', () => {
  it('summarizes quants largest-first, flags vision, and totals size', () => {
    const repo = join(TEST_ROOT, 'org', 'multi-GGUF');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'multi-Q8_K_XL.gguf'), 'x'.repeat(300));
    writeFileSync(join(repo, 'multi-Q4_K_XL.gguf'), 'x'.repeat(100));
    writeFileSync(join(repo, 'mmproj-BF16.gguf'), 'x'.repeat(10));

    const [m] = buildModelList(TEST_ROOT);
    expect(m.name).toBe('org/multi-GGUF');
    expect(m.backend).toBe('llama.cpp');
    expect(m.vision).toBe(true);
    expect(m.sizeBytes).toBe(410);
    expect(m.quants.map(q => q.label)).toEqual(['Q8_K_XL', 'Q4_K_XL']);
    // No registry → default is the largest quant.
    expect(m.default).toBe('Q8_K_XL');
  });

  it('reports MLX bit-width from the repo name and has no quants', () => {
    const repo = join(TEST_ROOT, 'org', 'Model-MLX-8bit');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'config.json'), '{}');
    writeFileSync(join(repo, 'model.safetensors'), 'x'.repeat(50));

    const [m] = buildModelList(TEST_ROOT);
    expect(m.backend).toBe('mlx');
    expect(m.quants).toEqual([]);
    expect(m.bits).toBe('8bit');
  });
});

// ─── familyOf ────────────────────────────────────────────────

import { familyOf } from '../src/commands/list.js';

describe('familyOf', () => {
  it('keeps a version embedded in the first token', () => {
    expect(familyOf('unsloth/Qwen3.6-27B-MTP-GGUF')).toBe('Qwen3.6');
    expect(familyOf('unsloth/Qwen3.6-27B-MLX-8bit')).toBe('Qwen3.6');
  });

  it('joins a name with its numeric version token', () => {
    expect(familyOf('unsloth/gemma-4-31B-it-GGUF')).toBe('gemma-4');
    expect(familyOf('unsloth/gemma-4-12B-it-qat-GGUF')).toBe('gemma-4');
    expect(familyOf('unsloth/Phi-4-plus-reasoning-GGUF')).toBe('Phi-4');
  });

  it('falls back to the first token when no version is adjacent', () => {
    expect(familyOf('CohereLabs/BLS-Mini-Code-1.0')).toBe('BLS');
  });

  it('works without an org prefix', () => {
    expect(familyOf('gemma-4-12b-it-GGUF')).toBe('gemma-4');
  });
});
