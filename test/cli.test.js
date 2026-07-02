import { describe, it, expect } from 'vitest';
import { execaCommand } from 'execa';
import { join } from 'path';

const BIN = join(process.cwd(), 'bin', 'aim.js');

async function aim(...args) {
  const { stdout, stderr, exitCode } = await execaCommand(
    `node ${BIN} ${args.join(' ')}`,
    { stdio: 'pipe', reject: false }
  );
  return { stdout, stderr, exitCode };
}

describe('CLI integration', () => {
  // ─── Help / version ─────────────────────────────────────

  it('prints version with --version', async () => {
    const { stdout, exitCode } = await aim('--version');
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('prints top-level help with --help', async () => {
    const { stdout, exitCode } = await aim('--help');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('AI Model Manager');
    expect(stdout).toContain('run');
    expect(stdout).toContain('serve');
    expect(stdout).toContain('status');
    expect(stdout).toContain('model');
    expect(stdout).toContain('backend');
  });

  // ─── Subcommand help ────────────────────────────────────

  it('model --help shows model commands', async () => {
    const { stdout, exitCode } = await aim('model', '--help');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Manage downloaded models');
    expect(stdout).toContain('download');
    expect(stdout).toContain('list');
    expect(stdout).toContain('rm');
    expect(stdout).toContain('config');
  });

  it('backend --help shows backend commands', async () => {
    const { stdout, exitCode } = await aim('backend', '--help');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Manage backend runtimes');
    expect(stdout).toContain('install');
    expect(stdout).toContain('list');
    expect(stdout).toContain('rm');
  });

  it('model download --help shows usage', async () => {
    const { stdout, exitCode } = await aim('model', 'download', '--help');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Download a model from HuggingFace');
    expect(stdout).toContain('--include');
  });

  it('backend install --help shows usage', async () => {
    const { stdout, exitCode } = await aim('backend', 'install', '--help');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Install or update a backend component');
  });

  it('run --help shows usage', async () => {
    const { stdout, exitCode } = await aim('run', '--help');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Run a model server');
    expect(stdout).toContain('--backend');
  });

  it('serve --help shows usage', async () => {
    const { stdout, exitCode } = await aim('serve', '--help');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('llama-server router');
    expect(stdout).toContain('--no-models-autoload');
  });

  // ─── status command ─────────────────────────────────────

  it('status runs successfully and shows system info', async () => {
    const { stdout, exitCode } = await aim('status');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('aim status');
    expect(stdout).toContain('System');
    expect(stdout).toContain('Node.js');
  });

  // ─── list command ───────────────────────────────────────

  it('model list runs without error', async () => {
    const { exitCode } = await aim('model', 'list');
    expect(exitCode).toBe(0);
  });

  it('backend list runs without error', async () => {
    const { stdout, exitCode } = await aim('backend', 'list');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Backends');
  });

  // ─── install validation ─────────────────────────────────

  it('backend install with unknown component fails gracefully', async () => {
    const { exitCode, stderr } = await aim('backend', 'install', 'bogus');
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Unknown component');
  });

  // ─── run validation ────────────────────────────────────

  it('run with missing model fails gracefully', async () => {
    const { exitCode, stderr } = await aim('run', 'nonexistent/model-xyz');
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Model not found');
  });
});
