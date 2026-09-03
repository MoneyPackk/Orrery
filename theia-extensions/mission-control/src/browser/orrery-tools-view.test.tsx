import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { McpActivityEntry, McpServerStatus, McpToolStatus } from "../common/mission-control-contracts";
import type { OrreryToolsState } from "../common/mission-control-types";
import { OrreryToolsView } from "./orrery-tools-view";

const server = (overrides: Partial<McpServerStatus> = {}): McpServerStatus =>
  ({ serverId: "s1", label: "Files", transport: "stdio", origin: "server.exe", enabled: true, toolCount: 2, registeredAt: "2026-09-03T10:00:00.000Z", ...overrides });

const tool = (overrides: Partial<McpToolStatus> = {}): McpToolStatus =>
  ({ serverId: "s1", name: "read_file", title: "Read file", description: "Reads a file from disk.", risk: "read", decision: "ask", alwaysAsk: false, ...overrides });

const entry = (overrides: Partial<McpActivityEntry> = {}): McpActivityEntry =>
  ({ sequence: 1, serverId: "s1", name: "read_file", risk: "read", outcome: "allowed", at: "2026-09-03T10:00:00.000Z", ...overrides });

const populated: OrreryToolsState = { servers: [server()], tools: [tool()], activity: [entry()] };
const empty: OrreryToolsState = { servers: [], tools: [], activity: [] };
const actions = () => ({ onRefresh: vi.fn(), onRegister: vi.fn(), onRemove: vi.fn(), onDecide: vi.fn(), onInvoke: vi.fn() });

describe("OrreryToolsView", () => {
  it("renders the labelled surface, servers, tools, and activity", () => {
    render(<OrreryToolsView state={populated} {...actions()} />);
    expect(screen.getByRole("region", { name: "Orrery Tools" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Servers" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Tools" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Activity" })).toBeInTheDocument();
    expect(screen.getByText("Read file")).toBeInTheDocument();
    expect(screen.getByText("1 server · 1 tool")).toBeInTheDocument();
  });

  it("states each tool's risk in plain language rather than a bare classifier token", () => {
    render(<OrreryToolsView state={{ ...empty, tools: [tool({ risk: "destructive", name: "delete_file" })] }} {...actions()} />);
    expect(screen.getByText("Deletes data")).toBeInTheDocument();
  });

  it("tells the user a confirmation is coming before a server can run", () => {
    render(<OrreryToolsView state={empty} {...actions()} />);
    expect(screen.getByText(/asked to confirm/i)).toBeInTheDocument();
  });

  it("renders untrusted tool output as text, never as markup", () => {
    const lastResult = { serverId: "s1", name: "read_file", risk: "read" as const, content: "<img src=x onerror=\"alert(1)\">", isError: false, truncated: false, invokedAt: "now", sequence: 2 };
    const { container } = render(<OrreryToolsView state={{ ...populated, lastResult }} {...actions()} />);
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("reports a truncated result so the user does not read partial output as complete", () => {
    const lastResult = { serverId: "s1", name: "read_file", risk: "read" as const, content: "body", isError: false, truncated: true, invokedAt: "now", sequence: 2 };
    render(<OrreryToolsView state={{ ...populated, lastResult }} {...actions()} />);
    expect(screen.getByText(/output truncated/i)).toBeInTheDocument();
  });

  it("refuses to invoke with malformed JSON arguments and explains why", async () => {
    const handlers = actions();
    render(<OrreryToolsView state={populated} {...handlers} />);
    await userEvent.clear(screen.getByLabelText(/Arguments \(JSON\)/));
    await userEvent.click(screen.getByLabelText(/Arguments \(JSON\)/));
    await userEvent.paste("{not json");
    await userEvent.click(screen.getByRole("button", { name: "Run read_file" }));
    expect(handlers.onInvoke).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Arguments must be valid JSON.");
  });

  it("rejects a JSON array because tool arguments must be an object", async () => {
    const handlers = actions();
    render(<OrreryToolsView state={populated} {...handlers} />);
    // Pasted rather than typed: `[` opens a key descriptor for userEvent.type.
    await userEvent.clear(screen.getByLabelText(/Arguments \(JSON\)/));
    await userEvent.click(screen.getByLabelText(/Arguments \(JSON\)/));
    await userEvent.paste("[1]");
    await userEvent.click(screen.getByRole("button", { name: "Run read_file" }));
    expect(handlers.onInvoke).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Arguments must be a JSON object.");
  });

  it("invokes with parsed arguments", async () => {
    const handlers = actions();
    render(<OrreryToolsView state={populated} {...handlers} />);
    await userEvent.click(screen.getByRole("button", { name: "Run read_file" }));
    expect(handlers.onInvoke).toHaveBeenCalledWith("s1", "read_file", {});
  });

  it("offers no standing permission for a tool that must always be confirmed", () => {
    render(<OrreryToolsView state={{ ...empty, tools: [tool({ risk: "destructive", alwaysAsk: true })] }} {...actions()} />);
    expect(screen.queryByLabelText(/^Permission for/)).not.toBeInTheDocument();
    // Must read as a standing warning, not as "this was already approved".
    expect(screen.getByText("Asks every time")).toBeInTheDocument();
  });

  it("changes a standing permission through the callback", async () => {
    const handlers = actions();
    render(<OrreryToolsView state={populated} {...handlers} />);
    await userEvent.selectOptions(screen.getByLabelText("Permission for read_file"), "allow");
    expect(handlers.onDecide).toHaveBeenCalledWith("s1", "read_file", "allow");
  });

  it("names each tool's controls so they cannot be confused with another tool's", () => {
    const tools = [tool(), tool({ name: "delete_file", title: "Delete file", risk: "destructive" })];
    render(<OrreryToolsView state={{ ...empty, tools }} {...actions()} />);
    expect(screen.getByRole("button", { name: "Run read_file" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run delete_file" })).toBeInTheDocument();
  });

  it("keeps each tool's arguments with its own row", async () => {
    const tools = [tool(), tool({ name: "write_file", title: "Write file", risk: "write" })];
    render(<OrreryToolsView state={{ ...empty, tools }} {...actions()} />);
    const boxes = screen.getAllByLabelText(/Arguments \(JSON\)/);
    await userEvent.clear(boxes[0]!);
    await userEvent.click(boxes[0]!);
    await userEvent.paste('{"path":"a.txt"}');
    expect(boxes[0]).toHaveValue('{"path":"a.txt"}');
    expect(boxes[1]).toHaveValue("{}");
  });

  it("clears a stale argument error once the input changes", async () => {
    render(<OrreryToolsView state={populated} {...actions()} />);
    await userEvent.clear(screen.getByLabelText(/Arguments \(JSON\)/));
    await userEvent.click(screen.getByLabelText(/Arguments \(JSON\)/));
    await userEvent.paste("[1]");
    await userEvent.click(screen.getByRole("button", { name: "Run read_file" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    // Clicking the button moved focus, so re-focus the field before typing into it.
    await userEvent.click(screen.getByLabelText(/Arguments \(JSON\)/));
    await userEvent.paste("{}");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("requires a second confirmation before removing a server and warns what is lost", async () => {
    const handlers = actions();
    render(<OrreryToolsView state={populated} {...handlers} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove Files" }));
    expect(handlers.onRemove).not.toHaveBeenCalled();
    expect(screen.getByText(/discards every permission/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Confirm removing Files" }));
    expect(handlers.onRemove).toHaveBeenCalledWith("s1");
  });

  it("abandons a removal when the user keeps the server", async () => {
    const handlers = actions();
    render(<OrreryToolsView state={populated} {...handlers} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove Files" }));
    await userEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(handlers.onRemove).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove Files" })).toBeInTheDocument();
  });

  it("keeps the add-server button disabled until the required fields are present", async () => {
    const handlers = actions();
    render(<OrreryToolsView state={empty} {...handlers} />);
    const submit = screen.getByRole("button", { name: "Add server…" });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Identifier"), "s1");
    await userEvent.type(screen.getByLabelText("Name"), "Files");
    await userEvent.type(screen.getByLabelText(/Program/), "C:\\tools\\server.exe");
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    expect(handlers.onRegister).toHaveBeenCalledWith({ serverId: "s1", label: "Files", transport: "stdio", command: "C:\\tools\\server.exe", args: [] });
  });

  it("clears the form only after the server is actually added", async () => {
    const handlers = { ...actions(), onRegister: vi.fn(async () => true) };
    render(<OrreryToolsView state={empty} {...handlers} />);
    await userEvent.type(screen.getByLabelText("Identifier"), "s1");
    await userEvent.type(screen.getByLabelText("Name"), "Files");
    await userEvent.type(screen.getByLabelText(/Program/), "C:\\tools\\server.exe");
    await userEvent.click(screen.getByRole("button", { name: "Add server…" }));
    expect(screen.getByLabelText("Identifier")).toHaveValue("");
    // A cleared form cannot be resubmitted, which is what makes re-registration non-accidental.
    expect(screen.getByRole("button", { name: "Add server…" })).toBeDisabled();
  });

  it("keeps the typed command when the registration is declined", async () => {
    const handlers = { ...actions(), onRegister: vi.fn(async () => false) };
    render(<OrreryToolsView state={empty} {...handlers} />);
    await userEvent.type(screen.getByLabelText("Identifier"), "s1");
    await userEvent.type(screen.getByLabelText("Name"), "Files");
    await userEvent.type(screen.getByLabelText(/Program/), "C:\\tools\\server.exe");
    await userEvent.click(screen.getByRole("button", { name: "Add server…" }));
    expect(screen.getByLabelText("Identifier")).toHaveValue("s1");
  });

  it("collects one argument per line and drops blank lines", async () => {
    const handlers = actions();
    render(<OrreryToolsView state={empty} {...handlers} />);
    await userEvent.type(screen.getByLabelText("Identifier"), "s1");
    await userEvent.type(screen.getByLabelText("Name"), "Files");
    await userEvent.type(screen.getByLabelText(/Program/), "C:\\tools\\server.exe");
    await userEvent.type(screen.getByLabelText(/Arguments \(one per line\)/), "--stdio{enter}{enter}  --verbose  ");
    await userEvent.click(screen.getByRole("button", { name: "Add server…" }));
    expect(handlers.onRegister).toHaveBeenCalledWith(expect.objectContaining({ args: ["--stdio", "--verbose"] }));
  });

  it("asks for an endpoint instead of a program for a remote server", async () => {
    render(<OrreryToolsView state={empty} {...actions()} />);
    await userEvent.selectOptions(screen.getByLabelText("Transport"), "http");
    expect(screen.getByLabelText("Endpoint")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Program/)).not.toBeInTheDocument();
  });

  it("marks the surface busy and disables actions while a request is in flight", () => {
    render(<OrreryToolsView state={{ ...populated, pending: true }} {...actions()} />);
    expect(screen.getByRole("region", { name: "Orrery Tools" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Run read_file" })).toBeDisabled();
  });

  it("announces an error to assistive technology", () => {
    render(<OrreryToolsView state={{ ...empty, error: "The tool run was not approved." }} {...actions()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("The tool run was not approved.");
  });

  it("reports a notice through a status role rather than as an error", () => {
    render(<OrreryToolsView state={{ ...empty, notice: "Added Files." }} {...actions()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Added Files.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("guides the user when nothing is registered yet", () => {
    render(<OrreryToolsView state={empty} {...actions()} />);
    expect(screen.getByText(/No tool servers yet/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing has run yet/)).toBeInTheDocument();
  });

  it("shows the newest activity first and explains a denial", () => {
    const state: OrreryToolsState = {
      ...empty,
      activity: [entry({ sequence: 1, name: "first" }), entry({ sequence: 2, name: "second", outcome: "denied", reason: "You declined the confirmation." })],
    };
    render(<OrreryToolsView state={state} {...actions()} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("second");
    expect(screen.getByText("You declined the confirmation.")).toBeInTheDocument();
  });

  it("refreshes on demand", async () => {
    const handlers = actions();
    render(<OrreryToolsView state={populated} {...handlers} />);
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(handlers.onRefresh).toHaveBeenCalled();
  });
});
