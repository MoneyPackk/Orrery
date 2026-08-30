import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Mission } from "../common/mission-control-contracts";
import { MissionControlView } from "./mission-control-view";

const selected: Mission = {
  id: "m-1", title: "Theia tracer", goal: "Mount Mission Control", mode: "build", status: "ready_for_review",
  createdAt: "2026-08-29T10:00:00.000Z", updatedAt: "2026-08-29T11:00:00.000Z", targetBranch: "main", missionBranch: "orrery/m-1",
  plan: { id: "p-1", revision: 1, approved: true, createdAt: "2026-08-29T10:00:00.000Z", scope: "Theia", actions: ["Mount"], acceptanceCriteria: ["Visible"] }, events: [],
  changes: [{ path: "src/widget.tsx", additions: 12, deletions: 2, diff: "+widget" }],
  evidence: [{ id: "e-1", kind: "test", status: "passed", summary: "Widget tests passed", planRevisionId: "p-1", timestamp: "2026-08-29T11:00:00.000Z" }], completionSummary: "Compiled tracer",
};

describe("MissionControlView", () => {
  it("renders accessible mission list, status, detail, evidence, and review controls", () => {
    render(<MissionControlView state={{ missions: [{ id: "m-1", title: "Theia tracer", status: "ready_for_review", updatedAt: selected.updatedAt }], selectedId: "m-1", selected }} onSelect={vi.fn()} onRefresh={vi.fn()} onReview={vi.fn()} />);
    expect(screen.getByRole("region", { name: "Mission Control" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Missions" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Theia tracer" })).toBeInTheDocument();
    expect(screen.getAllByText("ready for review")).toHaveLength(2);
    expect(screen.getByText("src/widget.tsx")).toBeInTheDocument();
    expect(screen.getByText("Widget tests passed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept mission" })).toBeEnabled();
  });

  it("dispatches selection, refresh, and review actions", async () => {
    const user = userEvent.setup(); const onSelect = vi.fn(); const onRefresh = vi.fn(); const onReview = vi.fn();
    render(<MissionControlView state={{ missions: [{ id: "m-1", title: "Theia tracer", status: "ready_for_review", updatedAt: selected.updatedAt }], selectedId: "m-1", selected }} onSelect={onSelect} onRefresh={onRefresh} onReview={onReview} />);
    await user.click(screen.getByRole("button", { name: "Theia tracer ready for review" }));
    await user.click(screen.getByRole("button", { name: "Refresh missions" }));
    await user.click(screen.getByRole("button", { name: "Request revision" }));
    expect(onSelect).toHaveBeenCalledWith("m-1"); expect(onRefresh).toHaveBeenCalledOnce(); expect(onReview).toHaveBeenCalledWith("revision_requested");
  });

  it("disables review controls while a review is pending", () => {
    render(<MissionControlView state={{ missions: [], selectedId: "m-1", selected, pendingReview: true }} onSelect={vi.fn()} onRefresh={vi.fn()} onReview={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Accept mission" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  });
});
