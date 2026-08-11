#!/usr/bin/env bash
# Build-time prime kernel venv bootstrap (mirrors prime's bootstrapVenv).
# Installs python 3.11 (uv) + ipykernel/dill/RLM-extras + prime-agent-runtime
# into /opt/prime-kernel-venv and writes a .bootstrap-version marker whose
# runtime hash matches prime's hashRuntimeSource, so the venv is treated as
# current and never re-bootstrapped at runtime.
set -euo pipefail

VENV=/opt/prime-kernel-venv
RUNTIME=/opt/prime-agent/dist/prime-agent-runtime

uv python install 3.11
uv venv "$VENV" --python 3.11 --seed
uv pip install --python "$VENV/bin/python" \
  ipykernel dill requests httpx pyyaml tomli python-dotenv pandas numpy scipy beautifulsoup4 lxml pydantic tyro nest-asyncio
"$VENV/bin/pip" install "$RUNTIME"

# Compute runtime identity exactly like hashRuntimeSource:
# sha256 over (relative path \0 content \0) for pyproject.toml + src/rlm/**/*.py, sorted.
HASH=$(node -e '
  const fs = require("fs"), path = require("path"), crypto = require("crypto");
  const srcDir = process.argv[1];
  const files = [path.join(srcDir, "pyproject.toml")];
  (function walk(d) {
    fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f); else if (e.name.endsWith(".py")) files.push(f);
    });
  })(path.join(srcDir, "src", "rlm"));
  files.sort();
  const h = crypto.createHash("sha256");
  for (const f of files) { h.update(path.relative(srcDir, f)); h.update("\0"); h.update(fs.readFileSync(f)); h.update("\0"); }
  process.stdout.write(h.digest("hex"));
' "$RUNTIME")

cat > "$VENV/.bootstrap-version" <<EOF
{"schema":8,"ipykernel":"ipykernel","runtime":"sha256:${HASH}","snapshot":"dill","extraUvArgs":["requests","httpx","pyyaml","tomli","python-dotenv","pandas","numpy","scipy","beautifulsoup4","lxml","pydantic","tyro"],"pythonSkills":[]}
EOF
echo "prime kernel venv ready at $VENV (runtime sha256:${HASH:0:16}...)"
