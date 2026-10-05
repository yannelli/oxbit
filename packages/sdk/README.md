# @oxbit/sdk

Types and helpers for [Oxbit](https://github.com/yannelli/oxbit) extensions.

```sh
npm install @oxbit/sdk
```

```ts
import type { Extension } from "@oxbit/sdk";

export default {
  manifest: {
    manifestVersion: 1,
    id: "example.hello",
    name: "Hello",
    version: "1.0.0",
    sdk: "^1.0.0",
    environments: ["browser", "embedded"],
    activation: ["onCommand:hello.show"],
    capabilities: [],
  },
  activate(ctx) {
    ctx.commands.register({ id: "hello.show", title: "Hello: Show", run: () => "Hello" });
  },
} satisfies Extension;
```

The package is ESM. Install `@types/react` to type-check React contributions.
See the [extension SDK guide](https://github.com/yannelli/oxbit/blob/main/docs/sdk.md).
