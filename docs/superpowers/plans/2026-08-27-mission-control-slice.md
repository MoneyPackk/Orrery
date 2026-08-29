# Mission Control Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an executable local reference shell that proves Orrery's create, plan, run, permission, evidence, and review mission loop.

**Architecture:** A Vite React application imports a framework-independent domain module. Mission state is reduced through validated transitions, persisted to local storage, and presented in three coordinated surfaces: Mission Control, Plan Canvas, and Review Studio. A deterministic fixture runtime emits ordered events and one guarded capability request so the complete interaction can be tested without coupling the product contract to a model provider.

**Tech Stack:** TypeScript, React 19, Vite, Vitest, Testing Library, Playwright, native CSS variables, Phosphor Icons

**Spec:** `docs/superpowers/specs/2026-08-27-orrery-design.md`

## Global Constraints

- The product targets solo power users and remains local-first.
- Every write-capable run receives a distinct isolated workspace identifier.
- UI code cannot assign mission status directly; transitions pass through the domain reducer.
- A mission cannot become `ready_for_review` without a completion summary and evidence assessment.
- Guarded autonomy asks before network access, dependency installation, secrets, destructive operations, or deployment.
- Dark and light themes have hierarchy parity and reduced motion is supported.
- The interface uses cool graphite neutrals, one oxidized amber accent, 6px controls, 8px transient surfaces, and square editor regions.
- No generic card dashboard, decorative glow, fake status dot, or provider-specific data shape.

---

## File Structure

- `package.json`: scripts and runtime/development dependencies.
- `vite.config.ts`: Vite and Vitest configuration.
- `playwright.config.ts`: browser smoke-test configuration.
- `src/domain/mission.ts`: mission types, constructors, transition table, and reducer.
- `src/domain/mission.test.ts`: state-machine and invariant tests.
- `src/domain/fixture-runtime.ts`: deterministic event sequence and guarded permission continuation.
- `src/domain/fixture-runtime.test.ts`: runtime order and decision tests.
- `src/state/mission-context.tsx`: application state, persistence, and domain action facade.
- `src/state/mission-context.test.tsx`: persistence and action integration tests.
- `src/components/app-shell.tsx`: shell composition and primary navigation.
- `src/components/mission-list.tsx`: compact mission navigator and creation action.
- `src/components/plan-canvas.tsx`: editable plan and launch controls.
- `src/components/runtime-timeline.tsx`: ordered event and permission interaction.
- `src/components/review-studio.tsx`: changes, evidence, and review decisions.
- `src/components/new-mission-dialog.tsx`: accessible mission creation form.
- `src/components/components.test.tsx`: user-flow and accessibility-oriented component tests.
- `src/styles.css`: design tokens, layout, states, themes, and responsive behavior.
- `src/main.tsx`: React entry point.
- `e2e/mission-flow.spec.ts`: complete browser flow.

### Task 1: Project Foundation And Mission Domain

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.app.json`
- Create: `tsconfig.node.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `src/domain/mission.ts`
- Test: `src/domain/mission.test.ts`

**Interfaces:**
- Produces: `Mission`, `MissionStatus`, `MissionEvent`, `Evidence`, `createMission(input)`, and `transitionMission(mission, action)`.

- [ ] **Step 1: Create the Vite/Vitest package configuration**

Use React 19, Vite 7, TypeScript 5, Vitest 3, Testing Library, Playwright, and `@phosphor-icons/react`. Scripts must include `dev`, `build`, `typecheck`, `test`, and `test:e2e`.

- [ ] **Step 2: Write failing domain tests**

Test that a new mission starts in `draft`, plan approval reaches `queued`, starting without an isolated workspace throws, completion without evidence throws, and the valid path reaches `accepted`.

- [ ] **Step 3: Run the domain test and verify failure**

Run: `npm test -- --run src/domain/mission.test.ts`

Expected: FAIL because `mission.ts` does not exist.

- [ ] **Step 4: Implement the mission domain**

Define discriminated `MissionAction` values for plan, approval, start, pause, block, capability resolution, event append, change observation, evidence record, completion, revision, acceptance, rejection, failure, and cancellation. Keep the transition table exhaustive and throw `MissionTransitionError` for invalid actions.

- [ ] **Step 5: Verify the domain**

Run: `npm test -- --run src/domain/mission.test.ts`

Expected: PASS.

### Task 2: Deterministic Fixture Runtime

**Files:**
- Create: `src/domain/fixture-runtime.ts`
- Test: `src/domain/fixture-runtime.test.ts`

**Interfaces:**
- Consumes: `MissionEvent`, `Evidence`, and mission actions from `src/domain/mission.ts`.
- Produces: `createFixtureRun(missionId)` returning an async iterator of `RuntimeSignal`, and `resolveFixtureCapability(runId, decision)`.

- [ ] **Step 1: Write failing runtime tests**

Assert ordered sequence numbers, a pause at a `network` capability request, denial producing a safe fallback event, approval producing the network event, and both paths ending with one changed file plus passing test evidence.

- [ ] **Step 2: Run the runtime test and verify failure**

Run: `npm test -- --run src/domain/fixture-runtime.test.ts`

Expected: FAIL because the fixture runtime does not exist.

- [ ] **Step 3: Implement the deterministic async runtime**

Emit named signals for workspace preparation, context scan, plan execution, capability request, file change, verification, evidence, and completion. Use short deterministic delays and an abort signal. Do not use random values.

- [ ] **Step 4: Verify runtime behavior**

Run: `npm test -- --run src/domain/fixture-runtime.test.ts`

Expected: PASS.

### Task 3: Persistent Mission State

**Files:**
- Create: `src/state/mission-context.tsx`
- Test: `src/state/mission-context.test.tsx`

**Interfaces:**
- Consumes: domain constructors, reducer, and fixture runtime.
- Produces: `MissionProvider`, `useMissions()`, `create`, `updatePlan`, `approvePlan`, `start`, `resolveCapability`, `review`, `resetDemo`.

- [ ] **Step 1: Write failing provider tests**

Render a harness, create a mission, edit and approve its plan, start it, resolve the capability request, and verify serialized state is written under `orrery.missions.v1`. Remount and assert state restoration.

- [ ] **Step 2: Verify the tests fail**

Run: `npm test -- --run src/state/mission-context.test.tsx`

Expected: FAIL because the provider does not exist.

- [ ] **Step 3: Implement provider and persistence**

Use `useReducer` for application state and store only versioned serializable records. Expose intent-level methods rather than the raw dispatch function. Runtime signals must translate into domain actions.

- [ ] **Step 4: Verify provider behavior**

Run: `npm test -- --run src/state/mission-context.test.tsx`

Expected: PASS.

### Task 4: Mission Control Shell And Creation Flow

**Files:**
- Create: `src/main.tsx`
- Create: `src/components/app-shell.tsx`
- Create: `src/components/mission-list.tsx`
- Create: `src/components/new-mission-dialog.tsx`
- Create: `src/styles.css`
- Test: `src/components/components.test.tsx`

**Interfaces:**
- Consumes: `MissionProvider`, `useMissions()`, and `Mission`.
- Produces: keyboard-accessible shell, active mission selection, and mission creation dialog.

- [ ] **Step 1: Write failing creation-flow test**

Assert the empty state, open the dialog, submit title and goal, verify the mission appears in the navigator, and verify focus returns to the trigger after closing.

- [ ] **Step 2: Verify the test fails**

Run: `npm test -- --run src/components/components.test.tsx`

Expected: FAIL because UI components do not exist.

- [ ] **Step 3: Implement shell and creation UI**

Use semantic landmarks, a compact navigation rail, a mission list, and a native `dialog`. Include visible focus states and mobile layout at less than 768px. Do not render a grid of cards.

- [ ] **Step 4: Implement visual tokens and base states**

Define semantic CSS variables for dark and light mode, one amber accent, density, focus, status, radii, and layers. Honor `prefers-reduced-motion` and support a manual theme control.

- [ ] **Step 5: Verify the creation flow**

Run: `npm test -- --run src/components/components.test.tsx`

Expected: PASS for the creation scenario.

### Task 5: Plan Canvas And Runtime Timeline

**Files:**
- Create: `src/components/plan-canvas.tsx`
- Create: `src/components/runtime-timeline.tsx`
- Modify: `src/components/app-shell.tsx`
- Modify: `src/components/components.test.tsx`

**Interfaces:**
- Consumes: provider methods `updatePlan`, `approvePlan`, `start`, and `resolveCapability`.
- Produces: plan revision editing, run controls, event timeline, and scoped permission prompt.

- [ ] **Step 1: Add failing plan/run interaction tests**

Assert plan text can be edited, start is unavailable before approval, approval enables start, starting shows the isolated workspace, and the runtime pauses on a network capability request.

- [ ] **Step 2: Verify the tests fail**

Run: `npm test -- --run src/components/components.test.tsx`

Expected: FAIL at missing Plan Canvas and timeline controls.

- [ ] **Step 3: Implement Plan Canvas**

Render scope, ordered actions, and acceptance criteria as editable fields in draft/planning states and stable content after approval. Use explicit labels and contextual validation.

- [ ] **Step 4: Implement timeline and permission decision**

Render ordered semantic events. A capability request must show capability, scope, reason, and Allow once or Deny actions. Do not use a generic confirmation toast.

- [ ] **Step 5: Verify plan and runtime UI**

Run: `npm test -- --run src/components/components.test.tsx`

Expected: PASS.

### Task 6: Review Studio

**Files:**
- Create: `src/components/review-studio.tsx`
- Modify: `src/components/app-shell.tsx`
- Modify: `src/components/components.test.tsx`

**Interfaces:**
- Consumes: mission changes, evidence, completion summary, and provider `review` method.
- Produces: changes/evidence views and accept, request revision, and reject decisions.

- [ ] **Step 1: Add failing review tests**

Complete the fixture run, assert one changed file and passing evidence, request revision and verify the state, then use a fresh run to accept and verify the terminal accepted state.

- [ ] **Step 2: Verify tests fail**

Run: `npm test -- --run src/components/components.test.tsx`

Expected: FAIL because Review Studio does not exist.

- [ ] **Step 3: Implement Review Studio**

Render a changed-file list, compact diff content, evidence grouped by acceptance criterion, completion summary, and review controls. Disable review until `ready_for_review`.

- [ ] **Step 4: Verify the review flow**

Run: `npm test -- --run src/components/components.test.tsx`

Expected: PASS.

### Task 7: Browser Flow And Production Verification

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/mission-flow.spec.ts`
- Create: `.gitignore`
- Create: `README.md`

**Interfaces:**
- Consumes: completed application.
- Produces: browser-level acceptance coverage and contributor commands.

- [ ] **Step 1: Write the Playwright mission-flow test**

Create a mission, edit and approve its plan, start the fixture runtime, deny network access, wait for review readiness, inspect evidence, accept the mission, reload, and verify accepted state persists.

- [ ] **Step 2: Run the browser test and inspect the initial failure**

Run: `npm run test:e2e`

Expected: FAIL until selectors, timing, and final integration are complete.

- [ ] **Step 3: Fix integration defects without weakening assertions**

Use role and label selectors. Add stable accessible names where the UI lacks them. Do not add test-only timeouts or production branches.

- [ ] **Step 4: Document scope and commands**

README must identify this as Milestone 0, link the design and implementation plan, state that Theia integration is the next milestone, and document install, development, tests, type checking, build, and E2E commands.

- [ ] **Step 5: Run complete verification**

Run: `npm run typecheck`

Expected: PASS.

Run: `npm test -- --run`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

Run: `npm run test:e2e`

Expected: PASS in Chromium.
