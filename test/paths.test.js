import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';
import {
  AI_HOME, MODELS_DIR, BACKENDS_DIR, BIN_DIR,
  CONFIG_PATH, LLAMA_CPP_DIR, LLAMA_SERVER_BIN,
  MLX_VENV_DIR, MLX_PYTHON,
} from '../src/paths.js';

const home = homedir();

describe('paths', () => {
  it('AI_HOME is ~/ai', () => {
    expect(AI_HOME).toBe(join(home, 'ai'));
  });

  it('MODELS_DIR is ~/ai/models', () => {
    expect(MODELS_DIR).toBe(join(home, 'ai', 'models'));
  });

  it('BACKENDS_DIR is ~/ai/backends', () => {
    expect(BACKENDS_DIR).toBe(join(home, 'ai', 'backends'));
  });

  it('BIN_DIR is ~/ai/bin', () => {
    expect(BIN_DIR).toBe(join(home, 'ai', 'bin'));
  });

  it('CONFIG_PATH is ~/ai/config.json', () => {
    expect(CONFIG_PATH).toBe(join(home, 'ai', 'config.json'));
  });

  it('LLAMA_CPP_DIR is ~/ai/backends/llama.cpp', () => {
    expect(LLAMA_CPP_DIR).toBe(join(home, 'ai', 'backends', 'llama.cpp'));
  });

  it('LLAMA_SERVER_BIN is ~/ai/bin/llama-server', () => {
    expect(LLAMA_SERVER_BIN).toBe(join(home, 'ai', 'bin', 'llama-server'));
  });

  it('MLX_VENV_DIR is ~/ai/backends/mlx', () => {
    expect(MLX_VENV_DIR).toBe(join(home, 'ai', 'backends', 'mlx'));
  });

  it('MLX_PYTHON is ~/ai/backends/mlx/bin/python', () => {
    expect(MLX_PYTHON).toBe(join(home, 'ai', 'backends', 'mlx', 'bin', 'python'));
  });
});
