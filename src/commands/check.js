import { existsSync } from "fs";
import chalk from "chalk";
import { execa } from "execa";
import {
  LLAMA_SERVER_BIN,
  MLX_VENV_DIR,
  MLX_PYTHON,
  VLLM_VENV_DIR,
  VLLM_PYTHON,
} from "../paths.js";
import { quietExec, getHfVersion, info } from "../utils.js";

export function registerBackendCheck(program) {
  program
    .command("check")
    .description("Verify that installed backends are actually functional")
    .action(async () => {
      await checkBackends();
    });
}

async function checkBackends() {
  console.log(`\n  ${chalk.bold("Backend Check")}\n`);

  let allPassed = true;

  const llamaOk = await checkLlamaCpp();
  if (!llamaOk) allPassed = false;

  const mlxOk = await checkMlx();
  if (!mlxOk) allPassed = false;

  const vllmOk = await checkVllm();
  if (!vllmOk) allPassed = false;

  const hfOk = await checkHuggingface();
  if (!hfOk) allPassed = false;

  console.log();

  if (allPassed) {
    info(chalk.green("All backends are working correctly."));
  } else {
    info(chalk.yellow("One or more backends need attention. See above for details."));
  }
}

// ─── llama.cpp ──────────────────────────────────────────────

async function checkLlamaCpp() {
  const label = "llama.cpp";

  if (!existsSync(LLAMA_SERVER_BIN)) {
    printResult(label, false, [
      `${chalk.red("✗")} Binary not found: ${LLAMA_SERVER_BIN}`,
      chalk.dim(`  → Install with: aim backend install llama.cpp`),
    ]);
    return false;
  }

  try {
    const { stderr, exitCode } = await execa(
      LLAMA_SERVER_BIN,
      ["--version"],
      { stdio: "pipe", timeout: 10_000 },
    );
    if (exitCode !== 0 && !stderr) {
      printResult(label, false, [
        `${chalk.red("✗")} Binary exists but --version returned no output`,
      ]);
      return false;
    }
    const m = stderr.match(/version:\s*(.+)$/im);
    const version = m ? m[1].trim() : "unknown";
    printResult(label, true, [`${chalk.green("✓")} Running — ${version}`]);
    return true;
  } catch (err) {
    printResult(label, false, [
      `${chalk.red("✗")} Failed to run --version: ${err.message}`,
    ]);
    return false;
  }
}

// ─── MLX ────────────────────────────────────────────────────

async function checkMlx() {
  const label = "mlx";

  if (!existsSync(MLX_PYTHON)) {
    printResult(label, false, [
      `${chalk.red("✗")} Python venv not found: ${MLX_VENV_DIR}`,
      chalk.dim(`  → Install with: aim backend install mlx`),
    ]);
    return false;
  }

  const checks = [];
  let passed = true;

  // 1. Can we import mlx_lm and get a version? (primary check)
  try {
    const result = await execa(
      MLX_PYTHON,
      ["-c", "import mlx_lm; print(mlx_lm.__version__)"],
      { stdio: "pipe", timeout: 15_000 },
    );
    const version = result.stdout.trim();
    if (version) {
      checks.push(`${chalk.green("✓")} mlx-lm ${version} loaded successfully`);
    } else {
      checks.push(
        `${chalk.red("✗")} mlx_lm imports but has no __version__`,
      );
      passed = false;
    }
  } catch (err) {
    const msg = err.stderr?.trim() || err.message || "unknown error";
    // Show only the last meaningful line of the traceback
    const lines = msg.split("\n");
    const shortMsg = lines.length > 3 ? lines.slice(-2).join(" ") : msg;
    checks.push(
      `${chalk.red("✗")} Cannot import mlx_lm: ${shortMsg}`,
    );
    passed = false;
  }

  // 2. Optional: check if pip is available (informational only)
  const pipOk = await checkPythonModule(MLX_PYTHON, "pip");
  if (!pipOk) {
    checks.push(`${chalk.yellow("ℹ")} pip not in venv (installed via uv — this is fine)`);
  }

  // Final pass/fail is based only on mlx_lm importability
  if (!passed) {
    checks.push(chalk.dim(`  → Reinstall with: aim backend install mlx --force`));
  }

  // If mlx-lm imported OK, mark as passed regardless of pip status
  const mlxImported = checks.some(c => c.includes("mlx-lm") && c.includes("loaded"));
  printResult(label, mlxImported, checks);
  return mlxImported;
}

// ─── vLLM ───────────────────────────────────────────────────

async function checkVllm() {
  const label = "vllm";

  if (!existsSync(VLLM_PYTHON)) {
    printResult(label, false, [
      `${chalk.red("✗")} Python venv not found: ${VLLM_VENV_DIR}`,
      chalk.dim(`  → Install with: aim backend install vllm`),
    ]);
    return false;
  }

  // Importing vllm pulls in heavy CUDA modules and can be slow, so allow a
  // generous timeout. Success on import (with a version) is treated as healthy.
  try {
    const result = await execa(
      VLLM_PYTHON,
      ["-c", "import vllm; print(vllm.__version__)"],
      { stdio: "pipe", timeout: 60_000 },
    );
    const version = result.stdout.trim();
    if (version) {
      printResult(label, true, [`${chalk.green("✓")} vllm ${version} loaded successfully`]);
      return true;
    }
    printResult(label, false, [`${chalk.red("✗")} vllm imports but has no __version__`]);
    return false;
  } catch (err) {
    const msg = err.stderr?.trim() || err.message || "unknown error";
    const lines = msg.split("\n");
    const shortMsg = lines.length > 3 ? lines.slice(-2).join(" ") : msg;
    printResult(label, false, [
      `${chalk.red("✗")} Cannot import vllm: ${shortMsg}`,
      chalk.dim(`  → Reinstall with: aim backend install vllm --force`),
    ]);
    return false;
  }
}

// ─── HuggingFace ────────────────────────────────────────────

async function checkHuggingface() {
  const label = "huggingface";

  try {
    const hfCli = await quietExec("which", ["hf"]);
    if (hfCli) {
      const version = await quietExec("hf", ["--version"]);
      if (version) {
        printResult(label, true, [
          `${chalk.green("✓")} Running — ${version}`,
        ]);
        return true;
      }
    }

    // Fallback: huggingface-cli
    const hfCliLegacy = await quietExec("which", ["huggingface-cli"]);
    if (hfCliLegacy) {
      const version = await quietExec("huggingface-cli", ["--version"]);
      if (version) {
        printResult(label, true, [
          `${chalk.green("✓")} Running — ${version}`,
        ]);
        return true;
      }
    }

    // Also try python -m huggingface_hub.cli
    const moduleVersion = await quietExec(
      "python3",
      ["-c", "from huggingface_hub import __version__; print(__version__)"],
    );
    if (moduleVersion) {
      printResult(label, true, [
        `${chalk.green("✓")} Running — ${moduleVersion}`,
      ]);
      return true;
    }

    const hfInfo = await getHfVersion();
    if (!hfInfo) {
      printResult(label, false, [
        `${chalk.red("✗")} HuggingFace CLI not found in PATH`,
        chalk.dim(`  → Install with: aim backend install huggingface`),
      ]);
      return false;
    }

    // Version resolved but binary not runnable
    printResult(label, false, [
      `${chalk.red("✗")} HuggingFace CLI found (${hfInfo.cli}) but not runnable`,
      chalk.dim(`  → Try: pip3 install -U huggingface_hub[cli]`),
    ]);
    return false;
  } catch (err) {
    printResult(label, false, [
      `${chalk.red("✗")} Failed to verify: ${err.message}`,
    ]);
    return false;
  }
}

// ─── Helpers ────────────────────────────────────────────────

function printResult(name, passed, lines) {
  const status = passed
    ? chalk.green("✓ OK")
    : chalk.red("✗ FAILED");
  console.log(`  ${chalk.bold(name.padEnd(14))} ${status}`);
  for (const line of lines) {
    console.log(`      ${line}`);
  }
  console.log();
}

async function checkPythonModule(python, moduleName) {
  try {
    await execa(
      python,
      ["-c", `import ${moduleName}`],
      { stdio: "pipe", timeout: 10_000 },
    );
    return true;
  } catch {
    return false;
  }
}
