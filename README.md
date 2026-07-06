# QwenCraft

QwenCraft is a local, two-process Minecraft survival agent:

- `bot/`: a TypeScript Mineflayer sidecar that connects to Minecraft, builds compact observations, runs tools, and exposes a local WebSocket server.
- `brain/`: a Python planner that connects to that WebSocket, calls an OpenAI-compatible local LLM endpoint, and dispatches exactly one tool call per decision.

The LLM is only used at decision boundaries: after a tool result, after interrupt events, or on an idle heartbeat. Mineflayer plugins handle pathing, collection, combat, and eating between decisions.

## Version Pin

The repo pins Minecraft to `1.21.11`, the newest version listed in `mineflayer@4.37.1`'s tested versions at scaffold time. That Mineflayer line requires Node 22+, so QwenCraft targets Node 22+ in order to prioritize latest Mineflayer/Minecraft support. If you later port Prismarine data to a newer Mojang version such as `26.2`, update `mc_version` in `config.yaml`, `VERSION` in `docker-compose.yml`, and the bot dependency pins together.

## Prerequisites

Before starting QwenCraft, make sure these are installed and working:

- Docker Engine with Compose. Check with `docker info` and either `docker compose version` or `docker-compose version`.
- Node.js `22+` and npm. Check with `node --version`.
- uv for the Python brain. Check with `uv --version`.
- A local OpenAI-compatible LLM server, such as vLLM, llama.cpp, or Ollama.
- Enough memory/VRAM for the model you choose.

If `docker compose up -d` fails with `connect: no such file or directory` for `/var/run/docker.sock`, Docker is installed but the daemon is not running or not reachable. On a Linux systemd machine, try:

```bash
sudo systemctl enable --now docker
docker info
```

If `docker info` says permission denied, add your user to the Docker group and open a new shell:

```bash
sudo usermod -aG docker "$USER"
newgrp docker
docker info
```

If you use Docker Desktop, start Docker Desktop first and wait until it reports that the engine is running.

## Quickstart

1. Start the local Minecraft server:

   ```bash
   docker compose up -d
   ```

   If that prints `unknown shorthand flag: 'd' in -d`, your Docker install is missing the Compose v2 plugin. Try the legacy command:

   ```bash
   docker-compose up -d
   ```

   You can check which one you have with `docker compose version` or `docker-compose version`.

2. Start the bot sidecar:

   ```bash
   cd bot
   npm install
   npm start
   ```

   `npm start` compiles TypeScript first and then runs `dist/index.js`. For live TypeScript execution during development, use `npm run dev`.

3. Serve Qwen3.5-9B with an OpenAI-compatible endpoint.

   vLLM is the recommended default if you have Hugging Face/safetensors weights and a CUDA/ROCm GPU, because it is the strongest fit for OpenAI-compatible tool calling on GPU:

   ```bash
   vllm serve Qwen/Qwen3.5-9B --host 127.0.0.1 --port 8000 --enable-auto-tool-choice --tool-call-parser qwen3_xml
   ```

   If your model is already a GGUF file, llama.cpp is the simplest path. For example:

   ```bash
   llama-server \
     -m /home/seant/Documents/LocalLLM/Qwen3.5-9B-Q8_0.gguf \
     --host 127.0.0.1 \
     --port 8080 \
     -c 8192 \
     --jinja
   ```

   Then set:

   ```yaml
   llm_base_url: http://127.0.0.1:8080/v1
   llm_model: Qwen3.5-9B-Q8_0
   ```

   vLLM can serve GGUF through `vllm-gguf-plugin`, but vLLM's own docs describe GGUF support as experimental and under-optimized. Use that route only if you specifically want to test vLLM with your GGUF and can provide the matching Hugging Face tokenizer:

   ```bash
   uv pip install vllm-gguf-plugin
   vllm serve /home/seant/Documents/LocalLLM/Qwen3.5-9B-Q8_0.gguf --tokenizer <matching-qwen-tokenizer-repo>
   ```

   For vLLM with Hugging Face weights, set:

   ```yaml
   llm_base_url: http://127.0.0.1:8000/v1
   llm_model: Qwen/Qwen3.5-9B
   ```

   Ollama is another GGUF-friendly fallback, but you need to import or pull a model Ollama knows about:

   ```bash
   ollama serve
   ollama pull qwen3.5:9b
   ```

   For Ollama's OpenAI-compatible API, set:

   ```yaml
   llm_base_url: http://127.0.0.1:11434/v1
   llm_model: qwen3.5:9b
   ```

4. In a new terminal from the repo root, install Python dependencies with uv and start the brain:

   ```bash
   uv sync --extra dev
   uv run python -m brain.main
   ```

   If your home cache is read-only, prefix uv commands with `UV_CACHE_DIR=.uv-cache`.

   For the scripted milestone policy:

   ```bash
   uv run python -m brain.main --mock
   ```

5. Watch logs in `logs/episode_<timestamp>.jsonl`.

   The bot terminal prints live Mineflayer-side state: tool starts/results, reflex events, observation summaries, position, health, hunger, inventory sketch, and Node heap usage. The brain terminal prints each planner decision and result. The JSONL file is the complete trajectory for later inspection, with a slim `llm_response` payload containing only content, tool calls, and usage. On startup, older `episode_*.jsonl` files are gzipped and the newest 20 archives are retained.

## Integration Episode

Run a seeded mock episode against the Docker server:

```bash
uv run python eval/run_episode.py --mock --seed 1
```

The runner starts the server, bot, and brain, then checks that the bot survives to sunrise with a wooden pickaxe in inventory. It writes episode metrics to the same `logs/` directory.

## Tests

```bash
cd bot
npm test
npm run build
```

From the repo root:

```bash
uv run pytest
```

## Troubleshooting

If the brain exits with `keepalive ping timeout` or `timed out while closing connection`, check the bot terminal first. The brain now disables aggressive WebSocket pings and waits according to the bot tool timeout, because `goto`, `explore`, and `mine_block` can legitimately run for about two minutes.

If the bot terminal has crashed or disconnected from Minecraft, restart it:

```bash
cd bot
npm start
```

If the bot is still running but a tool never returns, the brain sends `stop()` after the tool's expected timeout plus a small grace window and continues with a structured failed result.

If the planner appears to be continuing an old goal, check `state/brain_state.json` and `state/longterm.json`. The brain persists goal, pinned notes, compressed history, shelters, deaths, and achievements across restarts.

## Config

All runtime knobs live in `config.yaml`:

- Minecraft: host, port, version, username.
- WebSocket: local port. The bot WebSocket binds to `127.0.0.1` only.
- LLM: base URL, API key, model, thinking flag, temperature.
- Agent cadence: heartbeat seconds, episode time limit.
- Observation bounds: entity radius, block scan radius, block whitelist. Whitelist entries support leading or trailing `*` wildcards such as `*_log` or `*_ore`.
- Optional viewer: disabled by default.

## Protocol

Brain to bot:

```json
{"id":"<uuid>","type":"tool_call","tool":"mine_block","args":{"type":"oak_log","count":4}}
```

Equip uses the same tool-call envelope:

```json
{"id":"<uuid>","type":"tool_call","tool":"equip","args":{"item":"iron_helmet"}}
```

Bot to brain:

```json
{"id":"<uuid>","type":"tool_result","status":"success","detail":"collected 4 oak_log in 31s"}
```

Async bot events:

```json
{"type":"event","name":"hostile_close","data":{"type":"zombie","dist":5.2}}
```

Observation request:

```json
{"type":"get_observation"}
```

Observation response:

```json
{"type":"observation","data":{"memory":{"goal":"...","pinned":{},"recent_events":[],"longterm":["place shelter [82,71,248]"],"pending_craft":{"item":"wooden_pickaxe","count":1,"reason":"no crafting_table nearby"}}}}
```

## Deliberate v1 Choices

- No screenshots, RL, or web UI.
- `prismarine-viewer` is optional and only starts when `viewer_enabled: true`.
- The Python brain owns memory. `set_goal` and `note` are executed locally by the brain; all Minecraft-world tools are sent to the bot.
- Tool implementations prefer structured, diagnostic failures over silent retries when Mineflayer cannot find a path, recipe, furnace, fuel, bed, block, or target entity.
