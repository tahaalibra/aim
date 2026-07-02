import { fail, warn, isUserAbort } from "../utils.js";
import { runModel } from "./run.js";

/**
 * `aim qrun` is a deprecated alias for `aim run`. The two were unified: `aim run`
 * now reads per-model defaults from aim-models.ini and supports the interactive
 * picker. Kept as a hidden alias for one release so existing muscle memory and
 * scripts keep working.
 */
export function registerQrun(program) {
  program
    .command("qrun [model_name]", { hidden: true })
    .option("--backend <backend>", "Backend to use (llama.cpp, mlx).")
    .option("--port <port>", "Server port (default: config defaultPort or 8080)")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .description("Deprecated alias for `aim run` — quick-start a model from aim-models.ini.")
    .action(async (model_name, options, command) => {
      warn("`aim qrun` is deprecated — use `aim run` instead.");
      try {
        await runModel(model_name, options, command);
      } catch (err) {
        if (isUserAbort(err)) process.exit(0);
        fail(`qrun failed: ${err.message}`);
      }
    });
}
