import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { queryOne } from "../database";
import { ApiException } from "../shared/http";
import { serverDir } from "../shared/config";
import { readProperties } from "./properties";
import { isRunning, runtimeState } from "../processes/manager";
import { recordActivity } from "../services/audit";
import {
  type Compound, type Tag, byte, compound, float, int, list, listOf, num,
  readNbtFile, str, string, writeNbtFile,
} from "./nbt-file";

/**
 * Real player-data editing.
 *
 * Everything here reads and writes Minecraft's own `playerdata/<uuid>.dat` NBT file — the exact
 * file the game loads when a player joins. No values are invented: if the file (or a field) is
 * missing, the UI is told so instead of showing a decorative default.
 *
 * Slot numbering follows the game: 0–8 hotbar, 9–35 main inventory, 100 boots, 101 leggings,
 * 102 chestplate, 103 helmet, -106 offhand. The panel exposes a friendlier 0–40 layout
 * (0–35 inventory, 36 helmet, 37 chest, 38 legs, 39 boots, 40 offhand).
 */

export const INVENTORY_SLOTS = 41;

const ARMOR_TO_GAME: Record<number, number> = { 36: 103, 37: 102, 38: 101, 39: 100, 40: -106 };
const GAME_TO_ARMOR: Record<number, number> = { 103: 36, 102: 37, 101: 38, 100: 39, [-106]: 40 };

export interface ItemStack {
  /** Panel slot id (0–40). */
  slot: number;
  id: string;
  count: number;
  /** True when the stack carries extra NBT (enchants, custom name, container contents…). */
  hasNbt: boolean;
  displayName: string | null;
}

export interface PlayerDataSnapshot {
  uuid: string;
  username: string;
  online: boolean;
  serverRunning: boolean;
  path: string | null;
  fileModifiedAt: number | null;
  canEdit: boolean;
  /** Machine-readable reason when editing is blocked: "online" | "no_data" | "unreadable". */
  blockedReason: string | null;
  blockedMessage: string | null;
  warning: string | null;
  vitals: {
    health: number;
    maxHealth: number;
    absorption: number;
    food: number;
    saturation: number;
    exhaustion: number;
    xpLevel: number;
    xpProgress: number;
    xpTotal: number;
    gamemode: number;
    dimension: string | null;
    position: { x: number; y: number; z: number } | null;
    selectedSlot: number;
  };
  inventory: ItemStack[];
  itemFormat: "modern" | "legacy";
}

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

export function playerDataPath(serverId: number, uuid: string): string | null {
  const row = queryOne<{ uuid: string }>("SELECT uuid FROM servers WHERE id = ?", [serverId]);
  if (!row) return null;
  const directory = serverDir(row.uuid);
  const properties = readProperties(directory);
  const levelName = properties.values["level-name"] || "world";
  return join(directory, levelName, "playerdata", `${uuid}.dat`);
}

function playerRecord(serverId: number, uuid: string) {
  return queryOne<{ username: string; online: number }>(
    "SELECT username, online FROM players WHERE server_id = ? AND uuid = ?",
    [serverId, uuid],
  );
}

function onlineNames(serverId: number): Set<string> {
  const state = runtimeState(serverId);
  return new Set([...state.players.values()].map((player) => player.name.toLowerCase()));
}

/* ------------------------------------------------------------------ */
/* Item helpers                                                        */
/* ------------------------------------------------------------------ */

function detectFormat(root: Compound): "modern" | "legacy" {
  const items = list(root.Inventory);
  for (const entry of items) {
    const value = (entry as { v?: Compound }).v;
    if (!value) continue;
    if (value.count) return "modern";
    if (value.Count) return "legacy";
  }
  // Nothing in the inventory to learn from: derive it from the server's Minecraft version.
  return "modern";
}

function countOf(item: Compound): number {
  const modern = item.count ? num(item.count) : null;
  if (modern !== null) return modern;
  const legacy = item.Count ? num(item.Count) : null;
  return legacy ?? 0;
}

function setCount(item: Compound, count: number, format: "modern" | "legacy"): void {
  if (item.count) item.count = int(count);
  else if (item.Count) item.Count = byte(count);
  else if (format === "modern") item.count = int(count);
  else item.Count = byte(count);
}

function slotOf(item: Compound): number | null {
  const raw = item.Slot ? num(item.Slot) : null;
  return raw === null ? null : raw;
}

function gameSlotToPanel(gameSlot: number): number | null {
  if (gameSlot >= 0 && gameSlot <= 35) return gameSlot;
  return GAME_TO_ARMOR[gameSlot] ?? null;
}

function panelSlotToGame(panelSlot: number): number | null {
  if (panelSlot >= 0 && panelSlot <= 35) return panelSlot;
  return ARMOR_TO_GAME[panelSlot] ?? null;
}

/** `minecraft:lapis_lazuli` → `Lapis Lazuli`. */
export function prettyItemName(id: string): string {
  const path = id.includes(":") ? id.split(":")[1]! : id;
  return path
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function toStack(item: Compound, panelSlot: number): ItemStack | null {
  const id = str(item.id);
  if (!id) return null;
  return {
    slot: panelSlot,
    id,
    count: countOf(item),
    hasNbt: Boolean(item.tag) || Boolean(item.components),
    displayName: null,
  };
}

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

function maxHealthOf(root: Compound): number {
  const attributes = list(root.Attributes);
  for (const attribute of attributes) {
    const value = (attribute as { v?: Compound }).v;
    if (!value) continue;
    if (str(value.Name) === "minecraft:generic.max_health") {
      const base = value.Base ? num(value.Base) : null;
      if (base !== null && base > 0) return base;
    }
  }
  return 20;
}

export function readPlayerData(serverId: number, uuid: string): PlayerDataSnapshot {
  const record = playerRecord(serverId, uuid);
  const path = playerDataPath(serverId, uuid);
  const running = isRunning(serverId);
  const online = record ? onlineNames(serverId).has(record.username.toLowerCase()) : false;
  const base = {
    uuid,
    username: record?.username ?? uuid,
    online,
    serverRunning: running,
  };

  const empty: PlayerDataSnapshot = {
    ...base,
    path: null,
    fileModifiedAt: null,
    canEdit: false,
    blockedReason: "no_data",
    blockedMessage: "This player has no saved data yet — they have not joined the server since it was created, or the world/level-name changed.",
    warning: null,
    vitals: {
      health: 0, maxHealth: 20, absorption: 0, food: 0, saturation: 0, exhaustion: 0,
      xpLevel: 0, xpProgress: 0, xpTotal: 0, gamemode: 0, dimension: null, position: null, selectedSlot: 0,
    },
    inventory: [],
    itemFormat: "modern",
  };

  if (!path || !existsSync(path)) return empty;
  const root = readNbtFile(path);
  if (!root) {
    return { ...empty, path, blockedReason: "unreadable", blockedMessage: "The player data file could not be parsed as NBT. It may be corrupted or from an unsupported version." };
  }

  const format = detectFormat(root);
  const inventory: ItemStack[] = [];
  for (const entry of list(root.Inventory)) {
    const item = (entry as { v?: Compound }).v;
    if (!item) continue;
    const gameSlot = slotOf(item);
    if (gameSlot === null) continue;
    const panelSlot = gameSlotToPanel(gameSlot);
    if (panelSlot === null) continue;
    const stack = toStack(item, panelSlot);
    if (stack) inventory.push(stack);
  }
  inventory.sort((a, b) => a.slot - b.slot);

  const position = list(root.Pos).map((entry) => num(entry) ?? 0);

  const blocked = online
    ? { reason: "online", message: "This player is online right now. The running server keeps their data in memory and writes it back on disconnect, so file edits would be overwritten. Ask them to log out (or kick them) and try again." }
    : null;

  return {
    ...base,
    path,
    fileModifiedAt: statSync(path).mtimeMs,
    canEdit: !blocked,
    blockedReason: blocked?.reason ?? null,
    blockedMessage: blocked?.message ?? null,
    warning: running && !online
      ? "The server is running. These edits change the saved player file; they are safe while the player is offline, but stop the server first if you want zero risk of an overwrite."
      : null,
    vitals: {
      health: num(root.Health) ?? 0,
      maxHealth: maxHealthOf(root),
      absorption: num(root.Absorption) ?? 0,
      food: num(root.foodLevel) ?? 0,
      saturation: num(root.foodSaturationLevel) ?? 0,
      exhaustion: num(root.foodExhaustionLevel) ?? 0,
      xpLevel: num(root.XpLevel) ?? 0,
      xpProgress: num(root.XpP) ?? 0,
      xpTotal: num(root.XpTotal) ?? 0,
      gamemode: num(root.playerGameType) ?? 0,
      dimension: str(root.Dimension),
      position: position.length >= 3 ? { x: position[0]!, y: position[1]!, z: position[2]! } : null,
      selectedSlot: num(root.SelectedItemSlot) ?? 0,
    },
    inventory,
    itemFormat: format,
  };
}

/* ------------------------------------------------------------------ */
/* Write                                                               */
/* ------------------------------------------------------------------ */

export type PlayerDataOp =
  | { op: "vitals"; health?: number; food?: number; saturation?: number; xpLevel?: number; gamemode?: number }
  | { op: "heal" }
  | { op: "feed" }
  | { op: "move"; from: number; to: number }
  | { op: "count"; slot: number; count: number }
  | { op: "remove"; slot: number }
  | { op: "duplicate"; slot: number }
  | { op: "clear" }
  | { op: "give"; itemId: string; count?: number; slot?: number };

const GAMEMODES = new Set([0, 1, 2, 3]);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Normalises `stone`, `STONE`, `minecraft:stone` → `minecraft:stone`. */
export function normalizeItemId(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) throw new ApiException(400, "invalid_item", "An item id is required");
  const id = trimmed.includes(":") ? trimmed : `minecraft:${trimmed}`;
  if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id)) throw new ApiException(400, "invalid_item", `"${raw}" is not a valid item id`);
  return id;
}

function setVitals(root: Compound, op: Extract<PlayerDataOp, { op: "vitals" }>, maxHealth: number): void {
  if (op.health !== undefined) {
    if (!Number.isFinite(op.health)) throw new ApiException(400, "invalid_health", "Health must be a number");
    root.Health = float(clamp(op.health, 0, Math.max(20, maxHealth)));
  }
  if (op.food !== undefined) {
    if (!Number.isFinite(op.food)) throw new ApiException(400, "invalid_food", "Hunger must be a number");
    root.foodLevel = int(clamp(Math.round(op.food), 0, 20));
  }
  if (op.saturation !== undefined) {
    if (!Number.isFinite(op.saturation)) throw new ApiException(400, "invalid_saturation", "Saturation must be a number");
    root.foodSaturationLevel = float(clamp(op.saturation, 0, 20));
  }
  if (op.xpLevel !== undefined) {
    root.XpLevel = int(clamp(Math.round(op.xpLevel), 0, 21863));
    root.XpP = float(0);
  }
  if (op.gamemode !== undefined) {
    const mode = Math.round(op.gamemode);
    if (!GAMEMODES.has(mode)) throw new ApiException(400, "invalid_gamemode", "Gamemode must be 0 (survival), 1 (creative), 2 (adventure) or 3 (spectator)");
    root.playerGameType = int(mode);
  }
}

function findItem(root: Compound, panelSlot: number): { item: Compound; index: number } | null {
  const gameSlot = panelSlotToGame(panelSlot);
  if (gameSlot === null) throw new ApiException(400, "invalid_slot", `Slot ${panelSlot} cannot hold an item`);
  const items = list(root.Inventory);
  for (let index = 0; index < items.length; index += 1) {
    const item = (items[index] as { v?: Compound }).v;
    if (!item) continue;
    if (slotOf(item) === gameSlot) return { item, index };
  }
  return null;
}

function writeInventory(root: Compound, items: Tag[]): void {
  root.Inventory = listOf(items);
}

function newItem(format: "modern" | "legacy", id: string, count: number, gameSlot: number): Compound {
  const item: Compound = {
    id: string(id),
    Slot: byte(gameSlot),
  };
  if (format === "modern") item.count = int(count);
  else item.Count = byte(count);
  return item;
}

function freePanelSlot(root: Compound): number | null {
  const used = new Set<number>();
  for (const entry of list(root.Inventory)) {
    const item = (entry as { v?: Compound }).v;
    if (!item) continue;
    const gameSlot = slotOf(item);
    if (gameSlot === null) continue;
    const panelSlot = gameSlotToPanel(gameSlot);
    if (panelSlot !== null) used.add(panelSlot);
  }
  for (let slot = 0; slot <= 35; slot += 1) if (!used.has(slot)) return slot;
  for (const slot of [36, 37, 38, 39, 40]) if (!used.has(slot)) return slot;
  return null;
}

/**
 * Applies one operation to the player's saved data. Every call re-reads the file, so two edits in
 * a row never work from stale state, and a failed validation leaves the file untouched.
 */
export function applyPlayerDataOp(serverId: number, uuid: string, op: PlayerDataOp, actor: string): PlayerDataSnapshot {
  const record = playerRecord(serverId, uuid);
  if (record && onlineNames(serverId).has(record.username.toLowerCase())) {
    throw new ApiException(409, "player_online", "This player is online — their data would be overwritten on disconnect. Kick them or stop the server first.");
  }
  const path = playerDataPath(serverId, uuid);
  if (!path || !existsSync(path)) {
    throw new ApiException(404, "no_player_data", "This player has no saved data file yet");
  }
  const root = readNbtFile(path);
  if (!root) throw new ApiException(500, "unreadable_player_data", "The player data file could not be parsed");

  const format = detectFormat(root);
  const items = list(root.Inventory).slice();
  const maxHealth = maxHealthOf(root);

  switch (op.op) {
    case "vitals":
      setVitals(root, op, maxHealth);
      break;
    case "heal":
      root.Health = float(maxHealth);
      root.Absorption = float(0);
      break;
    case "feed":
      root.foodLevel = int(20);
      root.foodSaturationLevel = float(20);
      root.foodExhaustionLevel = float(0);
      break;
    case "move": {
      const source = findItem(root, op.from);
      if (!source) throw new ApiException(404, "empty_slot", "That slot is empty");
      const destination = findItem(root, op.to);
      const sourceGameSlot = panelSlotToGame(op.from)!;
      const destinationGameSlot = panelSlotToGame(op.to);
      if (destinationGameSlot === null) throw new ApiException(400, "invalid_slot", `Slot ${op.to} cannot hold an item`);
      if (destination) {
        destination.item.Slot = byte(sourceGameSlot); // swap
      }
      source.item.Slot = byte(destinationGameSlot);
      break;
    }
    case "count": {
      const found = findItem(root, op.slot);
      if (!found) throw new ApiException(404, "empty_slot", "That slot is empty");
      if (op.count <= 0) {
        items.splice(found.index, 1);
        writeInventory(root, items);
        break;
      }
      const max = found.item.id && /:(shulker_box|bundle)$/.test(str(found.item.id) ?? "") ? 1 : 64;
      setCount(found.item, clamp(Math.round(op.count), 1, max), format);
      break;
    }
    case "remove": {
      const found = findItem(root, op.slot);
      if (!found) throw new ApiException(404, "empty_slot", "That slot is empty");
      items.splice(found.index, 1);
      writeInventory(root, items);
      break;
    }
    case "duplicate": {
      const found = findItem(root, op.slot);
      if (!found) throw new ApiException(404, "empty_slot", "That slot is empty");
      const target = freePanelSlot(root);
      if (target === null) throw new ApiException(409, "inventory_full", "There is no free slot to duplicate into");
      const clone = structuredClone(found.item);
      clone.Slot = byte(panelSlotToGame(target)!);
      items.push(compound(clone));
      writeInventory(root, items);
      break;
    }
    case "clear":
      root.Inventory = listOf([]);
      break;
    case "give": {
      const id = normalizeItemId(op.itemId);
      const count = clamp(Math.round(op.count ?? 1), 1, 64);
      const target = op.slot ?? freePanelSlot(root);
      if (target === null) throw new ApiException(409, "inventory_full", "The inventory is full — clear a slot first");
      const gameSlot = panelSlotToGame(target);
      if (gameSlot === null) throw new ApiException(400, "invalid_slot", `Slot ${target} cannot hold an item`);
      const existing = findItem(root, target);
      if (existing) items.splice(existing.index, 1);
      items.push(compound(newItem(format, id, count, gameSlot)));
      writeInventory(root, items);
      break;
    }
    default:
      throw new ApiException(400, "invalid_op", "Unknown player data operation");
  }

  writeNbtFile(path, root);
  recordActivity({
    type: "player.data_edited",
    serverId,
    target: record?.username ?? uuid,
    actorName: actor,
    metadata: { op: op.op, ...(op.op === "give" ? { item: normalizeItemId(op.itemId), count: op.count ?? 1 } : {}) },
  });
  return readPlayerData(serverId, uuid);
}
