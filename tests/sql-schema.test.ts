import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runMigrations } from "../src/database";

/**
 * Every INSERT statement in the codebase is compiled against the real schema here.
 *
 * This test exists because a mismatch of one placeholder ("25 values for 24 columns") shipped in
 * the server-creation path: it compiles fine, it type-checks fine, and nothing else in the suite
 * ever ran that statement. SQLite refuses to compile it, which is exactly what this checks — no
 * data directory, no panel, no server, just the schema and the statements.
 */

const ROOT = join(import.meta.dir, "..");
let db: Database;

/** All `.ts` files under src/, excluding tests. */
function sourceFiles(dir = join(ROOT, "src")): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

interface Statement {
  file: string;
  line: number;
  table: string;
  sql: string;
}

/** Pulls every `INSERT INTO …(cols) VALUES (…)` out of a source file, literals and all. */
function insertStatements(file: string): Statement[] {
  const text = readFileSync(file, "utf8");
  const found: Statement[] = [];
  const pattern = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const table = match[1];
    const valuesAt = text.indexOf("VALUES", match.index);
    if (valuesAt === -1) continue;
    const open = text.indexOf("(", valuesAt);
    if (open === -1) continue;
    // Walk to the matching close paren so multi-line value lists are captured whole.
    let depth = 0;
    let i = open;
    for (; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    const sql = text.slice(match.index, i + 1).replace(/\s+/g, " ").trim();
    found.push({ file, line: text.slice(0, match.index).split("\n").length, table, sql });
  }
  return found;
}

let statements: Statement[] = [];

beforeAll(() => {
  db = new Database(":memory:");
  runMigrations(db);
  statements = sourceFiles().flatMap(insertStatements);
});

afterAll(() => {
  db?.close();
});

describe("every INSERT compiles against the real schema", () => {
  test("the scan actually found the inserts (a silent zero would make this test worthless)", () => {
    expect(statements.length).toBeGreaterThan(20);
    const tables = new Set(statements.map((s) => s.table));
    // Tables the panel cannot work without — if the scan misses these it is not scanning.
    for (const table of ["servers", "users", "worlds", "schedules", "backups", "plugins"]) {
      expect(tables.has(table)).toBe(true);
    }
  });

  test("column count and value count agree, and every column exists", () => {
    const problems: string[] = [];
    for (const statement of statements) {
      // 1. SQLite itself: a value/column mismatch or an unknown column fails to compile.
      try {
        db.prepare(statement.sql);
      } catch (error) {
        const where = statement.file.replace(ROOT, "").replace(/^\//, "");
        problems.push(`${where}:${statement.line} (${statement.table}) → ${(error as Error).message}`);
        continue;
      }
      // 2. The columns named really belong to that table.
      const columns = new Set(
        db.query(`PRAGMA table_info(${statement.table})`).all().map((row: any) => row.name),
      );
      const named = /\(([^)]*)\)/.exec(statement.sql)?.[1] ?? "";
      for (const column of named.split(",").map((c) => c.trim()).filter(Boolean)) {
        if (!columns.has(column)) {
          const where = statement.file.replace(ROOT, "").replace(/^\//, "");
          problems.push(`${where}:${statement.line} (${statement.table}) → no such column: ${column}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test("the servers insert writes every value it declares", () => {
    // The regression that prompted this file: one extra `?` shifted eula_accepted onto a
    // placeholder and left a stray literal at the end, so creation failed for every software.
    const insert = statements.find((s) => s.table === "servers");
    expect(insert).toBeDefined();
    const values = /VALUES\s*\((.*)\)/i.exec(insert!.sql)?.[1] ?? "";
    const parts = values.split(",").map((p) => p.trim());
    expect(parts.length).toBe(24);
    expect(parts[parts.length - 1]).toBe("1"); // eula_accepted, a literal
    expect(parts.filter((p) => p === "?").length).toBe(21);
  });
});
