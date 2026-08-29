# Mission Control Domain Extraction Seam

This directory reserves the package `@orrery/mission-control-domain`. The current implementation remains under `src/domain` for Milestone 1; extraction will move those contracts and pure behaviors without changing their semantics.

The package boundary will contain mission entities, validated transitions, review-readiness invariants, deterministic fixture-runtime events, and their tests. Persistence, React providers/components, Electron IPC, Theia widgets, filesystem access, process execution, and workspace services remain adapters outside this package.

## Dependency Rule

`@orrery/mission-control-domain` must have no Theia dependencies, including dev or peer dependencies, and must not import from any `@theia/*` package. It also has no Electron, React, DOM, Node filesystem, or process dependency. Consumers inject clocks, identifiers, persistence, and runtime capabilities through typed inputs so the domain remains deterministic and usable by the standalone browser shell, Electron, and the future `@orrery/mission-control-theia` extension.
