import { describe, expect, test } from "bun:test";
import { playerJoinName, playerLeaveName, stripConsoleColours } from "../src/processes/console-detect";

const ESC = String.fromCharCode(27);

describe("player detection from console lines", () => {
  test("plain Paper join line", () => {
    expect(playerJoinName("13:44:02 [13:44:02 INFO]: SUNNYGAMINGPE joined the game")).toBe("SUNNYGAMINGPE");
    expect(playerJoinName("[13:44:02] [Server thread/INFO]: Steve_123 joined the game")).toBe("Steve_123");
  });

  test("colour codes never leak into the name", () => {
    // The regression that produced "85mSUNNYGAMINGPE": 256-colour SGR right before the name.
    expect(playerJoinName(`${ESC}[38;5;85mSUNNYGAMINGPE${ESC}[0m joined the game`)).toBe("SUNNYGAMINGPE");
    expect(playerJoinName("13:44:02 [38;5;85mSUNNYGAMINGPE joined the game")).toBe("SUNNYGAMINGPE");
    expect(playerJoinName(`13:44:02 ${ESC}[32m${ESC}[1mSUNNYGAMINGPE${ESC}[m joined the game`)).toBe("SUNNYGAMINGPE");
    expect(playerJoinName(`${ESC}[38;5;85m[SUNNYGAMINGPE]${ESC}[0m joined the game`)).toBe("SUNNYGAMINGPE");
  });

  test("bracketed join messages", () => {
    expect(playerJoinName("<SUNNYGAMINGPE> joined the game")).toBe("SUNNYGAMINGPE");
  });

  test("leave and disconnect lines", () => {
    expect(playerLeaveName("13:44:02 [13:44:02 INFO]: SUNNYGAMINGPE left the game")).toBe("SUNNYGAMINGPE");
    expect(playerLeaveName("13:44:02 [13:44:02 INFO]: SUNNYGAMINGPE lost connection: Disconnected")).toBe("SUNNYGAMINGPE");
    expect(playerLeaveName(`${ESC}[38;5;85mSUNNYGAMINGPE lost connection`)).toBe("SUNNYGAMINGPE");
  });

  test("unrelated lines are ignored", () => {
    expect(playerJoinName("Done (1.41s)! For help, type \"help\"")).toBeNull();
    expect(playerJoinName("SUNNYGAMINGPE joined the world")).toBeNull();
  });

  test("stripConsoleColours removes both escape forms", () => {
    expect(stripConsoleColours(`${ESC}[38;5;85mhi${ESC}[0m`).trim()).toBe("hi");
    expect(stripConsoleColours("[38;5;85mhi").trim()).toBe("hi");
  });
});
