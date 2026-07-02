#!/usr/bin/env node

import { program } from "commander";
import { registerDownload } from "../src/commands/download.js";
import { registerInstall } from "../src/commands/install.js";
import { registerRun } from "../src/commands/run.js";
import { registerServe, updateConfigIni } from "../src/commands/serve.js";
import {
  registerModelList,
  registerBackendList,
} from "../src/commands/list.js";
import { registerBackendCheck } from "../src/commands/check.js";
import { registerStatus } from "../src/commands/status.js";
import { registerQrun } from "../src/commands/qrun.js";
import { registerModelRm, registerBackendRm } from "../src/commands/rm.js";
import { registerConfigGen } from "../src/commands/config-gen.js";
import { registerConfig } from "../src/config.js";
import { registerAgent } from "../src/commands/agent.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { success, setDebug } from "../src/utils.js";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8"),
);

program
  .name("aim")
  .description("AI Model Manager — download, install, and run local LLMs")
  .version(pkg.version)
  .option("-d, --debug", "Print each backend/subprocess command before it runs");

// Enable debug if -d/--debug is present at the root (`aim -d serve`) or on the
// invoked subcommand (`aim serve -d`); walk parents so nested commands work too.
program.hook("preAction", (_thisCommand, actionCommand) => {
  for (let cmd = actionCommand; cmd; cmd = cmd.parent) {
    if (cmd.opts().debug) { setDebug(true); break; }
  }
});

// ─── Top-Level Commands ─────────────────────────────────────
registerRun(program);
registerServe(program);
registerQrun(program);
registerStatus(program);
registerConfig(program);
registerAgent(program);

// ─── Model Subcommands ──────────────────────────────────────
const modelCmd = program
  .command("model")
  .description("Manage downloaded models");
registerDownload(modelCmd);
registerModelList(modelCmd);
registerModelRm(modelCmd);

modelCmd
  .command("config")
  .option("--prune", "Remove registry entries whose model is no longer on disk")
  .description("Update the model registry (aim-models.ini) and regenerate the serve preset")
  .action((options) => {
    const stats = updateConfigIni({ prune: !!options.prune });
    const pruned = stats.pruned ? `, ${stats.pruned} pruned` : "";
    success(`Registry updated — ${stats.total} models (${stats.added} added${pruned})`);
  });
registerConfigGen(modelCmd);

// ─── Backend Subcommands ────────────────────────────────────
const backendCmd = program
  .command("backend")
  .description("Manage backend runtimes");
registerInstall(backendCmd);
registerBackendList(backendCmd);
registerBackendRm(backendCmd);
registerBackendCheck(backendCmd);

program.parse();
