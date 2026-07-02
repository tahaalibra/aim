import { describe, it, expect } from 'vitest';
import { buildBackendArgs, PARAM_SCHEMA, STRUCTURAL_KEYS } from '../src/params.js';

// ─── llama.cpp translation ──────────────────────────────────

describe('buildBackendArgs — llama.cpp', () => {
  it('maps sampling params to llama.cpp flags', () => {
    const { args, warnings } = buildBackendArgs('llama.cpp', {
      temp: '0.7', 'top-p': '0.95', 'top-k': '40',
    });
    expect(args).toEqual(['--temp', '0.7', '--top-p', '0.95', '--top-k', '40']);
    expect(warnings).toEqual([]);
  });

  it('maps ctx-size and min-p (llama.cpp only)', () => {
    const { args, warnings } = buildBackendArgs('llama.cpp', {
      'ctx-size': '8192', 'min-p': '0.05',
    });
    expect(args).toEqual(['--ctx-size', '8192', '--min-p', '0.05']);
    expect(warnings).toEqual([]);
  });

  it('expands thinking=true into jinja flags', () => {
    const { args } = buildBackendArgs('llama.cpp', { thinking: 'true' });
    expect(args).toEqual([
      '--jinja', '--chat-template-kwargs', JSON.stringify({ enable_thinking: true }),
    ]);
  });

  it('omits thinking flags when thinking=false', () => {
    const { args } = buildBackendArgs('llama.cpp', { thinking: 'false' });
    expect(args).toEqual([]);
  });

  it('maps alias to --alias', () => {
    const { args } = buildBackendArgs('llama.cpp', { alias: 'gemma' });
    expect(args).toEqual(['--alias', 'gemma']);
  });
});

// ─── mlx translation ────────────────────────────────────────

describe('buildBackendArgs — mlx', () => {
  it('maps temp/top-p/top-k/min-p to the real mlx_lm.server flags', () => {
    const { args, warnings } = buildBackendArgs('mlx', {
      temp: '0.7', 'top-p': '0.95', 'top-k': '40', 'min-p': '0.05',
    });
    expect(args).toEqual(['--temp', '0.7', '--top-p', '0.95', '--top-k', '40', '--min-p', '0.05']);
    expect(warnings).toEqual([]);
  });

  it('maps max-tokens to --max-tokens on mlx and --n-predict on llama.cpp', () => {
    expect(buildBackendArgs('mlx', { 'max-tokens': '512' }).args).toEqual(['--max-tokens', '512']);
    expect(buildBackendArgs('llama.cpp', { 'max-tokens': '512' }).args).toEqual(['--n-predict', '512']);
  });

  it('expands thinking via --chat-template-args on mlx', () => {
    const { args } = buildBackendArgs('mlx', { thinking: 'true' });
    expect(args).toEqual(['--chat-template-args', JSON.stringify({ enable_thinking: true })]);
  });

  it('warns on params unsupported by mlx instead of emitting bad flags', () => {
    const { args, warnings } = buildBackendArgs('mlx', {
      'ctx-size': '8192', alias: 'gemma', 'presence-penalty': '1.0',
    });
    expect(args).toEqual([]);
    expect(warnings).toHaveLength(3);
    expect(warnings.some(w => w.includes('ctx-size'))).toBe(true);
    expect(warnings.some(w => w.includes('alias'))).toBe(true);
    expect(warnings.some(w => w.includes('presence-penalty'))).toBe(true);
  });

  it('does not warn for thinking=false on mlx (nothing requested)', () => {
    const { args, warnings } = buildBackendArgs('mlx', { thinking: 'false' });
    expect(args).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

// ─── vllm translation ───────────────────────────────────────

describe('buildBackendArgs — vllm', () => {
  it('maps ctx-size to --max-model-len and alias to --served-model-name', () => {
    const { args, warnings } = buildBackendArgs('vllm', {
      'ctx-size': '32768', alias: 'bls', seed: '7',
    });
    expect(args).toEqual([
      '--max-model-len', '32768',
      '--served-model-name', 'bls',
      '--seed', '7',
    ]);
    expect(warnings).toEqual([]);
  });

  it('maps vllm-only runtime knobs to their flags', () => {
    const { args, warnings } = buildBackendArgs('vllm', {
      dtype: 'bfloat16',
      'tensor-parallel': '2',
      'gpu-mem-util': '0.9',
      quantization: 'awq',
      'max-num-seqs': '64',
      'trust-remote-code': 'true',
    });
    expect(args).toEqual([
      '--dtype', 'bfloat16',
      '--tensor-parallel-size', '2',
      '--gpu-memory-utilization', '0.9',
      '--quantization', 'awq',
      '--max-num-seqs', '64',
      '--trust-remote-code',
    ]);
    expect(warnings).toEqual([]);
  });

  it('warns on sampling params (per-request in vllm, not server flags)', () => {
    const { args, warnings } = buildBackendArgs('vllm', {
      temp: '0.7', 'top-p': '0.95', 'max-tokens': '512',
    });
    expect(args).toEqual([]);
    expect(warnings).toHaveLength(3);
    expect(warnings.some(w => w.includes('temp'))).toBe(true);
    expect(warnings.some(w => w.includes('top-p'))).toBe(true);
    expect(warnings.some(w => w.includes('max-tokens'))).toBe(true);
  });

  it('warns on llama.cpp-only knobs when targeting vllm', () => {
    const { args, warnings } = buildBackendArgs('vllm', {
      'flash-attn': 'on', 'n-gpu-layers': '99',
    });
    expect(args).toEqual([]);
    expect(warnings).toHaveLength(2);
  });

  it('warns when vllm-only knobs target llama.cpp/mlx', () => {
    expect(buildBackendArgs('llama.cpp', { 'tensor-parallel': '2' }).warnings).toHaveLength(1);
    expect(buildBackendArgs('mlx', { dtype: 'bfloat16' }).warnings).toHaveLength(1);
  });
});

// ─── structural keys & validation ───────────────────────────

describe('buildBackendArgs — structural keys and validation', () => {
  it('skips structural keys (backend/model/mmproj)', () => {
    const { args, warnings } = buildBackendArgs('llama.cpp', {
      backend: 'llama.cpp',
      model: 'org/repo/model.gguf',
      mmproj: 'org/repo/mmproj.gguf',
      temp: '0.7',
    });
    expect(args).toEqual(['--temp', '0.7']);
    expect(warnings).toEqual([]);
    for (const k of ['backend', 'model', 'mmproj']) {
      expect(STRUCTURAL_KEYS.has(k)).toBe(true);
    }
  });

  it('warns on unknown keys', () => {
    const { args, warnings } = buildBackendArgs('llama.cpp', { temperature: '0.7' });
    expect(args).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('temperature');
  });

  it('warns on invalid number values', () => {
    const { args, warnings } = buildBackendArgs('llama.cpp', { temp: 'hot' });
    expect(args).toEqual([]);
    expect(warnings[0]).toContain('temp');
  });

  it('warns on invalid boolean values', () => {
    const { warnings } = buildBackendArgs('llama.cpp', { thinking: 'yes' });
    expect(warnings[0]).toContain('thinking');
  });

  it('returns empty output for an empty config', () => {
    expect(buildBackendArgs('llama.cpp', {})).toEqual({ args: [], warnings: [] });
  });
});

// ─── schema integrity ───────────────────────────────────────

describe('PARAM_SCHEMA integrity', () => {
  it('every entry declares a type and a flags or apply map for each backend', () => {
    for (const [key, spec] of Object.entries(PARAM_SCHEMA)) {
      expect(spec.type, `${key} missing type`).toBeDefined();
      const map = spec.flags || spec.apply;
      expect(map, `${key} missing flags/apply`).toBeDefined();
      expect(map).toHaveProperty('llama.cpp');
      expect(map).toHaveProperty('mlx');
      expect(map).toHaveProperty('vllm');
    }
  });
});
