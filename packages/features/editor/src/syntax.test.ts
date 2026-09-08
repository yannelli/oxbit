import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { languageFor } from "./index.js";

describe("syntax remains available without a language server", () => {
  it.each([
    ["README.mdx", 'import { Button } from "./Button"\n\n# Hello\n\n<Button label={"hello"} />\n'],
    ["welcome.blade.php", '@if($user)\n<h1>{{ $user->name }}</h1>\n@endif'],
    ["App.vue", '<script setup lang="ts">const message = "hello";</script>\n<template><div>{{message}}</div></template>'],
    ["index.astro", '---\nconst message: string = "hello";\n---\n<h1>{message}</h1>\n<p>Hello</p>'],
    ["index.phtml", '<h1>Hello</h1>\n<?php function greet(string $name) { return $name; } ?>'],
    ["settings.jsonc", '{\n// comment\n"enabled": true\n}'],
    ["data.jsonl", '{"x":1}\n{"x":2}\n'],
    [".zshrc", 'setopt extendedglob\nfiles=(**/*.ts(N))\nfunction hello() { print hello; }'],
    ["Cargo.lock", 'version = 4\n[[package]]\nname = "test"\n'],
    ["Dockerfile.prod", 'FROM ubuntu:24.04\nRUN echo hello\n'],
    ["data.csv", 'name,notes\n"Ryan","hello\nworld"\n'],
    [".env.local", 'PORT=3000\nHOST="localhost"\n'],
    ["x.ini", '[server]\nport=3000\n'],
    ["x.xml", '<?xml version="1.0"?><root><item/></root>'],
    ["x.log", '2026-09-07T12:00:00Z ERROR src/main.ts:12:3'],
  ])("parses %s and survives a subsequent edit", (path, doc) => {
    const state = EditorState.create({ doc, extensions: [languageFor(path)] });
    expect(ensureSyntaxTree(state, doc.length, 1000)?.length).toBe(doc.length);
    const edited = state.update({ changes: { from: 0, insert: "\n" } }).state;
    expect(ensureSyntaxTree(edited, edited.doc.length, 1000)?.length).toBe(edited.doc.length);
  });
});
