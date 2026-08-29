import { describe, expect, test, vi } from "vitest";
import { createLocalKeyHandler, type TuiCommand } from "./keymap";

describe("createLocalKeyHandler", () => {
  test.each([
    ["up", "up"],
    ["k", "up"],
    ["down", "down"],
    ["j", "down"],
    ["r", "refresh"],
    ["i", "inspect"],
    ["return", "inspect"],
    ["s", "subscribe"],
    ["q", "quit"],
    ["escape", "quit"],
  ] as const)("maps %s to the read-mostly %s command", (key, command) => {
    const dispatch = vi.fn<(command: TuiCommand) => void>();
    const handle = createLocalKeyHandler(dispatch);

    expect(handle({ name: key, ctrl: false })).toBe(true);
    expect(dispatch).toHaveBeenCalledWith(command);
  });

  test("maps ctrl-c to quit and leaves mutation-like keys unhandled", () => {
    const dispatch = vi.fn<(command: TuiCommand) => void>();
    const handle = createLocalKeyHandler(dispatch);

    expect(handle({ name: "c", ctrl: true })).toBe(true);
    expect(handle({ name: "d", ctrl: false })).toBe(false);
    expect(dispatch.mock.calls).toEqual([["quit"]]);
  });
});
