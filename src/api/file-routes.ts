import { Router, json, badRequest } from "../shared/http";
import { requireServerAccess } from "../auth";
import {
  listDirectory, readFile, writeFile, createDirectory, renameEntry, copyEntry, deleteEntries,
  saveUpload, createArchive, extractArchive, searchFiles, fileStream,
} from "../services/files";
import { recordActivity } from "../services/audit";
import { PATHS } from "../shared/config";
import { sanitizeRelative } from "../security/paths";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";

export function registerFileRoutes(api: Router): void {
  api.get("/api/servers/:id/files", async (ctx) => {
    const id = Number(ctx.params.id);
    requireServerAccess(ctx.user, id, "server.files");
    const path = ctx.query("path") ?? "";
    const listing = listDirectory(id, path);
    return json(listing);
  });

  api.get("/api/servers/:id/files/search", async (ctx) => {
    const id = Number(ctx.params.id);
    requireServerAccess(ctx.user, id, "server.files");
    const query = ctx.query("q") ?? "";
    if (query.length < 2) throw badRequest("Search requires at least 2 characters");
    return json({ data: searchFiles(id, query) });
  });

  api.get("/api/servers/:id/files/content", async (ctx) => {
    const id = Number(ctx.params.id);
    requireServerAccess(ctx.user, id, "server.files");
    const path = ctx.query("path");
    if (!path) throw badRequest("path is required");
    return json(readFile(id, path));
  });

  api.put("/api/servers/:id/files/content", async (ctx) => {
    const id = Number(ctx.params.id);
    requireServerAccess(ctx.user, id, "server.files");
    const body = await ctx.body<{ path?: string; content?: string; expectedModifiedAt?: number }>();
    if (!body.path) throw badRequest("path is required");
    if (typeof body.content !== "string") throw badRequest("content must be a string");
    const result = writeFile(id, body.path, body.content, body.expectedModifiedAt);
    recordActivity({
      type: "file.edited", serverId: id, target: body.path, actorName: ctx.user!.username,
      metadata: { size: result.size, managedKeysKept: result.managedKeysKept },
    });
    return json({
      ...result,
      // Honest feedback instead of a silent rewrite: RSLMC keeps the allocated port/address.
      notice: result.managedKeysKept.length > 0
        ? `Saved. ${result.managedKeysKept.join(" and ")} kept at the values RSLMC allocated — change them in Networking → Allocations.`
        : null,
    });
  });

  api.post("/api/servers/:id/files/mkdir", async (ctx) => {
    const id = Number(ctx.params.id);
    requireServerAccess(ctx.user, id, "server.files");
    const body = await ctx.body<{ path?: string }>();
    if (!body.path) throw badRequest("path is required");
    createDirectory(id, body.path);
    recordActivity({ type: "file.created", serverId: id, target: body.path, actorName: ctx.user!.username });
    return json({ ok: true }, { status: 201 });
  });

  api.post("/api/servers/:id/files/rename", async (ctx) => {
    const id = Number(ctx.params.id);
    requireServerAccess(ctx.user, id, "server.files");
    const body = await ctx.body<{ from?: string; to?: string }>();
    if (!body.from || !body.to) throw badRequest("from and to are required");
    renameEntry(id, body.from, body.to);
    recordActivity({ type: "file.renamed", serverId: id, target: body.from, actorName: ctx.user!.username, metadata: { to: body.to } });
    return json({ ok: true });
  });

  api.post("/api/servers/:id/files/copy", async (ctx) => {
    const id = Number(ctx.params.id);
    requireServerAccess(ctx.user, id, "server.files");
    const body = await ctx.body<{ from?: string; to?: string; move?: boolean }>();
    if (!body.from || !body.to) throw badRequest("from and to are required");
    if (body.move) renameEntry(id, body.from, body.to);
    else copyEntry(id, body.from, body.to);
    return json({ ok: true });
  });

  api.post("/api/servers/:id/files/delete", async (ctx) => {
    const id = Number(ctx.params.id);
    requireServerAccess(ctx.user, id, "server.files");
    const body = await ctx.body<{ paths?: string[] }>();
    if (!Array.isArray(body.paths) || body.paths.length === 0) throw badRequest("paths array is required");
    const result = deleteEntries(id, body.paths, { protectWorlds: true });
    recordActivity({
      type: "file.deleted", serverId: id, target: result.deleted.join(", ").slice(0, 200),
      actorName: ctx.user!.username, metadata: { count: result.deleted.length },
    });
    return json(result);
  });

  api.post("/api/servers/:id/files/upload", async (ctx) => {
    const id = Number(ctx.params.id);
    requireServerAccess(ctx.user, id, "server.files");
    const contentType = ctx.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) throw badRequest("A multipart/form-data upload is required");
    const form = await ctx.req.formData();
    const path = String(form.get("path") ?? "");
    const file = form.get("file");
    const overwrite = String(form.get("overwrite") ?? "false") === "true";
    const extract = String(form.get("extract") ?? "false") === "true";
    if (!(file instanceof File)) throw badRequest("A file field is required");

    if (extract) {
      const tempPath = `${PATHS.temporary}/${randomUUID()}-${file.name}`;
      await Bun.write(tempPath, file);
      const result = extractArchive(id, tempPath, path);
      rmSync(tempPath, { force: true });
      recordActivity({ type: "archive.extracted", serverId: id, target: path || "/", actorName: ctx.user!.username, metadata: result });
      return json({ extracted: result.extracted, path: sanitizeRelative(path) }, { status: 201 });
    }

    const destination = path === "" ? file.name : `${sanitizeRelative(path)}/${file.name}`;
    const result = await saveUpload(id, destination, file, { overwrite });
    recordActivity({
      type: "file.uploaded", serverId: id, target: result.path, actorName: ctx.user!.username,
      metadata: { size: result.size },
    });
    return json(result, { status: 201 });
  });

  api.post("/api/servers/:id/files/extract", async (ctx) => {
    const id = Number(ctx.params.id);
    requireServerAccess(ctx.user, id, "server.files");
    const body = await ctx.body<{ path?: string; destination?: string }>();
    if (!body.path) throw badRequest("path is required");
    const server = (await import("../database")).queryOne<{ uuid: string }>("SELECT uuid FROM servers WHERE id = ?", [id])!;
    const { resolveServerPath } = await import("../security/paths");
    const { serverDir } = await import("../shared/config");
    const archive = resolveServerPath(serverDir(server.uuid), body.path, { mustExist: true });
    const result = extractArchive(id, archive, body.destination ?? "");
    recordActivity({ type: "archive.extracted", serverId: id, target: body.path, actorName: ctx.user!.username, metadata: result });
    return json(result);
  });

  api.get("/api/servers/:id/files/download", async (ctx) => {
    const id = Number(ctx.params.id);
    requireServerAccess(ctx.user, id, "server.files");
    const path = ctx.query("path");
    if (!path) throw badRequest("path is required");
    const { stream, size, name } = fileStream(id, path);
    return new Response(stream, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(size),
        "content-disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
        "x-content-type-options": "nosniff",
      },
    });
  });

  api.get("/api/servers/:id/files/archive", async (ctx) => {
    const id = Number(ctx.params.id);
    requireServerAccess(ctx.user, id, "server.files");
    const path = ctx.query("path") ?? "";
    const archive = createArchive(id, path);
    const file = Bun.file(archive.path);
    recordActivity({ type: "archive.created", serverId: id, target: path || "/", actorName: ctx.user!.username });
    return new Response(file.stream(), {
      headers: {
        "content-type": "application/gzip",
        "content-length": String(file.size),
        "content-disposition": `attachment; filename="${archive.name}"`,
      },
    });
  });
}
