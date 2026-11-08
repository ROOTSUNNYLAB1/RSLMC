import { existsSync } from "node:fs";
import { join } from "node:path";
import { queryOne } from "../database";
import { serverDir } from "../shared/config";
import { ApiException } from "../shared/http";
import { APP_FAMILIES, type AppFamily } from "./catalog";
import { interpreterExecutable } from "./interpreters";
import { appEnvironment } from "./launch";
import { handOverDirectory, panelCanSwitchUser, serviceAccountState, serviceSpawnIdentity } from "../runtime/nonroot";

/*
 * Running a package manager for an app server.
 *
 * The console of a Python/Node server writes to the program's *stdin*, which is a real program's input —
 * it is not a shell. So "pip install requests" cannot be typed there, and telling an operator it can be
 * would be a lie that wastes their afternoon.
 *
 * What the panel offers instead is the two commands these ecosystems actually need, run as the same
 * account the server runs as, inside the server's own directory, with their output in the console:
 *
 *   Python : pip install -r requirements.txt
 *   Node   : npm install
 *
 * Anything else is uploaded or edited through the file manager — the panel does not pretend to offer an
 * arbitrary shell, because a web panel that runs arbitrary shell commands as a service account is a much
 * larger feature with a much larger blast radius.
 */

export interface DependencyRun {
  ok: boolean;
  command: string;
  output: string;
  exitCode: number | null;
}

export const DEPENDENCY_COMMANDS: Record<AppFamily, { command: string[]; label: string; needs: string }> = {
  python: {
    command: ["pip", "install", "-r", "requirements.txt"],
    label: "pip install -r requirements.txt",
    needs: "requirements.txt",
  },
  node: {
    command: ["npm", "install"],
    label: "npm install",
    needs: "package.json",
  },
};

/** Runs the family's dependency install once, streaming output through `onLine`. */
export async function installDependencies(
  serverId: number,
  onLine: (line: string) => void,
): Promise<DependencyRun> {
  const row = queryOne<{ uuid: string; software: string; mc_version: string; name: string }>(
    "SELECT uuid, software, mc_version, name FROM servers WHERE id = ?", [serverId],
  );
  if (!row) throw new ApiException(404, "server_not_found", "Server not found");
  if (row.software !== "python" && row.software !== "node") {
    throw new ApiException(400, "not_an_app_server",
      "Dependency install applies to Python and Node.js servers; Minecraft software bundles its own libraries.");
  }
  const family = row.software as AppFamily;
  const definition = APP_FAMILIES[family];
  const directory = serverDir(row.uuid);
  const spec = DEPENDENCY_COMMANDS[family];
  if (!existsSync(join(directory, spec.needs))) {
    throw new ApiException(400, "missing_manifest",
      `${definition.name} servers install dependencies from ${spec.needs}, and this server has no ${spec.needs} yet. `
      + `Create it in the Files tab first (the console cannot run shell commands — it writes to your program's stdin).`);
  }

  const executable = interpreterExecutable(family, row.mc_version);
  if (!executable) {
    throw new ApiException(409, "interpreter_missing",
      `${definition.name} ${row.mc_version} is not installed on this host yet. Start the server once, or install it from Settings → Runtimes.`);
  }
  const binDirectory = join(executable, "..");
  const account = serviceAccountState();
  const identity = panelCanSwitchUser() ? serviceSpawnIdentity(account) : null;
  if (identity) handOverDirectory(directory, account);

  onLine(`Running ${spec.label} in ${directory}${identity ? ` as ${identity.user}` : ""}…`);
  let output = "";
  try {
    const process_ = Bun.spawn(spec.command as string[], {
      cwd: directory,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...appEnvironment({ family, binDirectory, home: identity ? `/home/${identity.user}` : directory }),
      },
      ...(identity ? { uid: identity.uid, gid: identity.gid } : {}),
    });
    const [stdout, stderr] = await Promise.all([
      new Response(process_.stdout as ReadableStream).text(),
      new Response(process_.stderr as ReadableStream).text(),
    ]);
    const exitCode = await process_.exited;
    output = `${stdout}\n${stderr}`.trim();
    for (const line of output.split(/\r?\n/).slice(-400)) {
      if (line.trim().length > 0) onLine(line);
    }
    onLine(exitCode === 0 ? `${spec.label} finished successfully.` : `${spec.label} exited with code ${exitCode}.`);
    return { ok: exitCode === 0, command: spec.label, output: output.slice(0, 20_000), exitCode };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onLine(`${spec.label} could not start: ${message}`);
    return { ok: false, command: spec.label, output: message, exitCode: null };
  }
}
