# Mission Control TUI

Framework-free Mission Control view state plus an isolated OpenTUI renderer. The first slice is read-mostly: select, refresh, inspect, subscribe or unsubscribe, and quit.

The view model and lifecycle tests run with the repository toolchain without loading native code. Running `runTui` requires Node.js 26.4.0 or newer with ESM and `--experimental-ffi`, as required by `@opentui/core@0.5.9`. OpenTUI is loaded dynamically only when `runTui` starts.
