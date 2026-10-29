import { useEffect, useMemo, useState } from "react";
import { FileCode2, RotateCcw, Save, Search, Info } from "lucide-react";
import type { ServerSummary } from "../../src/shared/types";
import { Banner, Button, Card, Field, Input, Loading, PageHeader, Pill, Select, Toggle } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { useSession, useToast } from "../lib/app";
import { ConfirmDialog } from "../components/ui";

interface PropertySpec {
  key: string; label: string; type: "string" | "boolean" | "integer" | "enum";
  default?: string; description: string; options?: string[]; min?: number; max?: number;
  requiresRestart: boolean; group: string; secret?: boolean;
}

const GROUPS = ["General", "Gameplay", "World", "Network", "Security", "Resource pack", "Advanced"];

export function PropertiesPage({ server }: { server: ServerSummary }) {
  const { can } = useSession();
  const toast = useToast();
  const [specs, setSpecs] = useState<PropertySpec[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [original, setOriginal] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [restartPrompt, setRestartPrompt] = useState(false);
  const [filter, setFilter] = useState("");
  const [group, setGroup] = useState<string>("General");
  const [unknown, setUnknown] = useState<string[]>([]);

  const load = async () => {
    try {
      const result = await api.get<{ values: Record<string, string>; specs: PropertySpec[]; exists: boolean; mcVersion: string }>(`/api/servers/${server.id}/properties`);
      setSpecs(result.specs);
      setValues(result.values);
      setOriginal(result.values);
      const known = new Set(result.specs.map((spec) => spec.key));
      setUnknown(Object.keys(result.values).filter((key) => !known.has(key)));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [server.id]);

  const dirty = useMemo(() => Object.keys(values).some((key) => values[key] !== original[key]) || unknown.some((key) => values[key] !== original[key]), [values, original, unknown]);

  const visibleSpecs = useMemo(() => specs.filter((spec) => {
    if (filter) return spec.key.includes(filter.toLowerCase()) || spec.label.toLowerCase().includes(filter.toLowerCase());
    return spec.group === group;
  }), [specs, group, filter]);

  const save = async () => {
    setSaving(true);
    try {
      const result = await api.put<{ message: string; restartRequired: boolean; changed: string[]; reserved: string[] }>(
        `/api/servers/${server.id}/properties`,
        { values },
      );
      toast.success("Properties saved", result.message);
      await load();
      if (result.restartRequired) setRestartPrompt(true);
    } catch (err) {
      toast.fromError(err, "Could not save properties");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading label="Reading server.properties…" minHeight={280} />;

  return (
    <>
      <PageHeader
        title="Properties"
        icon={<FileCode2 size={19} />}
        subtitle={<>Typed editor for <span className="mono">server.properties</span> · Minecraft {server.mcVersion}</>}
        actions={
          <>
            <Button icon={<RotateCcw size={14} />} onClick={() => setValues(original)} disabled={!dirty}>Discard</Button>
            <Button variant="primary" icon={<Save size={14} />} loading={saving} onClick={() => void save()} disabled={!dirty || !can("server.files")}>
              Save changes
            </Button>
          </>
        }
      />

      {error ? <Banner tone="error" title="Could not read server.properties">{error}</Banner> : null}
      {dirty ? <Banner tone="info" title="Unsaved changes">Values are only written when you press Save.</Banner> : null}

      <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <div className="tabs">
          {GROUPS.map((entry) => (
            <button key={entry} className={`tab ${group === entry && !filter ? "active" : ""}`} onClick={() => { setGroup(entry); setFilter(""); }}>{entry}</button>
          ))}
        </div>
        <div className="spacer" />
        <div className="row" style={{ gap: 6 }}>
          <Search size={12} className="faint" />
          <input className="input" style={{ height: 27, width: 190 }} placeholder="Filter properties…" value={filter} onChange={(event) => setFilter(event.target.value)} />
        </div>
      </div>

      <Card title={filter ? `Matching properties (${visibleSpecs.length})` : `${group} settings`} icon={<FileCode2 size={12} />}>
        {visibleSpecs.length === 0 ? (
          <div className="empty" style={{ padding: 24 }}><p>No properties match this filter.</p></div>
        ) : (
          <div className="form-grid">
            {visibleSpecs.map((spec) => {
              const value = values[spec.key] ?? "";
              const isReserved = ["server-port", "server-ip", "rcon.password"].includes(spec.key);
              const changed = value !== original[spec.key];
              return (
                <Field
                  key={spec.key}
                  className={spec.type === "string" && spec.key === "motd" ? "span-2" : ""}
                  label={
                    <span className="row" style={{ gap: 6 }}>
                      {spec.label}
                      {spec.requiresRestart ? <Pill tone="amber">restart</Pill> : null}
                      {changed ? <Pill tone="blue">unsaved</Pill> : null}
                      {isReserved ? <Pill tone="neutral">managed by RSLMC</Pill> : null}
                    </span>
                  }
                  hint={spec.description}
                >
                  {spec.type === "boolean" ? (
                    <Toggle
                      checked={value === "true"}
                      disabled={isReserved || !can("server.files")}
                      onChange={(next) => setValues({ ...values, [spec.key]: next ? "true" : "false" })}
                      label={<span className="mono text-xs">{spec.key}</span>}
                    />
                  ) : spec.type === "enum" ? (
                    <Select
                      value={value}
                      disabled={isReserved}
                      onChange={(event) => setValues({ ...values, [spec.key]: event.target.value })}
                    >
                      {/* Custom generators (`terralith:overworld`) and unusual values must stay selectable
                          instead of silently switching to the first option. */}
                      {!spec.options?.includes(value) && value ? <option value={value}>{`${value} (custom)`}</option> : null}
                      {spec.options?.map((option) => <option key={option} value={option}>{option}</option>)}
                    </Select>
                  ) : (
                    <Input
                      type={spec.type === "integer" ? "number" : "text"}
                      value={spec.secret && spec.key === "rcon.password" ? "" : value}
                      placeholder={spec.secret ? "Managed in Networking" : spec.default}
                      min={spec.min}
                      max={spec.max}
                      disabled={isReserved || (spec.secret && isReserved)}
                      onChange={(event) => setValues({ ...values, [spec.key]: event.target.value })}
                    />
                  )}
                </Field>
              );
            })}
          </div>
        )}
      </Card>

      {unknown.length > 0 ? (
        <Card title={`Version-specific properties (${unknown.length})`} icon={<Info size={12} />} bodyClass="tight" header>
          <div style={{ padding: "10px 14px" }} className="text-xs faint">
            These keys exist in your file but are not in RSLMC's known-property catalogue. They are preserved exactly as-is when saving.
          </div>
          <details>
            <summary style={{ cursor: "pointer", padding: "10px 14px", borderTop: "1px solid var(--border)" }} className="text-xs">
              Show {unknown.length} keys
            </summary>
            <div className="info-list">
              {unknown.map((key) => (
                <div className="info-row" key={key}>
                  <span className="k mono text-xs">{key}</span>
                  <span className="v mono text-xs">{values[key]}</span>
                </div>
              ))}
            </div>
          </details>
        </Card>
      ) : null}

      <ConfirmDialog
        open={restartPrompt}
        title="Restart required"
        tone="primary"
        confirmLabel="Restart now"
        message="Some of the properties you changed only take effect after a restart. Restart the server now?"
        onClose={() => setRestartPrompt(false)}
        onConfirm={async () => {
          try {
            await api.post(`/api/servers/${server.id}/power`, { action: "restart" });
            toast.success("Restart requested");
          } catch (err) {
            toast.fromError(err, "Restart failed");
          }
          setRestartPrompt(false);
        }}
      />
    </>
  );
}
