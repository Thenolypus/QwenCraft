import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type { Config } from "./types";

const configSchema = z.object({
  mc_host: z.string(),
  mc_port: z.number().int().positive(),
  mc_version: z.string(),
  bot_username: z.string(),
  ws_port: z.number().int().positive(),
  llm_base_url: z.string(),
  llm_api_key: z.string(),
  llm_model: z.string(),
  enable_thinking: z.boolean(),
  temperature: z.number(),
  heartbeat_seconds: z.number().positive(),
  scan_radius_blocks: z.number().int().positive(),
  entity_radius_blocks: z.number().int().positive(),
  block_whitelist: z.array(z.string()).min(1),
  viewer_enabled: z.boolean(),
  episode_time_limit_minutes: z.number().positive()
});

export function repoRoot(): string {
  const candidates = [
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "../..")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "config.yaml")) && fs.existsSync(path.join(candidate, "schemas"))) {
      return candidate;
    }
  }
  throw new Error("could not locate repo root containing config.yaml and schemas/");
}

export function loadConfig(): Config {
  const raw = fs.readFileSync(path.join(repoRoot(), "config.yaml"), "utf8");
  const parsed = yaml.load(raw);
  return configSchema.parse(parsed);
}

export function repoPath(...parts: string[]): string {
  return path.join(repoRoot(), ...parts);
}
