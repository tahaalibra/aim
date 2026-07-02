import os

files = [
    "AGENTS.md",
    "bin/aim.js",
    "package.json",
    "README.md",
    "src/commands/agent.js",
    "src/commands/check.js",
    "src/commands/config-gen.js",
    "src/commands/download.js",
    "src/commands/install.js",
    "src/commands/list.js",
    "src/commands/qrun.js",
    "src/commands/rm.js",
    "src/commands/run.js",
    "src/commands/serve.js",
    "src/commands/status.js",
    "src/config.js",
    "src/models.js",
    "src/params.js",
    "src/paths.js",
    "src/utils.js",
    "test/agent.test.js",
    "test/cli.test.js",
    "test/config-gen.test.js",
    "test/config.test.js",
    "test/list.test.js",
    "test/params.test.js",
    "test/paths.test.js",
    "test/qrun.test.js",
    "test/run.test.js",
    "test/serve.test.js",
    "test/utils.test.js"
]

with open("gemma-12b-review.md", "w", encoding="utf-8") as outfile:
    for file_path in files:
        if os.path.exists(file_path):
            outfile.write(f"# File: {file_path}\n")
            with open(file_path, "r", encoding="utf-8") as infile:
                outfile.write(infile.read())
            outfile.write("\n\n---\n\n")
