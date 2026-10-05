# @oxbit/cli

The `oxbit` command for [Oxbit](https://github.com/yannelli/oxbit). It starts a
runtime for a project and opens the editor in your browser.

Requires Node 24 on macOS or Linux, with Git and ripgrep (`rg`) on `PATH`. On
Linux, npm builds the terminal addon, which needs Python, make, and a C++ compiler.

```sh
npm install -g @oxbit/cli
oxbit                     # Open the current directory
oxbit ~/code/my-project   # Open a project
oxbit --help              # Show all options
```

If you installed `oxbit` from a checkout with `bun run install:global`, run
`npm uninstall -g oxbit` first.

See the [README](https://github.com/yannelli/oxbit#readme) and
[runtime configuration](https://github.com/yannelli/oxbit/blob/main/docs/runtime.md).
