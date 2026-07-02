import { homedir } from 'os';
import { join } from 'path';

export const AI_HOME = join(homedir(), 'ai');
export const MODELS_DIR = join(AI_HOME, 'models');
export const BACKENDS_DIR = join(AI_HOME, 'backends');
export const BIN_DIR = join(AI_HOME, 'bin');
export const CONFIG_PATH = join(AI_HOME, 'config.json');

// Backend-specific paths
export const LLAMA_CPP_DIR = join(BACKENDS_DIR, 'llama.cpp');
export const LLAMA_SERVER_BIN = join(BIN_DIR, 'llama-server');
export const MLX_VENV_DIR = join(BACKENDS_DIR, 'mlx');
export const MLX_PYTHON = join(MLX_VENV_DIR, 'bin', 'python');
export const VLLM_VENV_DIR = join(BACKENDS_DIR, 'vllm');
export const VLLM_PYTHON = join(VLLM_VENV_DIR, 'bin', 'python');

// Config files inside ~/ai/models/
export const CONFIG_INI_PATH = join(MODELS_DIR, 'config.ini');
export const AIM_MODELS_INI_PATH = join(MODELS_DIR, 'aim-models.ini');
