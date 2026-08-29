import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { MissionProvider } from "../state/mission-context";
import { AppShell } from "./app-shell";

function renderApp() {
  return render(
    <MissionProvider runtimeDelay={0}>
      <AppShell />
    </MissionProvider>,
  );
}

async function createMission(user: ReturnType<typeof userEvent.setup>, title = "Build quick open") {
  await user.click(screen.getByRole("button", { name: "New mission" }));
  await user.type(screen.getByLabelText("Mission title"), title);
  await user.type(screen.getByLabelText("Goal"), "Navigate files without leaving the keyboard");
  await user.click(screen.getByRole("button", { name: "Create mission" }));
}

async function prepareRun(user: ReturnType<typeof userEvent.setup>) {
  await createMission(user);
  await user.clear(screen.getByLabelText("Scope"));
  await user.type(screen.getByLabelText("Scope"), "Add a keyboard-first file navigator.");
  await user.clear(screen.getByLabelText("Action 1"));
  await user.type(screen.getByLabelText("Action 1"), "Index workspace files");
  await user.clear(screen.getByLabelText("Acceptance criterion 1"));
  await user.type(
    screen.getByLabelText("Acceptance criterion 1"),
    "The delegated change is covered by passing tests",
  );
  await user.click(screen.getByRole("button", { name: "Save plan" }));
  await user.click(screen.getByRole("button", { name: "Approve plan" }));
  await user.click(screen.getByRole("button", { name: "Start fixture run" }));
  await screen.findByRole("heading", { name: "Permission required" });
}

beforeEach(() => window.localStorage.clear());

describe("Mission Control shell", () => {
  it("creates a mission from the empty state and restores focus after cancelling", async () => {
    const user = userEvent.setup();
    renderApp();
    const trigger = screen.getByRole("button", { name: "New mission" });

    expect(screen.getByText("No missions in this project")).toBeInTheDocument();
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(trigger).toHaveFocus();

    await createMission(user);
    expect(screen.getByRole("button", { name: /Build quick open/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Build quick open" })).toBeInTheDocument();
  });

  it("keeps start gated until the edited plan is approved", async () => {
    const user = userEvent.setup();
    renderApp();
    await createMission(user);

    expect(screen.getByRole("button", { name: "Start fixture run" })).toBeDisabled();
    await user.clear(screen.getByLabelText("Scope"));
    await user.type(screen.getByLabelText("Scope"), "Add file navigation.");
    await user.clear(screen.getByLabelText("Action 1"));
    await user.type(screen.getByLabelText("Action 1"), "Index files");
    await user.clear(screen.getByLabelText("Acceptance criterion 1"));
    await user.type(screen.getByLabelText("Acceptance criterion 1"), "Keyboard navigation works");
    await user.click(screen.getByRole("button", { name: "Save plan" }));
    await user.click(screen.getByRole("button", { name: "Approve plan" }));

    expect(screen.getByRole("button", { name: "Start fixture run" })).toBeEnabled();
  });

  it("round-trips every plan action and acceptance criterion", async () => {
    const user = userEvent.setup();
    renderApp();
    await createMission(user);
    await user.click(screen.getByRole("button", { name: "Add action" }));
    await user.type(screen.getByLabelText("Action 1"), "First action");
    await user.type(screen.getByLabelText("Action 2"), "Second action");
    await user.click(screen.getByRole("button", { name: "Add acceptance criterion" }));
    await user.type(screen.getByLabelText("Acceptance criterion 1"), "First criterion");
    await user.type(screen.getByLabelText("Acceptance criterion 2"), "Second criterion");
    await user.click(screen.getByRole("button", { name: "Save plan" }));

    expect(screen.getByLabelText("Action 2")).toHaveValue("Second action");
    expect(screen.getByLabelText("Acceptance criterion 2")).toHaveValue("Second criterion");
  });

  it.each([
    "Create mission shortcut",
    "Create the first mission",
    "New mission",
  ])("restores focus to the %s dialog trigger after Escape", async (name) => {
    const user = userEvent.setup();
    renderApp();
    const trigger = screen.getByRole("button", { name });
    await user.click(trigger);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("shows the isolated workspace and scoped capability request", async () => {
    const user = userEvent.setup();
    renderApp();
    await prepareRun(user);

    expect(screen.getAllByText(/\.orrery\/worktrees\/fixture-workspace-[0-9a-f-]{36}/i)).not.toHaveLength(0);
    const prompt = screen.getByRole("region", { name: "Permission required" });
    expect(within(prompt).getByText("registry.npmjs.org")).toBeInTheDocument();
    expect(within(prompt).getByText(/Check package metadata/)).toBeInTheDocument();
  });

  it("denies network safely, exposes review evidence, and accepts the mission", async () => {
    const user = userEvent.setup();
    renderApp();
    await prepareRun(user);
    await user.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Permission required" })).not.toBeInTheDocument(),
    );
    expect(await screen.findAllByText("Fixture implementation complete. One file changed and verification passed.")).not.toHaveLength(0);
    expect(screen.getByText("src/mission-fixture.ts")).toBeInTheDocument();
    expect(screen.getAllByText("8 fixture checks passed in 420ms")).not.toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Accept mission" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Build quick open, accepted/ })).toBeInTheDocument(),
    );
  });

  it("supports manual light and dark theme selection", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.selectOptions(screen.getByLabelText("Color theme"), "light");
    expect(document.documentElement.dataset.theme).toBe("light");
    await user.selectOptions(screen.getByLabelText("Color theme"), "dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("offers a keyboard-accessible cancel action for an active run", async () => {
    const user = userEvent.setup();
    renderApp();
    await prepareRun(user);
    const cancel = screen.getByRole("button", { name: "Cancel run" });
    cancel.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getAllByText("cancelled")).not.toHaveLength(0));
    expect(screen.queryByRole("region", { name: "Permission required" })).not.toBeInTheDocument();
  });

  it("surfaces recoverable persisted-state corruption", async () => {
    window.localStorage.setItem("orrery.missions.v1", "{not-json");
    const user = userEvent.setup();
    renderApp();

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/stored mission data/i);
    await user.click(within(alert).getByRole("button", { name: /reset/i }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
