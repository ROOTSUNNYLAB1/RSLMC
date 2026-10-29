import { useEffect, useMemo, useRef, useState } from "react";
import {
  Backpack, Check, Droplet, Heart, Loader2, Package, PackagePlus, Shield, Sparkles, Trash2, Zap,
} from "lucide-react";
import { Banner, Button, Input, Modal, Pill, Select } from "./ui";
import { api, errorMessage } from "../lib/api";
import { useToast } from "../lib/app";

/**
 * Player inspector: reads and edits Minecraft's own `playerdata/<uuid>.dat`.
 *
 * Everything shown here comes from that file — if a value or the file itself is missing the UI
 * says so instead of inventing numbers. Edits are refused while the player is online, because the
 * running server holds their data in memory and writes it back on disconnect.
 */

interface ItemStack {
  slot: number;
  id: string;
  count: number;
  hasNbt: boolean;
  displayName: string | null;
}

interface PlayerData {
  uuid: string;
  username: string;
  online: boolean;
  serverRunning: boolean;
  path: string | null;
  fileModifiedAt: number | null;
  canEdit: boolean;
  blockedReason: string | null;
  blockedMessage: string | null;
  warning: string | null;
  vitals: {
    health: number; maxHealth: number; absorption: number; food: number; saturation: number;
    exhaustion: number; xpLevel: number; xpProgress: number; xpTotal: number; gamemode: number;
    dimension: string | null; position: { x: number; y: number; z: number } | null; selectedSlot: number;
  };
  inventory: ItemStack[];
  itemFormat: "modern" | "legacy";
}

const HOTBAR = Array.from({ length: 9 }, (_, index) => index);
const MAIN = Array.from({ length: 27 }, (_, index) => index + 9);
const ARMOR = [
  { slot: 36, label: "Helm" },
  { slot: 37, label: "Chest" },
  { slot: 38, label: "Legs" },
  { slot: 39, label: "Boots" },
];
const OFFHAND = { slot: 40, label: "Off" };
const GAMEMODES = [
  { value: 0, label: "Survival" },
  { value: 1, label: "Creative" },
  { value: 2, label: "Adventure" },
  { value: 3, label: "Spectator" },
];

/** Stable pastel colour per item id — a real texture pack is not available, so this is a label. */
function itemColor(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) % 360;
  return `hsl(${hash} 42% 26%)`;
}

function prettyName(id: string): string {
  const path = id.includes(":") ? id.split(":")[1]! : id;
  return path.split("_").filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function VitalsBar({ value, max, color, tone }: { value: number; max: number; color: string; tone?: string }) {
  const percent = Math.max(0, Math.min(100, (value / Math.max(1, max)) * 100));
  return (
    <div className="vitals-bar" title={`${value} / ${max}`}>
      <span style={{ width: `${percent}%`, background: color, opacity: tone === "muted" ? 0.55 : 1 }} />
    </div>
  );
}

export function PlayerInspector({ open, onClose, serverId, uuid, username, onChanged }: {
  open: boolean;
  onClose: () => void;
  serverId: number;
  uuid: string;
  username: string;
  onChanged?: () => void;
}) {
  const toast = useToast();
  const [data, setData] = useState<PlayerData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [giveItem, setGiveItem] = useState("");
  const [giveCount, setGiveCount] = useState(1);
  const [draft, setDraft] = useState<{ health: number; food: number; saturation: number; xpLevel: number; gamemode: number } | null>(null);
  const [countDraft, setCountDraft] = useState(1);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const snapshot = (incoming: PlayerData) => {
    if (!mounted.current) return;
    setData(incoming);
    setDraft({
      health: incoming.vitals.health,
      food: incoming.vitals.food,
      saturation: incoming.vitals.saturation,
      xpLevel: incoming.vitals.xpLevel,
      gamemode: incoming.vitals.gamemode,
    });
  };

  const load = async () => {
    setLoading(true);
    try {
      const result = await api.get<PlayerData>(`/api/servers/${serverId}/players/${uuid}/data`);
      snapshot(result);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setSelected(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, serverId, uuid]);

  const runOp = async (op: Record<string, unknown>, label: string) => {
    setBusy(label);
    try {
      const result = await api.post<PlayerData>(`/api/servers/${serverId}/players/${uuid}/data`, op);
      snapshot(result);
      onChanged?.();
      toast.success(label, `${username}'s saved data was updated.`);
    } catch (err) {
      toast.fromError(err, `${label} failed`);
    } finally {
      setBusy(null);
    }
  };

  const itemAt = useMemo(() => {
    const map = new Map<number, ItemStack>();
    for (const item of data?.inventory ?? []) map.set(item.slot, item);
    return map;
  }, [data]);

  const selectedItem = selected === null ? null : itemAt.get(selected) ?? null;

  useEffect(() => {
    if (selectedItem) setCountDraft(selectedItem.count);
    else if (selected !== null) setCountDraft(1);
  }, [selected, selectedItem?.slot, selectedItem?.count]);

  const slotTile = (slot: number, label?: string) => {
    const item = itemAt.get(slot);
    const isSelected = selected === slot;
    return (
      <div
        key={slot}
        data-slot={slot}
        className={`inv-slot ${item ? "filled" : "empty"} ${isSelected ? "selected" : ""}`}
        draggable={Boolean(item) && Boolean(data?.canEdit)}
        onDragStart={() => setDragFrom(slot)}
        onDragEnd={() => setDragFrom(null)}
        onDragOver={(event) => { if (data?.canEdit) event.preventDefault(); }}
        onDrop={(event) => {
          event.preventDefault();
          if (dragFrom === null || dragFrom === slot) return;
          void runOp({ op: "move", from: dragFrom, to: slot }, "Item moved");
          setDragFrom(null);
        }}
        onClick={() => setSelected(slot)}
        title={item ? `${prettyName(item.id)} × ${item.count}${item.hasNbt ? " (has NBT data)" : ""}` : label ?? `Slot ${slot}`}
      >
        {item ? (
          <>
            <span className="inv-item-swatch" style={{ background: itemColor(item.id) }}>
              {prettyName(item.id).slice(0, 2).toUpperCase()}
            </span>
            <span className="inv-item-name">{prettyName(item.id)}</span>
            {item.count > 1 ? <span className="inv-item-count">{item.count}</span> : null}
            {item.hasNbt ? <span className="inv-item-nbt" aria-hidden /> : null}
          </>
        ) : (
          <span className="inv-slot-empty">{label ?? ""}</span>
        )}
      </div>
    );
  };

  const vitals = data?.vitals;
  const dirty = Boolean(draft && vitals && (
    draft.health !== vitals.health || draft.food !== vitals.food ||
    draft.saturation !== vitals.saturation || draft.xpLevel !== vitals.xpLevel || draft.gamemode !== vitals.gamemode
  ));

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={
        <span className="row" style={{ gap: 8 }}>
          <Backpack size={15} />
          <span>{username}</span>
          {data?.online ? <Pill tone="green">online</Pill> : <Pill tone="neutral">offline</Pill>}
          {data && !data.canEdit ? <Pill tone="amber">read-only</Pill> : null}
        </span>
      }
      footer={
        <>
          <span className="text-xs faint" style={{ marginRight: "auto" }}>
            {data?.path ? `source: ${data.path.split("/").slice(-3).join("/")}` : "no saved player data"}
            {data?.fileModifiedAt ? ` · updated ${new Date(data.fileModifiedAt).toLocaleString()}` : ""}
          </span>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            icon={<Check size={13} />}
            disabled={!dirty || !data?.canEdit}
            loading={busy === "Vitals saved"}
            onClick={() => draft && void runOp({ op: "vitals", ...draft }, "Vitals saved")}
          >
            Save vitals
          </Button>
        </>
      }
    >
      {loading && !data ? (
        <div className="row" style={{ gap: 8, padding: 24, justifyContent: "center" }}><Loader2 size={14} className="spin" /> Reading player data…</div>
      ) : error ? (
        <Banner tone="error" title="Could not read this player">{error}</Banner>
      ) : data ? (
        <div className="player-inspector">
          {data.blockedMessage ? <Banner tone="warning" title="Editing is locked for this player">{data.blockedMessage}</Banner> : null}
          {data.warning ? <Banner tone="info" title="Server is running">{data.warning}</Banner> : null}
          {data.blockedReason === "no_data" ? null : (
            <>
              <section className="inspector-section">
                <div className="inspector-head">
                  <span className="card-title"><Heart size={11} /> Vitals</span>
                  <span className="spacer" />
                  <Button size="sm" variant="ghost" icon={<Heart size={12} />} disabled={!data.canEdit || busy !== null} onClick={() => void runOp({ op: "heal" }, "Player healed")}>Heal</Button>
                  <Button size="sm" variant="ghost" icon={<Droplet size={12} />} disabled={!data.canEdit || busy !== null} onClick={() => void runOp({ op: "feed" }, "Hunger filled")}>Feed</Button>
                  <Button size="sm" variant="ghost" icon={<Sparkles size={12} />} disabled={!data.canEdit || busy !== null} onClick={() => void runOp({ op: "heal" }, "Player healed").then(() => runOp({ op: "feed" }, "Hunger filled"))}>Heal + feed</Button>
                </div>

                <div className="vitals-grid">
                  <div className="vital">
                    <div className="vital-top">
                      <span><Heart size={11} color="#ff6b6b" /> Health</span>
                      <span className="mono">{vitals!.health.toFixed(1)} / {vitals!.maxHealth}</span>
                    </div>
                    <VitalsBar value={vitals!.health} max={vitals!.maxHealth} color="#ff6b6b" />
                    <input
                      className="input" type="number" min={0} max={Math.max(20, vitals!.maxHealth)} step={0.5}
                      value={draft?.health ?? 0}
                      disabled={!data.canEdit}
                      onChange={(event) => setDraft({ ...draft!, health: Number(event.target.value) })}
                    />
                  </div>
                  <div className="vital">
                    <div className="vital-top">
                      <span><Droplet size={11} color="#f0b429" /> Hunger</span>
                      <span className="mono">{vitals!.food} / 20</span>
                    </div>
                    <VitalsBar value={vitals!.food} max={20} color="#f0b429" />
                    <input
                      className="input" type="number" min={0} max={20} step={1}
                      value={draft?.food ?? 0}
                      disabled={!data.canEdit}
                      onChange={(event) => setDraft({ ...draft!, food: Number(event.target.value) })}
                    />
                  </div>
                  <div className="vital">
                    <div className="vital-top">
                      <span><Zap size={11} color="#5ad18a" /> Saturation</span>
                      <span className="mono">{vitals!.saturation.toFixed(1)} / 20</span>
                    </div>
                    <VitalsBar value={vitals!.saturation} max={20} color="#5ad18a" />
                    <input
                      className="input" type="number" min={0} max={20} step={0.5}
                      value={draft?.saturation ?? 0}
                      disabled={!data.canEdit}
                      onChange={(event) => setDraft({ ...draft!, saturation: Number(event.target.value) })}
                    />
                  </div>
                  <div className="vital">
                    <div className="vital-top">
                      <span><Sparkles size={11} color="#8ab4ff" /> Experience</span>
                      <span className="mono">lvl {vitals!.xpLevel}</span>
                    </div>
                    <VitalsBar value={vitals!.xpProgress * 100} max={100} color="#8ab4ff" />
                    <input
                      className="input" type="number" min={0} step={1}
                      value={draft?.xpLevel ?? 0}
                      disabled={!data.canEdit}
                      onChange={(event) => setDraft({ ...draft!, xpLevel: Number(event.target.value) })}
                    />
                  </div>
                </div>

                <div className="row" style={{ gap: 14, marginTop: 10, flexWrap: "wrap" }}>
                  <label className="row text-xs faint" style={{ gap: 6 }}>
                    Gamemode
                    <Select
                      value={draft?.gamemode ?? 0}
                      disabled={!data.canEdit}
                      onChange={(event) => setDraft({ ...draft!, gamemode: Number(event.target.value) })}
                      style={{ height: 28, width: 130 }}
                    >
                      {GAMEMODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
                    </Select>
                  </label>
                  <span className="text-xs faint">
                    {vitals!.dimension ? vitals!.dimension.replace("minecraft:", "") : "dimension unknown"}
                    {vitals!.position ? ` · ${vitals!.position.x.toFixed(0)}, ${vitals!.position.y.toFixed(0)}, ${vitals!.position.z.toFixed(0)}` : ""}
                  </span>
                  <span className="spacer" />
                  <span className="text-xs faint">hotbar slot {vitals!.selectedSlot + 1} · item format {data.itemFormat}</span>
                </div>
              </section>

              <section className="inspector-section">
                <div className="inspector-head">
                  <span className="card-title"><Package size={11} /> Inventory</span>
                  <span className="spacer" />
                  <Button size="sm" variant="danger" icon={<Trash2 size={12} />} disabled={!data.canEdit || data.inventory.length === 0}
                    onClick={() => void runOp({ op: "clear" }, "Inventory cleared")}>Clear all</Button>
                </div>

                <div className="inv-layout">
                  <div className="inv-column">
                    <div className="inv-block">
                      <span className="inv-label">Inventory · 27 slots</span>
                      <div className="inv-grid">{MAIN.map((slot) => slotTile(slot))}</div>
                    </div>
                    <div className="inv-block">
                      <span className="inv-label">Hotbar · 9 slots</span>
                      <div className="inv-grid">{HOTBAR.map((slot) => slotTile(slot))}</div>
                    </div>
                  </div>

                  <div className="inv-column side">
                    <div className="inv-block">
                      <span className="inv-label"><Shield size={10} /> Armour &amp; offhand</span>
                      <div className="inv-gear">
                        <div className="inv-grid armor">{ARMOR.map((entry) => slotTile(entry.slot, entry.label))}</div>
                        <div className="inv-grid armor">{slotTile(OFFHAND.slot, OFFHAND.label)}</div>
                      </div>
                    </div>

                    <div className="inv-block">
                      <span className="inv-label"><PackagePlus size={10} /> Selected slot</span>
                      {selected === null ? (
                        <p className="text-xs faint" style={{ margin: 0, lineHeight: 1.6 }}>
                          Click a slot to inspect it, or drag one slot onto another to move or swap items.
                        </p>
                      ) : selectedItem ? (
                        <div className="selected-panel">
                          <div className="text-xs">{prettyName(selectedItem.id)}<span className="faint"> · slot {selected}</span></div>
                          <div className="row" style={{ gap: 6 }}>
                            <Input
                              type="number" min={0} max={64} value={countDraft} style={{ width: 68, height: 27 }}
                              disabled={!data.canEdit}
                              onChange={(event) => setCountDraft(Number(event.target.value))}
                            />
                            <Button size="sm" disabled={!data.canEdit || busy !== null}
                              onClick={() => void runOp({ op: "count", slot: selected, count: countDraft }, "Count updated")}>Set count</Button>
                          </div>
                          <div className="row" style={{ gap: 6 }}>
                            <Button size="sm" variant="ghost" disabled={!data.canEdit || busy !== null}
                              onClick={() => void runOp({ op: "duplicate", slot: selected }, "Item duplicated")}>Duplicate</Button>
                            <Button size="sm" variant="danger" icon={<Trash2 size={12} />} disabled={!data.canEdit || busy !== null}
                              onClick={() => void runOp({ op: "remove", slot: selected }, "Item removed")}>Delete</Button>
                          </div>
                        </div>
                      ) : (
                        <div className="selected-panel">
                          <div className="text-xs faint">Slot {selected} is empty.</div>
                          <Button size="sm" icon={<PackagePlus size={12} />} disabled={!data.canEdit || !giveItem.trim() || busy !== null}
                            onClick={() => void runOp({ op: "give", itemId: giveItem.trim(), count: giveCount, slot: selected }, "Item given")}>
                            Put item here
                          </Button>
                        </div>
                      )}
                    </div>

                    <div className="inv-block">
                      <span className="inv-label">Give item</span>
                      <div className="give-panel">
                        <Input
                          value={giveItem}
                          onChange={(event) => setGiveItem(event.target.value)}
                          placeholder="minecraft:diamond"
                          disabled={!data.canEdit}
                          list="rslmc-item-suggestions"
                        />
                        <div className="row" style={{ gap: 6 }}>
                          <Input type="number" min={1} max={64} value={giveCount} style={{ width: 66 }} disabled={!data.canEdit}
                            onChange={(event) => setGiveCount(Number(event.target.value))} />
                          <Button size="sm" icon={<PackagePlus size={12} />} disabled={!data.canEdit || !giveItem.trim() || busy !== null}
                            onClick={() => void runOp({ op: "give", itemId: giveItem.trim(), count: giveCount }, "Item given")}>
                            Give
                          </Button>
                        </div>
                        <span className="text-2xs faint">Any item id — diamond, minecraft:golden_apple, oak_log…</span>
                        <datalist id="rslmc-item-suggestions">
                          {["diamond", "netherite_ingot", "golden_apple", "enchanted_golden_apple", "iron_sword", "diamond_pickaxe", "elytra", "totem_of_undying", "oak_log", "cobblestone", "torch", "bread", "cooked_beef", "ender_pearl", "shulker_box"]
                            .map((id) => <option key={id} value={`minecraft:${id}`} />)}
                        </datalist>
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            </>
          )}
        </div>
      ) : null}
    </Modal>
  );
}
