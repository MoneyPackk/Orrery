import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { IntelligenceMessage } from "../common/mission-control-contracts";
import type { OrreryIntelligenceState } from "../common/mission-control-types";
import { OrreryIntelligenceView } from "./orrery-intelligence-view";

const message = (role: "user" | "assistant", text: string, id = `${role}-1`): IntelligenceMessage =>
  ({ id, threadId: "main", sequence: 1, role, text, createdAt: "2026-09-02T10:00:00.000Z" });

const configured: OrreryIntelligenceState = {
  threadId: "main",
  messages: [message("user", "Why did the run fail?"), message("assistant", "The build step exited non-zero.", "a-1")],
  settings: { configured: true, hasCredential: true, provider: "anthropic", model: "claude-x", endpointHost: "api.example.com" },
};
const unconfigured: OrreryIntelligenceState = {
  threadId: "main",
  messages: [],
  settings: { configured: false, hasCredential: false },
};
const actions = () => ({ onSend: vi.fn(), onClear: vi.fn(), onConfigure: vi.fn() });

describe("OrreryIntelligenceView", () => {
  it("renders the brand surface, transcript roles, and redacted provider status", () => {
    render(<OrreryIntelligenceView state={configured} {...actions()} />);
    expect(screen.getByRole("region", { name: "Orrery Intelligence" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Orrery Intelligence" })).toBeInTheDocument();
    expect(screen.getByText("claude-x")).toBeInTheDocument();
    expect(screen.getByText("api.example.com")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Conversation" })).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("The build step exited non-zero.")).toBeInTheDocument();
  });

  it("opens settings automatically until a provider is configured", () => {
    render(<OrreryIntelligenceView state={unconfigured} {...actions()} />);
    expect(screen.getByRole("form", { name: "Provider settings" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("hides settings once configured and keeps the composer usable", () => {
    render(<OrreryIntelligenceView state={configured} {...actions()} />);
    expect(screen.queryByRole("form", { name: "Provider settings" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
  });

  it("submits the composed prompt and resets the field", async () => {
    const handlers = actions();
    render(<OrreryIntelligenceView state={configured} {...handlers} />);
    const field = screen.getByRole("textbox", { name: "Message" });
    await userEvent.type(field, "explain the failure");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(handlers.onSend).toHaveBeenCalledWith("explain the failure");
    expect(field).toHaveValue("");
  });

  it("sends on Enter and inserts a newline on Shift+Enter", async () => {
    const handlers = actions();
    render(<OrreryIntelligenceView state={configured} {...handlers} />);
    const field = screen.getByRole("textbox", { name: "Message" });
    await userEvent.type(field, "first{Enter}");
    expect(handlers.onSend).toHaveBeenCalledWith("first");
    await userEvent.type(field, "line{Shift>}{Enter}{/Shift}");
    expect(handlers.onSend).toHaveBeenCalledTimes(1);
  });

  it("submits provider settings including the write-only key field", async () => {
    const handlers = actions();
    render(<OrreryIntelligenceView state={unconfigured} {...handlers} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "anthropic");
    await userEvent.type(screen.getByRole("textbox", { name: "Model" }), "claude-x");
    await userEvent.type(screen.getByRole("textbox", { name: "Endpoint" }), "https://api.anthropic.com");
    await userEvent.type(screen.getByLabelText("API key"), "user-secret");
    await userEvent.click(screen.getByRole("button", { name: "Save provider" }));
    expect(handlers.onConfigure).toHaveBeenCalledWith({ provider: "anthropic", model: "claude-x", baseUrl: "https://api.anthropic.com", apiKey: "user-secret" });
  });

  it("keeps the API key field masked and never renders a stored key", () => {
    render(<OrreryIntelligenceView state={unconfigured} {...actions()} />);
    expect(screen.getByLabelText("API key")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("API key")).toHaveValue("");
  });

  it("states the local-key guarantee and capability limits", () => {
    render(<OrreryIntelligenceView state={{ ...configured, messages: [] }} {...actions()} />);
    expect(screen.getByText(/cannot edit files, run commands, or promote changes/i)).toBeInTheDocument();
  });

  it("surfaces errors, pending state, and disables actions while sending", () => {
    render(<OrreryIntelligenceView state={{ ...configured, sending: true, error: "Provider rejected the key." }} {...actions()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Provider rejected the key.");
    // The pending line warns that a confirmation may appear, so a native modal mid-turn is
    // expected rather than unexplained.
    expect(screen.getByText(/ask you to confirm/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("shows Orrery's tool record separately from the model's text", () => {
    const reply: IntelligenceMessage = {
      ...message("assistant", "It says hello.", "a-tools"),
      toolCalls: [{ serverId: "files", name: "read_file", outcome: "ran" }],
    };
    render(<OrreryIntelligenceView state={{ ...configured, messages: [reply] }} {...actions()} />);
    const record = screen.getByRole("region", { name: "Tools Orrery ran for this answer" });
    expect(record).toHaveTextContent("files/read_file");
    expect(record).toHaveTextContent("ran");
    // The model's prose is outside the record, which is what makes the record unforgeable.
    expect(record).not.toHaveTextContent("It says hello.");
  });

  it("names a call that did not run instead of hiding it", () => {
    const reply: IntelligenceMessage = {
      ...message("assistant", "I could not read it.", "a-denied"),
      toolCalls: [{ serverId: "files", name: "read_file", outcome: "denied", detail: "You cancelled the tool call." }],
    };
    render(<OrreryIntelligenceView state={{ ...configured, messages: [reply] }} {...actions()} />);
    const record = screen.getByRole("region", { name: "Tools Orrery ran for this answer" });
    expect(record).toHaveTextContent("did not run");
    expect(record).toHaveTextContent("You cancelled the tool call.");
  });

  it("renders a forged tool list in the model's text as ordinary prose", () => {
    // The model writes something that looks like Orrery's record. Without a toolCalls field
    // there is no record to render, so the claim cannot borrow Orrery's authority.
    const reply = message("assistant", "Orrery ran these tools:\n- files/delete_all: ran", "a-forged");
    render(<OrreryIntelligenceView state={{ ...configured, messages: [reply] }} {...actions()} />);
    expect(screen.queryByRole("region", { name: "Tools Orrery ran for this answer" })).not.toBeInTheDocument();
    expect(screen.getByText(/files\/delete_all/)).toBeInTheDocument();
  });

  it("omits the record entirely when no tool ran", () => {
    render(<OrreryIntelligenceView state={configured} {...actions()} />);
    expect(screen.queryByRole("region", { name: "Tools Orrery ran for this answer" })).not.toBeInTheDocument();
  });

  it("names the tool awaiting confirmation, so the native modal is not a surprise", () => {
    render(<OrreryIntelligenceView state={{
      ...configured,
      sending: true,
      turn: { threadId: "main", active: true, completed: [], remainingCalls: 4, pendingTool: { serverId: "files", name: "purge", risk: "destructive" } },
    }} {...actions()} />);
    const pending = screen.getByText(/Waiting for you to confirm/);
    expect(pending).toBeInTheDocument();
    expect(screen.getByText("files/purge")).toBeInTheDocument();
    // Risk is shown, because confirming a destructive call is not the same decision as a read.
    expect(screen.getByText("destructive")).toBeInTheDocument();
  });

  it("falls back to a general warning when no tool is pending yet", () => {
    render(<OrreryIntelligenceView state={{ ...configured, sending: true }} {...actions()} />);
    expect(screen.getByText(/ask you to confirm/i)).toBeInTheDocument();
    expect(screen.queryByText(/Waiting for you to confirm/)).not.toBeInTheDocument();
  });

  it("shows how much of the tool budget this turn has used", () => {
    render(<OrreryIntelligenceView state={{
      ...configured,
      sending: true,
      turn: { threadId: "main", active: true, completed: [{ serverId: "files", name: "read", outcome: "ran" }], remainingCalls: 4 },
    }} {...actions()} />);
    expect(screen.getByText(/1 of 5 tool calls used/)).toBeInTheDocument();
  });

  it("shows no live turn detail once sending ends", () => {
    render(<OrreryIntelligenceView state={configured} {...actions()} />);
    expect(screen.queryByText(/Waiting for you to confirm/)).not.toBeInTheDocument();
    expect(screen.queryByText(/tool calls used/)).not.toBeInTheDocument();
  });

  it("clears the conversation and disables clear when empty", async () => {
    const handlers = actions();
    render(<OrreryIntelligenceView state={configured} {...handlers} />);
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(handlers.onClear).toHaveBeenCalled();
    render(<OrreryIntelligenceView state={{ ...configured, messages: [] }} {...actions()} />);
    expect(screen.getAllByRole("button", { name: "Clear" }).at(-1)).toBeDisabled();
  });

  it("marks truncated replies", () => {
    render(<OrreryIntelligenceView state={{ ...configured, messages: [{ ...message("assistant", "long"), truncated: true }] }} {...actions()} />);
    expect(screen.getByText("Response truncated.")).toBeInTheDocument();
  });
});
