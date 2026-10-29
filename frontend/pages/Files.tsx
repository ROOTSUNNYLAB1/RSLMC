import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpFromLine, ChevronRight, Copy, Download, File, FileCode2, FileText, Folder, FolderPlus,
  HardDriveDownload, Pencil, Save, Search, Trash2, Upload, X, FolderInput, FilePlus2, Link2,
} from "lucide-react";
import type { ServerSummary } from "../../src/shared/types";
import { Banner, Button, Card, ConfirmDialog, EmptyState, Field, Input, Loading, Modal, PageHeader, Pill } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { useSession, useToast } from "../lib/app";
import { formatBytes, formatDateTime } from "../lib/format";

interface FileEntry {
  name: string; path: string; type: "file" | "directory" | "symlink"; size: number;
  modifiedAt: number; mode: string; editable: boolean;
}

export function FilesPage({ server }: { server: ServerSummary }) {
  const { can } = useSession();
  const toast = useToast();
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<FileEntry[] | null>(null);
  const [editor, setEditor] = useState<{ path: string; content: string; modifiedAt: number; dirty: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [newFile, setNewFile] = useState<string | null>(null);
  const [rename, setRename] = useState<{ path: string; value: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const editable = can("server.files");

  /** Download endpoints authenticate with the session cookie, so a plain link works — no popup. */
  const downloadUrl = (target: string) => `/api/servers/${server.id}/files/download?path=${encodeURIComponent(target)}`;

  const copyDownloadLink = async (target: string) => {
    const url = new URL(downloadUrl(target), window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Download link copied", "The link works while you are signed in to this panel.");
    } catch {
      // Clipboard API needs a secure context; fall back to a selectable prompt.
      window.prompt("Copy this download link:", url);
    }
  };

  const createFile = async () => {
    const name = (newFile ?? "").trim();
    if (!name) return;
    const target = path ? `${path}/${name}` : name;
    setBusy(true);
    try {
      const result = await api.put<{ size: number; modifiedAt: number }>(`/api/servers/${server.id}/files/content`, { path: target, content: "" });
      toast.success("File created", target);
      setNewFile(null);
      await load();
      setEditor({ path: target, content: "", modifiedAt: result.modifiedAt, dirty: false });
    } catch (err) {
      toast.fromError(err, "Could not create the file");
    } finally {
      setBusy(false);
    }
  };

  const load = async (target = path) => {
    setLoading(true);
    try {
      const result = await api.get<{ path: string; entries: FileEntry[]; parent: string | null }>(`/api/servers/${server.id}/files?path=${encodeURIComponent(target)}`);
      setEntries(result.entries);
      setPath(result.path);
      setError(null);
      setSelected(new Set());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(""); }, [server.id]);

  useEffect(() => {
    if (search.trim().length < 2) { setSearchResults(null); return; }
    const timer = setTimeout(() => {
      api.get<{ data: FileEntry[] }>(`/api/servers/${server.id}/files/search?q=${encodeURIComponent(search.trim())}`)
        .then((result) => setSearchResults(result.data))
        .catch(() => setSearchResults([]));
    }, 260);
    return () => clearTimeout(timer);
  }, [search, server.id]);

  const openEntry = async (entry: FileEntry) => {
    if (entry.type === "directory") { await load(entry.path); return; }
    if (!entry.editable) { toast.info("Binary file", "Download it or use a binary-safe tool — RSLMC only edits text files."); return; }
    try {
      const result = await api.get<{ path: string; content: string; modifiedAt: number }>(`/api/servers/${server.id}/files/content?path=${encodeURIComponent(entry.path)}`);
      setEditor({ path: result.path, content: result.content, modifiedAt: result.modifiedAt, dirty: false });
    } catch (err) {
      toast.fromError(err, "Could not open file");
    }
  };

  const save = async () => {
    if (!editor) return;
    setSaving(true);
    try {
      const saved = await api.put<{ notice?: string | null }>(`/api/servers/${server.id}/files/content`, {
        path: editor.path, content: editor.content, expectedModifiedAt: editor.modifiedAt,
      });
      // The API tells us when it had to keep RSLMC-managed keys (port/address) instead of saving them.
      if (saved?.notice) toast.warn("File saved with changes", saved.notice);
      else toast.success("File saved", editor.path);
      setEditor(null);
      await load();
    } catch (err) {
      toast.fromError(err, "Could not save the file");
    } finally {
      setSaving(false);
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    for (const file of Array.from(files)) {
      setUploadProgress(`Uploading ${file.name}…`);
      const form = new FormData();
      form.set("path", path);
      form.set("file", file);
      form.set("overwrite", "false");
      try {
        await api.upload(`/api/servers/${server.id}/files/upload`, form);
      } catch (err) {
        toast.fromError(err, `Upload failed for ${file.name}`);
      }
    }
    setUploadProgress(null);
    setBusy(false);
    await load();
  };

  const remove = async (paths: string[]) => {
    setBusy(true);
    try {
      const result = await api.post<{ deleted: string[] }>(`/api/servers/${server.id}/files/delete`, { paths });
      toast.success("Deleted", `${result.deleted.length} item(s) removed.`);
      setConfirmDelete(null);
      await load();
    } catch (err) {
      toast.fromError(err, "Could not delete");
    } finally {
      setBusy(false);
    }
  };

  const breadcrumbSegments = useMemo(() => path.split("/").filter(Boolean), [path]);
  const list = searchResults ?? entries;

  return (
    <>
      <PageHeader
        title="Files"
        icon={<FileCode2 size={19} />}
        subtitle={<>File manager for <strong style={{ color: "var(--text)" }}>{server.name}</strong> · confined to this server's directory</>}
        actions={
          <>
            <input ref={uploadRef} type="file" multiple hidden onChange={(event) => void upload(event.target.files)} />
            <Button icon={<Upload size={14} />} onClick={() => uploadRef.current?.click()} disabled={!editable || busy}>Upload</Button>
            <Button icon={<FilePlus2 size={14} />} onClick={() => setNewFile("")} disabled={!editable}>New file</Button>
            <Button icon={<FolderPlus size={14} />} onClick={() => setNewFolder("")} disabled={!editable}>New folder</Button>
          </>
        }
      />

      {error ? <Banner tone="error" title="Could not read this directory">{error}</Banner> : null}
      {uploadProgress ? <Banner tone="info" title="Upload in progress">{uploadProgress}</Banner> : null}

      <Card bodyClass="tight">
        <div className="file-toolbar">
          <Button size="sm" variant="ghost" icon={<ArrowUpFromLine size={13} />} onClick={() => {
            const parent = breadcrumbSegments.slice(0, -1).join("/");
            void load(parent);
          }} disabled={path === ""}>
            Up
          </Button>
          <div className="breadcrumb-path">
            <button onClick={() => void load("")}>root</button>
            {breadcrumbSegments.map((segment, index) => (
              <span key={index} className="row" style={{ gap: 3 }}>
                <ChevronRight size={10} className="faint" />
                <button onClick={() => void load(breadcrumbSegments.slice(0, index + 1).join("/"))}>{segment}</button>
              </span>
            ))}
          </div>
          <div className="spacer" />
          <div className="row" style={{ gap: 6 }}>
            <Search size={12} className="faint" />
            <input className="input" style={{ height: 26, width: 168 }} placeholder="Search this server…" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          {selected.size > 0 ? (
            <>
              <span className="text-xs faint">{selected.size} selected</span>
              <Button size="sm" variant="ghost" icon={<Copy size={12} />} onClick={() => setRename({ path: [...selected][0]!, value: [...selected][0]! + "-copy" })} disabled={selected.size !== 1}>Copy</Button>
              <Button size="sm" variant="ghost" icon={<FolderInput size={12} />} onClick={() => setRename({ path: [...selected][0]!, value: [...selected][0]! })} disabled={selected.size !== 1}>Move / rename</Button>
              <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={() => setConfirmDelete([...selected])}>Delete</Button>
            </>
          ) : (
            <a
              className="btn btn-sm btn-ghost"
              href={`/api/servers/${server.id}/files/archive?path=${encodeURIComponent(path)}`}
              download
              title="Download this folder as a .tar.gz archive"
            >
              <HardDriveDownload size={12} /> Download as archive
            </a>
          )}
        </div>

        {loading ? <Loading label="Reading directory…" /> : list.length === 0 ? (
          <EmptyState
            icon={<Folder size={17} />}
            title={searchResults ? "No matching files" : "This folder is empty"}
            description={searchResults ? "Try a different search term." : "Upload files, or use New file / New folder to start from scratch."}
          />
        ) : (
          <div>
            <div className="file-row" style={{ background: "#0c0c0e", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-faint)" }}>
              <span />
              <span>Name</span>
              <span className="fmeta">Size</span>
              <span className="fmeta">Modified</span>
              <span />
            </div>
            {list.map((entry) => (
              <div key={entry.path} className={`file-row ${selected.has(entry.path) ? "selected" : ""}`}>
                <input
                  type="checkbox"
                  checked={selected.has(entry.path)}
                  onChange={(event) => {
                    const next = new Set(selected);
                    if (event.target.checked) next.add(entry.path); else next.delete(entry.path);
                    setSelected(next);
                  }}
                  aria-label={`Select ${entry.name}`}
                />
                <div className="fname" onClick={() => void openEntry(entry)}>
                  {entry.type === "directory" ? <Folder size={14} color="var(--blue)" /> : entry.editable ? <FileText size={14} color="var(--text-faint)" /> : <File size={14} color="var(--text-faint)" />}
                  <span>{entry.name}{entry.type === "symlink" ? <Pill tone="amber">symlink</Pill> : null}</span>
                </div>
                <span className="fmeta">{entry.type === "directory" ? "—" : formatBytes(entry.size)}</span>
                <span className="fmeta">{formatDateTime(entry.modifiedAt)}</span>
                <span className="row" style={{ gap: 2, justifyContent: "flex-end" }}>
                  {entry.type === "file" ? (
                    <>
                      <a
                        className="btn btn-sm btn-ghost btn-icon"
                        href={downloadUrl(entry.path)}
                        download={entry.name}
                        title={`Download ${entry.name}`}
                        aria-label={`Download ${entry.name}`}
                      >
                        <Download size={12} />
                      </a>
                      <button
                        className="btn btn-sm btn-ghost btn-icon"
                        title="Copy download link"
                        aria-label={`Copy download link for ${entry.name}`}
                        onClick={() => void copyDownloadLink(entry.path)}
                      >
                        <Link2 size={12} />
                      </button>
                    </>
                  ) : null}
                  {entry.editable ? (
                    <button className="btn btn-sm btn-ghost btn-icon" title="Edit" aria-label={`Edit ${entry.name}`} onClick={() => void openEntry(entry)}>
                      <Pencil size={12} />
                    </button>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal
        open={editor !== null}
        onClose={() => {
          if (editor?.dirty && !window.confirm("You have unsaved changes. Close anyway?")) return;
          setEditor(null);
        }}
        title={<span className="row" style={{ gap: 8 }}><FileCode2 size={15} /> <span className="mono text-sm">{editor?.path}</span></span>}
        size="wide"
        footer={
          <>
            <span className="text-xs faint" style={{ marginRight: "auto" }}>{editor?.dirty ? "Unsaved changes" : "Saved"}</span>
            <Button onClick={() => setEditor(null)}>Close</Button>
            <Button variant="primary" icon={<Save size={13} />} loading={saving} onClick={() => void save()} disabled={!editor?.dirty}>Save</Button>
          </>
        }
      >
        {editor ? (
          <div className="stack" style={{ gap: 8 }}>
            {editor.path === "server.properties" ? (
              <Banner tone="info" title="Use the Properties page">
                server.properties has a typed editor with validation and restart hints. Editing it here is possible but not validated.
              </Banner>
            ) : null}
            <textarea
              className="file-editor"
              value={editor.content}
              spellCheck={false}
              onChange={(event) => setEditor({ ...editor, content: event.target.value, dirty: true })}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "s") {
                  event.preventDefault();
                  void save();
                }
              }}
            />
            <div className="row text-xs faint">
              <span>{editor.content.split("\n").length} lines · {formatBytes(new Blob([editor.content]).size)}</span>
              <span className="spacer" />
              <span><span className="kbd">Ctrl</span> + <span className="kbd">S</span> to save</span>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={newFile !== null}
        onClose={() => setNewFile(null)}
        title="Create file"
        size="narrow"
        footer={<>
          <Button onClick={() => setNewFile(null)}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void createFile()}>Create &amp; edit</Button>
        </>}
      >
        <Field label="File name" hint={path ? `Created inside ${path}/ — the editor opens right after creation.` : "Created in the server root — the editor opens right after creation."}>
          <Input
            value={newFile ?? ""}
            onChange={(event) => setNewFile(event.target.value)}
            placeholder="notes.txt"
            autoFocus
            onKeyDown={(event) => { if (event.key === "Enter") void createFile(); }}
          />
        </Field>
      </Modal>

      <Modal
        open={newFolder !== null}
        onClose={() => setNewFolder(null)}
        title="Create folder"
        size="narrow"
        footer={<>
          <Button onClick={() => setNewFolder(null)}>Cancel</Button>
          <Button
            variant="primary"
            onClick={async () => {
              const target = path ? `${path}/${newFolder}` : (newFolder ?? "");
              try {
                await api.post(`/api/servers/${server.id}/files/mkdir`, { path: target });
                toast.success("Folder created", target);
                setNewFolder(null);
                await load();
              } catch (err) { toast.fromError(err, "Could not create folder"); }
            }}
          >
            Create
          </Button>
        </>}
      >
        <Field label="Folder name">
          <Input value={newFolder ?? ""} onChange={(event) => setNewFolder(event.target.value)} placeholder="new-folder" autoFocus />
        </Field>
      </Modal>

      <Modal
        open={rename !== null}
        onClose={() => setRename(null)}
        title="Rename or move"
        size="narrow"
        footer={<>
          <Button onClick={() => setRename(null)}>Cancel</Button>
          <Button
            variant="primary"
            onClick={async () => {
              if (!rename) return;
              try {
                await api.post(`/api/servers/${server.id}/files/rename`, { from: rename.path, to: rename.value });
                toast.success("Moved", `${rename.path} → ${rename.value}`);
                setRename(null);
                await load();
              } catch (err) { toast.fromError(err, "Could not rename"); }
            }}
          >
            Apply
          </Button>
        </>}
      >
        <Field label="New path" hint="Relative to the server root. Parent folders are created automatically.">
          <Input value={rename?.value ?? ""} onChange={(event) => setRename(rename ? { ...rename, value: event.target.value } : null)} autoFocus />
        </Field>
      </Modal>

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete selected items?"
        confirmLabel="Delete"
        message={<>{confirmDelete?.length} item(s) will be removed from the server directory. This cannot be undone — create a backup first if the data matters.</>}
        onClose={() => setConfirmDelete(null)}
        busy={busy}
        onConfirm={() => void remove(confirmDelete ?? [])}
      />
    </>
  );
}
