import type { Vec3 } from "vec3";

export type CompassDirection = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
export type Direction = CompassDirection;
export type ToolStatus = "success" | "failed" | "interrupted";

export interface Config {
  mc_host: string;
  mc_port: number;
  mc_version: string;
  bot_username: string;
  ws_port: number;
  llm_base_url: string;
  llm_api_key: string;
  llm_model: string;
  enable_thinking: boolean;
  temperature: number;
  heartbeat_seconds: number;
  scan_radius_blocks: number;
  entity_radius_blocks: number;
  block_whitelist: string[];
  viewer_enabled: boolean;
  episode_time_limit_minutes: number;
}

export type BotConfig = Config;

export interface ToolResult {
  status: ToolStatus;
  detail: string;
}

export interface LastAction extends ToolResult {
  tool: string;
  args: Record<string, unknown>;
}

export interface MemoryView {
  goal: string;
  pinned: Record<string, unknown>;
  recent_events: string[];
  longterm?: string[] | null;
  pending_craft?: { item: string; count: number; reason: string } | null;
}

export type MemorySnapshot = MemoryView;

export interface ToolContext {
  bot: any;
  config: Config;
  signal: AbortSignal;
  emitEvent: (name: string, data?: Record<string, unknown>) => void;
  recentEvents: string[];
  stopCurrent: (reason?: string) => void;
}

export type ToolHandler = (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;

export interface ToolDefinition {
  name: string;
  timeoutMs: number;
  run: ToolHandler;
}

export interface ObservationStatus {
  position: [number, number, number];
  health: number;
  hunger: number;
  oxygen: number;
  time: "day" | "sunset" | "night" | "sunrise";
  minutes_to_night: number;
  weather: "clear" | "rain" | "thunder";
  biome: string;
  light: number;
  danger_flags: string[];
}

export interface InventoryObservation {
  held: string | null;
  items: Record<string, number>;
  free_slots: number;
  armor: Array<string | null>;
}

export interface EntityObservation {
  type: string;
  dist: number;
  dir: CompassDirection;
  hostile: boolean;
}

export interface BlockObservation {
  type: string;
  nearest_dist: number;
  pos: [number, number, number];
  count_in_range: number;
}

export interface Observation {
  status: ObservationStatus;
  inventory: InventoryObservation;
  entities: EntityObservation[];
  blocks_of_interest: BlockObservation[];
  last_action: LastAction | null;
  memory: MemoryView;
}

export interface RuntimeState {
  currentTool: {
    id: string;
    name: string;
    controller: AbortController;
    startedAt: number;
  } | null;
  lastAction: LastAction | null;
  recentEvents: string[];
}

export interface ToolCallMessage {
  id: string;
  type: "tool_call";
  tool: string;
  args: Record<string, unknown>;
}

export interface VecLike {
  x: number;
  y: number;
  z: number;
}

export function vecToTuple(vec: VecLike): [number, number, number] {
  return [Math.floor(vec.x), Math.floor(vec.y), Math.floor(vec.z)];
}

export function asVec3(value: VecLike): Vec3 {
  return value as Vec3;
}
