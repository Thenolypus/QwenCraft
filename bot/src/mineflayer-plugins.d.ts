declare module "mineflayer-collectblock" {
  export function plugin(bot: unknown): void;
}

declare module "mineflayer-auto-eat" {
  export function loader(bot: unknown): void;
}

declare module "mineflayer-pvp" {
  export function plugin(bot: unknown): void;
}

declare module "prismarine-viewer" {
  export function mineflayer(bot: unknown, options: Record<string, unknown>): void;
}

