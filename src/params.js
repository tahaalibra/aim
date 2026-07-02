/**
 * Canonical run-parameter schema and backend translation.
 *
 * A model's run configuration lives in `aim-models.ini` using aim-owned key
 * names. This module is the single place that knows how each canonical key maps
 * to a concrete CLI flag on each backend, so adding a parameter is one new row
 * and adding a backend is one new column — no imperative per-key code anywhere
 * else.
 *
 * Each schema entry is one of:
 *   - { type, flags:  { <backend>: '--flag' | null } }   simple value → [flag, value]
 *   - { type, apply:  { <backend>: fn(value) => string[] | null } }  expands to many flags
 *
 * A `null` mapping means the parameter is *not supported* on that backend. The
 * translator emits a warning rather than silently dropping it.
 */

function llamaThinking(value) {
  // llama.cpp enables thinking via jinja templating kwargs.
  return value
    ? ['--jinja', '--chat-template-kwargs', JSON.stringify({ enable_thinking: true })]
    : [];
}

function mlxThinking(value) {
  // mlx_lm.server takes templating kwargs via --chat-template-args (JSON).
  return value
    ? ['--chat-template-args', JSON.stringify({ enable_thinking: true })]
    : [];
}

// Flag names verified against llama-server, `mlx_lm.server`, and `vllm serve`
// (vllm.entrypoints.openai.api_server) help output. A `null` mapping means the
// parameter has no equivalent on that backend (the translator warns instead of
// emitting an unrecognized flag, which would crash the server with a non-zero
// exit).
//
// Note on vLLM: sampling knobs (temp, top-p, top-k, min-p, max-tokens, the
// penalties) are *per-request* in vLLM, not server-launch flags — there is no
// way to bake them into `vllm serve`, so they map to null and warn. vLLM-only
// runtime knobs live in their own keys further down.
export const PARAM_SCHEMA = {
  temp:                { type: 'number', flags: { 'llama.cpp': '--temp',              'mlx': '--temp',        'vllm': null } },
  'top-p':             { type: 'number', flags: { 'llama.cpp': '--top-p',             'mlx': '--top-p',       'vllm': null } },
  'top-k':             { type: 'number', flags: { 'llama.cpp': '--top-k',             'mlx': '--top-k',       'vllm': null } },
  'min-p':             { type: 'number', flags: { 'llama.cpp': '--min-p',             'mlx': '--min-p',       'vllm': null } },
  'max-tokens':        { type: 'number', flags: { 'llama.cpp': '--n-predict',         'mlx': '--max-tokens',  'vllm': null } },
  'ctx-size':          { type: 'number', flags: { 'llama.cpp': '--ctx-size',          'mlx': null,            'vllm': '--max-model-len' } },
  seed:                { type: 'number', flags: { 'llama.cpp': '--seed',              'mlx': null,            'vllm': '--seed' } },
  'presence-penalty':  { type: 'number', flags: { 'llama.cpp': '--presence-penalty',  'mlx': null,            'vllm': null } },
  'frequency-penalty': { type: 'number', flags: { 'llama.cpp': '--frequency-penalty', 'mlx': null,            'vllm': null } },
  'repeat-penalty':    { type: 'number', flags: { 'llama.cpp': '--repeat-penalty',    'mlx': null,            'vllm': null } },
  alias:               { type: 'string', flags: { 'llama.cpp': '--alias',             'mlx': null,            'vllm': '--served-model-name' } },
  thinking:            { type: 'bool',   apply: { 'llama.cpp': llamaThinking,         'mlx': mlxThinking,     'vllm': null } },

  // Runtime / performance knobs (llama.cpp only). `n-gpu-layers` and `flash-attn`
  // accept 'auto'/'all'/'on'/'off' as well as numbers, so they're typed as strings.
  // `spec-type` + `spec-draft-n-max` drive MTP / speculative decoding. `jinja`
  // enables the model's chat template without forcing enable_thinking (use the
  // `thinking` key when you specifically want thinking toggled on).
  'flash-attn':        { type: 'string', flags: { 'llama.cpp': '--flash-attn',        'mlx': null,            'vllm': null } },
  'n-gpu-layers':      { type: 'string', flags: { 'llama.cpp': '--n-gpu-layers',      'mlx': null,            'vllm': null } },
  'spec-type':         { type: 'string', flags: { 'llama.cpp': '--spec-type',         'mlx': null,            'vllm': null } },
  'spec-draft-n-max':  { type: 'number', flags: { 'llama.cpp': '--spec-draft-n-max',  'mlx': null,            'vllm': null } },
  jinja:               { type: 'bool',   flags: { 'llama.cpp': '--jinja',             'mlx': null,            'vllm': null } },

  // vLLM-only runtime knobs (no llama.cpp/mlx equivalent). `dtype` selects the
  // load precision (auto/bfloat16/float16/…); `tensor-parallel` shards across
  // GPUs; `gpu-mem-util` is the 0–1 KV-cache fraction; `quantization` names a
  // quant method (awq, gptq, fp8, …); `max-num-seqs` caps concurrent sequences;
  // `trust-remote-code` allows custom modeling code from the repo.
  dtype:               { type: 'string', flags: { 'llama.cpp': null,                  'mlx': null,            'vllm': '--dtype' } },
  'tensor-parallel':   { type: 'number', flags: { 'llama.cpp': null,                  'mlx': null,            'vllm': '--tensor-parallel-size' } },
  'gpu-mem-util':      { type: 'number', flags: { 'llama.cpp': null,                  'mlx': null,            'vllm': '--gpu-memory-utilization' } },
  quantization:        { type: 'string', flags: { 'llama.cpp': null,                  'mlx': null,            'vllm': '--quantization' } },
  'max-num-seqs':      { type: 'number', flags: { 'llama.cpp': null,                  'mlx': null,            'vllm': '--max-num-seqs' } },
  'trust-remote-code': { type: 'bool',   flags: { 'llama.cpp': null,                  'mlx': null,            'vllm': '--trust-remote-code' } },
};

/** Keys the launcher handles structurally (resolved into paths), not sampling params. */
export const STRUCTURAL_KEYS = new Set(['backend', 'model', 'mmproj']);

export const BACKENDS = ['llama.cpp', 'mlx', 'vllm'];

/**
 * Validate/coerce a raw INI value according to the schema type.
 * Returns the value to use; throws with a clear message on bad input.
 * Numbers keep their original string form (CLI flags take strings).
 */
function coerce(type, raw, key) {
  if (type === 'bool') {
    if (raw === true || raw === 'true' || raw === '1') return true;
    if (raw === false || raw === 'false' || raw === '0' || raw === '' || raw === undefined) return false;
    throw new Error(`Invalid boolean for "${key}": ${raw} (use true/false)`);
  }
  if (type === 'number') {
    if (Number.isNaN(Number(raw))) throw new Error(`Invalid number for "${key}": ${raw}`);
    return String(raw);
  }
  return String(raw);
}

/**
 * Translate an aim-models.ini section config into backend-native CLI args.
 *
 * Structural keys (backend/model/mmproj) are skipped — the caller resolves those
 * into model/mmproj paths. Unknown keys and parameters unsupported on the chosen
 * backend are collected into `warnings` instead of being silently dropped.
 *
 * @param {string} backend  'llama.cpp' | 'mlx' | 'vllm'
 * @param {object} config   parsed INI section (key → string value)
 * @returns {{ args: string[], warnings: string[] }}
 */
/**
 * Convert a llama.cpp CLI arg array (as produced by buildBackendArgs) into
 * llama-server preset `key = value` lines for config.ini.
 *
 * The router preset (`--models-preset`) accepts the same option names as the
 * CLI, minus the leading dashes. Value-bearing flags become `key = value`;
 * bare boolean flags (e.g. --jinja) become `key = true`.
 */
export function llamaArgsToPresetLines(args) {
  const lines = [];
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (!tok.startsWith('--')) continue; // defensive: position should be a flag
    const key = tok.replace(/^--/, '');
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      lines.push(`${key} = true`);
    } else {
      lines.push(`${key} = ${next}`);
      i++;
    }
  }
  return lines;
}

export function buildBackendArgs(backend, config) {
  const args = [];
  const warnings = [];

  for (const [key, raw] of Object.entries(config)) {
    if (STRUCTURAL_KEYS.has(key)) continue;

    const spec = PARAM_SCHEMA[key];
    if (!spec) {
      warnings.push(`Unknown config key "${key}" — ignored`);
      continue;
    }

    let value;
    try {
      value = coerce(spec.type, raw, key);
    } catch (err) {
      warnings.push(err.message);
      continue;
    }

    // Params that expand to multiple flags.
    if (spec.apply) {
      const fn = spec.apply[backend];
      if (fn == null) {
        if (value) warnings.push(`"${key}" is not supported by ${backend} — ignored`);
        continue;
      }
      args.push(...fn(value));
      continue;
    }

    // Simple value → [flag, value] mapping.
    const flag = spec.flags[backend];
    if (flag == null) {
      warnings.push(`"${key}" is not supported by ${backend} — ignored`);
      continue;
    }
    if (spec.type === 'bool') {
      if (value) args.push(flag);
    } else {
      args.push(flag, String(value));
    }
  }

  return { args, warnings };
}
