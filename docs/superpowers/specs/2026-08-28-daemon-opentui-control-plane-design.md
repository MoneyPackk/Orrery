# Orrery Daemon And OpenTUI Control Plane

## Scope

The daemon is the local control-plane boundary for terminal Mission Control. It
owns one authenticated loopback socket, publishes endpoint metadata for local
clients, and exposes validated mission snapshots and event notifications. The
terminal client consumes protocol DTOs; it does not receive Git, filesystem,
process, provider, or arbitrary IPC primitives.

This is a read-mostly first slice. The available operations are authentication,
mission listing, mission inspection, event subscription, event unsubscription,
and ping. Guarded mutation commands are a subsequent slice and must preserve
the kernel's approval, evidence, and promotion invariants before being exposed.

## Local Trust Model

The daemon is intended for one local user session, not as a network service. It
binds only to numeric loopback (`127.0.0.1` or `::1`) on an ephemeral TCP port.
Non-loopback binding is rejected. Loopback reachability is therefore treated as
necessary but not sufficient for trust: every connection must authenticate with
the daemon-generated capability token before it can issue control-plane
requests.

The runtime directory, endpoint metadata, startup lock, and token are kept in
the OS-local Orrery runtime directory. The directory and files are private to
the current user where the platform supports permissions or ACLs. Endpoint
metadata contains the loopback host, ephemeral port, protocol version, token
path, process ID, and instance ID; it never contains the raw token. Clients
read the token from the private token file and send it only in the `hello`
request. The daemon verifies the fixed-length token with a constant-time
comparison.

The socket parser treats input as untrusted. It bounds line and outbound
buffer sizes, validates the protocol version, request IDs, message shape, and
request ordering, rejects duplicate request IDs, and closes malformed or idle
connections. The daemon returns validated DTOs and does not execute strings
received from a client.

## Endpoint And Token Lifecycle

An explicit `npm run daemon` acquires the per-runtime startup lock, creates a
fresh token, starts the authenticated server, and atomically publishes endpoint
metadata only after the socket is listening. A daemon stop removes its token
and its matching endpoint metadata. A stale lock or endpoint can be cleaned up
only when its recorded process or instance no longer owns the state.

`npm run tui` is the companion mode. It first probes the published endpoint,
reuses a ready daemon when one exists, and otherwise acquires the startup lock,
starts one private daemon child, waits for authenticated readiness, and stops
only that child when the TUI exits. Concurrent companions converge on the same
daemon rather than starting duplicates.

`npm run tui:standalone` is the standalone mode. It requires a ready,
authenticated endpoint and fails with an instruction to start `npm run daemon`
when none is available. It never starts, stops, or cleans up the daemon.

The protocol identifier is `mission-control.v1`. Version and message
validation are part of the wire contract; a future incompatible protocol must
use a new version rather than silently changing the v1 shapes.

## Events And Replay

The first event subscription is explicitly `live_only`. `afterSequence` is
retained as subscription cursor metadata and event delivery is sequence ordered
for events observed after the subscription becomes active, but the daemon does
not persist or replay missed events. A client that connects after an event, or
observes a sequence gap, must treat the gap as unknown history and refresh the
mission snapshot; it must not infer the missing transitions. Durable replay is
deferred until an event log and replay contract are added.

## Runtime And Launching

The repository scripts are the supported entrypoints:

```text
npm run daemon
npm run tui
npm run tui:standalone
```

The native OpenTUI renderer requires Node.js 26.4.0 or newer and the
`--experimental-ffi` runtime flag. OpenTUI is loaded only by the terminal
entrypoint, so browser and Electron bundles remain independent of native
OpenTUI. Protocol, lifecycle, and view-model tests use injected transports or
fake renderers and do not require native terminal rendering.

The current daemon launcher injects an empty `MissionRegistry` backed by
read-only `list` and `get` functions. This is deliberate scaffolding, not a
claim that the daemon already owns or discovers the browser's durable mission
records. Wiring the registry and event source to the real mission persistence
and kernel lifecycle is follow-up work. The daemon must remain the control
plane boundary when that wiring is added.

SSH transport is deferred. The protocol message types remain transport-neutral
so a later authenticated SSH adapter can reuse them, but this slice provides
loopback TCP only and makes no remote-host, forwarding, or SSH trust claims.

## Release Gates And Artifacts

Documentation changes must pass the repository's typecheck, unit tests,
production build, desktop build, browser E2E flow, real mission smoke, audit,
and whitespace checks. The desktop artifacts produced by the current builder
are unsigned. They are useful for local validation only and are not evidence
of signing, publication readiness, update configuration, or release
credentials.

## Boundaries

- The daemon owns local protocol authentication, endpoint lifecycle, and the
  control-plane connection lifecycle.
- The injected registry owns the snapshots returned by the first slice; it is
  currently read-only and empty in the launcher.
- The mission kernel owns isolated execution, evidence, review, and promotion;
  those capabilities are not exposed through the first daemon protocol.
- The TUI owns terminal rendering and user navigation, not mission authority.
- The browser and Electron renderer retain their existing fixture-backed
  behavior and do not import OpenTUI.
