# Design a modular, web-based code editor

Create a complete, high-fidelity, interactive mockup of a professional web-based code editor.

This assignment covers the product design, interface, interaction model, responsive behavior, and design handoff. Functional backend services and production integrations belong to a separate implementation assignment.

The deliverable is a runnable application that demonstrates the entire designed experience using realistic, deterministic fixture data.

## Product vision

The editor should feel cohesive, fast, precise, and comfortable for sustained development work. Use Zed as the minimum benchmark for visual polish, editing ergonomics, keyboard navigation, information density, and workspace composition.

Establish an original visual identity. Improve the experience through:
- Flexible workspaces and composable panels.
- Consistent, discoverable commands and shortcuts.
- Clear feedback about files, language services, connections, and background activity.
- Plugin-contributed features that feel native to the application.
- Deliberate tablet and phone interactions.

Demonstrate these improvements through the mockup’s behavior and design.

Web is the immediate target. The design should also accommodate eventual Electron desktop applications, iOS and Android hosts, and an embedded Paseo 0.7.0 integration. Those future targets should influence adaptability without adding native implementation work to this assignment.

## Technical scope

Use React 19.1.0, React DOM 19.1.0, and TypeScript compatible with ^5.9.3.

Use CodeMirror 6 for the editable code surface where practical so typography, selections, cursor behavior, scrolling, and editing interactions can be evaluated accurately.

Use local fixture data and mock service adapters for filesystem operations, language intelligence, Git, terminals, collaboration, and plugin management.

Basic editing, navigation, resizing, dragging, theme switching, and local UI persistence should work. Operations that require a real development environment should produce coherent simulated state transitions.

Keep fixtures and mock service behavior separate from presentation components so the implementation phase can replace them without rebuilding the interface.

Do not implement production language servers, shell execution, remote filesystem access, collaboration infrastructure, plugin execution, or authentication in this phase.

## Visual direction

Design an editor-centered workbench with restrained chrome and high information density.

Give particular attention to:
- Typography, code readability, baseline alignment, and spacing.
- The relationship between tabs, breadcrumbs, gutters, editor content, panels, and status information.
- Clear active, inactive, focused, selected, modified, and disabled states.
- Consistent icon sizing, stroke weight, labels, and shortcut presentation.
- Subtle boundaries between surfaces.
- Predictable overlay placement and stacking.
- Purposeful motion that does not delay input.

Use a coherent semantic token system for colors, typography, spacing, dimensions, borders, elevation, and motion.

Deliver equally considered dark and light themes. Communicate status through text or shape as well as color. Keep decorative gradients, oversized cards, and marketing-page patterns out of the workbench.

The default workspace should look ready for daily use, with realistic code and a deliberate arrangement of panels.

## Required interface coverage

### 1. Workspace and application shell

Design the workspace switcher, recent projects, empty workspace, project-opening flow, connection indicator, notifications, and application-level menus.

Support resizable and collapsible sidebars, bottom panels, and editor groups. Include focus mode and layout restoration.

The shell must accommodate plugin-contributed panels, tabs, commands, toolbar actions, and status items without requiring a different visual language.

### 2. Explorer and files

Include nested folders, file icons, expanded and collapsed directories, active-file tracking, modified indicators, and contextual actions.

Simulate creating, renaming, moving, and deleting files and folders. Include confirmations where an action discards content.

Design read-only files, missing files, permission failures, and externally changed files.

### 3. Editor and tabs

Include syntax highlighting, line numbers, selections, search matches, diagnostics, folding, indentation guides, and a readable active-line treatment.

Support preview tabs, pinned tabs, dirty indicators, tab reordering, horizontal and vertical editor splits, and moving files between groups.

Maintain document state when switching views. Closing a modified file must show a coherent save/discard/cancel interaction.

Include breadcrumbs, cursor position, indentation settings, language mode, and document status.

### 4. Commands and navigation

Design a command palette, quick file opening, symbol navigation, and recent-item navigation.

Show contextual command availability, fuzzy-match emphasis, keyboard selection, shortcut hints, empty results, and disabled-command explanations.

Account for macOS and Windows/Linux modifier labels.

Context menus, toolbar actions, and command-palette entries should describe the same operations consistently.

### 5. Search and replace

Include in-file search and workspace search, with case sensitivity, whole-word matching, regular expressions, and include/exclude filters.

Show grouped results, match counts, loading, cancellation, empty results, and search failures.

Selecting a result should reveal the correct file and range. Workspace replacement should include a reviewable preview and completion feedback.

### 6. Language intelligence

Mock the complete presentation of:
- Completion suggestions and documentation.
- Hover information and signature help.
- Go to definition and references.
- Rename and code actions.
- Formatting.
- Document symbols.
- Inline diagnostics and the problems panel.

Include language-server starting, ready, unavailable, restarting, and failed states.

The fixture scenarios should demonstrate a diagnostic being inspected, corrected, and removed.

### 7. Terminal, tasks, and output

Design terminal tabs and splits, active-session indicators, scrollback, search, copy/paste affordances, resizing, and session controls.

Provide simulated command input and realistic output. Include running, completed, failed, disconnected, and terminated sessions.

Design task execution and cancellation, output channels, and navigation from file references in output.

### 8. Source control and diffs

Include changed and staged files, branch information, inline and side-by-side diffs, stage/unstage actions, a commit flow, and discard confirmation.

Design empty repositories, clean working trees, failed operations, and merge-conflict presentation.

Keep filenames, code changes, diagnostics, and Git state consistent throughout the fixture project.

### 9. Preview surfaces

Include a Markdown preview with editor/preview switching and a split-view presentation.

Show how a plugin-contributed preview or custom document view would fit into the same tab and panel system.

### 10. Settings and shortcuts

Design searchable settings with user and workspace scopes, default-value indicators, reset behavior, and validation feedback.

Cover themes, editor typography, indentation, autosave, formatting, layout density, and keyboard shortcuts.

Show shortcut conflicts and an understandable remapping interaction.

Prepare interface strings for localization and layouts for longer translated labels.

### 11. Extensions and packages

Design an extension manager with installed and available packages, search, details, versions, compatibility, dependencies, permissions, configuration, and contributed features.

Simulate install, enable, disable, update, uninstall, loading, failure, and recovery states.

Demonstrate one example extension contributing a panel, a command, and a status item. Disabling it should remove those contributions coherently.

The catalog is fixture data. A production marketplace is outside this phase.

### 12. Real-time activity

Design connection status, synchronization status, collaborator presence, remote cursors, and participant labels.

Include offline, reconnecting, reconnect-failed, and recovered states.

Make local unsaved changes, saved files, and synchronized collaborative edits distinguishable.

Simulate remote changes and show how they interact with the current document and selection.

## Interaction requirements

Every visible control must have a working local interaction, a coherent simulated outcome, or an explicitly disabled state with a reason.

Keep state consistent across surfaces. For example, editing a file should update its tab, explorer entry, save state, and corresponding source-control fixture.

Provide a deterministic scenario switcher or review route that exposes important states without requiring reviewers to reproduce failures manually. Keep this review tooling separate from the normal workbench.

Use one realistic fixture project with TypeScript, TSX, JavaScript, JSON, CSS, HTML, and Markdown files. Include nested folders, meaningful diagnostics, pending changes, terminal output, and a sample extension.

The following journeys must be demonstrable:
1. Open a workspace, find a file, edit it, split the editor, save, and restore the workspace.
2. Inspect a diagnostic, navigate to its source, apply a simulated code action, and see the updated state.
3. Search across files, review replacements, and inspect the resulting diff.
4. Stage changes, enter a commit message, and complete a simulated commit.
5. Run a simulated task, inspect output, and navigate to a referenced file.
6. Enable and disable an extension and observe its contributions appear and disappear.
7. Experience a simulated connection loss and recovery without losing local edits.

## Responsive and accessible behavior

Design desktop, tablet, and phone layouts deliberately.

On narrow screens, prioritize a usable editor, navigation, and commands. Transform secondary surfaces into drawers, sheets, or focused views while retaining access to their functionality.

Account for touch targets, safe areas, virtual-keyboard space, hardware keyboards, orientation changes, and returning from an overlay to the previous selection.

Provide keyboard access, visible focus, meaningful accessible names, logical focus order, focus restoration, and reduced-motion behavior.

Validate at these reference sizes:
- Desktop: 1440 × 900.
- Tablet landscape: 1024 × 768.
- Tablet portrait: 768 × 1024.
- Phone: 390 × 844.

## Design handoff

Deliver the runnable mockup and these handoff artifacts:

- `design/README.md`: launch instructions, review routes, fixture scenarios, and the scope of simulated behavior.
- `design/tokens.json`: machine-readable design tokens, including themes and responsive values.
- `design/interaction-spec.md`: screen and state inventory, command/action IDs, triggers, transitions, keyboard behavior, persistence expectations, and error handling.
- `design/extension-surfaces.md`: named contribution locations, placement rules, sizing constraints, context availability, and appearance requirements.
- `design/screenshots/`: screenshots captured from the running mockup at the reference sizes, covering both themes and important states.

Retain reusable components, typed fixture models, and mock service boundaries in the application source.

The handoff must distinguish required implementation behavior from explicitly deferred integrations. Document each simulated service and the real capability it represents.

## Completion criteria

The assignment is complete when the entire specified experience can be reviewed in the running mockup, including secondary screens, error states, responsive layouts, and connected interaction flows.

Run the application and verify the interactions. Report checks as passed, failed, or not run, with evidence.

Finish with the completed mockup and handoff. Production functionality belongs to the next assignment.
