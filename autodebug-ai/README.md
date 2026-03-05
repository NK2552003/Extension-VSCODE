# AutoDebug AI

**Intelligent debugging and code-quality assistant for Visual Studio Code**

> Version 1.1.0 · VS Code `^1.90.0` · TypeScript 5.3

AutoDebug AI monitors your editor in real time, explains every error in plain English, traces root causes through your entire codebase, detects performance anti-patterns, integrates with Git blame, and can intelligently decompose large source files into focused modules — all without leaving VS Code.

---

## Table of Contents

- [AutoDebug AI](#autodebug-ai)
  - [Table of Contents](#table-of-contents)
  - [How It Works — Overview](#how-it-works--overview)
  - [Installation \& Setup](#installation--setup)
  - [AI Backends](#ai-backends)
    - [1. GitHub Copilot (VS Code LM API)](#1-github-copilot-vs-code-lm-api)
    - [2. GitHub Models (REST API)](#2-github-models-rest-api)
    - [3. Pattern Knowledge Base (Offline Fallback)](#3-pattern-knowledge-base-offline-fallback)
  - [Features](#features)
    - [1. Real-Time Error Analysis](#1-real-time-error-analysis)
    - [2. AI Error Summarization](#2-ai-error-summarization)
    - [3. Root Cause Tracing](#3-root-cause-tracing)
    - [4. Stack Trace Cleaning](#4-stack-trace-cleaning)
    - [5. AI Debug Chat](#5-ai-debug-chat)
    - [6. Performance Analyzer](#6-performance-analyzer)
    - [7. Git Blame Integration](#7-git-blame-integration)
    - [8. Error Heatmap](#8-error-heatmap)
    - [9. Hover Explanations](#9-hover-explanations)
    - [10. Code Actions \& Quick Fixes](#10-code-actions--quick-fixes)
    - [11. ASTra Module Splitter](#11-astra-module-splitter)
      - [How It Works](#how-it-works)
      - [The 7-Tab Report](#the-7-tab-report)
      - [Parse Engine](#parse-engine)
      - [Workspace Context Scanning](#workspace-context-scanning)
  - [Commands](#commands)
  - [Configuration](#configuration)
    - [General](#general)
    - [Module Splitter (ASTra)](#module-splitter-astra)
  - [Architecture](#architecture)
  - [Extending the Extension](#extending-the-extension)
    - [Add a new error pattern (offline KB)](#add-a-new-error-pattern-offline-kb)
    - [Add a new performance anti-pattern](#add-a-new-performance-anti-pattern)
    - [Support a new language in hover / code actions](#support-a-new-language-in-hover--code-actions)
    - [Add a new AI provider](#add-a-new-ai-provider)
    - [Add a new ASTra region kind](#add-a-new-astra-region-kind)

---

## How It Works — Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        VS Code Editor                           │
│                                                                 │
│  Diagnostics change  ──► errorParser.ts  ──► ParsedError        │
│                                │                                │
│                                ▼                                │
│                       errorSummarizer.ts                        │
│                                │                                │
│                                ▼                                │
│                         aiService.ts                            │
│                         ┌──────┴──────────────────┐            │
│                    llmService.ts              Pattern KB        │
│               ┌─────────┴─────────┐         (offline)          │
│         Copilot LM API    GitHub Models                         │
│         (gpt-4o)          (REST API)                            │
│                                │                                │
│                                ▼                                │
│                       sidebarProvider.ts  ──► dashboard.html    │
└─────────────────────────────────────────────────────────────────┘
```

When diagnostics change the extension debounces 600 ms, normalises every error into a `ParsedError`, runs AI analysis, and pushes results to the persistent sidebar webview. Everything uses `--vscode-*` CSS variables so the UI automatically adapts to your current VS Code theme (dark, light, high-contrast).

---

## Installation & Setup

1. **Clone / open** the `autodebug-ai` folder in VS Code.
2. Run `npm install` in the `autodebug-ai` directory.
3. Press **F5** to launch an **Extension Development Host** window.
4. The AutoDebug AI icon appears in the Activity Bar. Click it to open the sidebar.

> For a production install, package with `vsce package` and install the resulting `.vsix`.

**Prerequisites**

| Requirement | Notes |
|---|---|
| Node.js ≥ 18 | Build only |
| VS Code ≥ 1.90.0 | Runtime |
| GitHub Copilot subscription | Optional — improves AI quality |
| Signed-in GitHub account in VS Code | Required for GitHub Models fallback |

---

## AI Backends

AutoDebug AI tries three backends in priority order.

### 1. GitHub Copilot (VS Code LM API)

Uses `vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' })`. Requires an active Copilot subscription. Responses are streamed chunk-by-chunk and assembled into a single structured JSON answer.

**When used:** Copilot is installed and the user is signed in.

### 2. GitHub Models (REST API)

Calls `https://models.inference.ai.azure.com/chat/completions` with `gpt-4o` using the GitHub OAuth token already present in VS Code (`vscode.authentication.getSession`). No separate API key is needed.

**When used:** Copilot is unavailable but the user is signed into GitHub in VS Code.

### 3. Pattern Knowledge Base (Offline Fallback)

Twelve hand-crafted regex patterns cover the most common JS/TS/React errors:

- `TypeError: Cannot read properties of undefined/null`
- `TypeError: X is not a function`
- `ReferenceError: X is not defined`
- `SyntaxError: Unexpected token`
- `TypeError: .map is not a function`
- React: Invalid Hook Call
- React: Maximum update depth exceeded
- `UnhandledPromiseRejection`
- `Module not found / Cannot find module`
- TypeScript: `Type X is not assignable to type Y`
- TypeScript: `Property X does not exist on type Y`
- General network / CORS errors

**When used:** Neither Copilot nor GitHub is available (fully offline).

The active backend is shown in the VS Code status bar (bottom-left).

---

## Features

### 1. Real-Time Error Analysis

**Trigger:** Any change to VS Code diagnostics (TypeScript errors, ESLint warnings, etc.)

The extension:
1. **Debounces** 600 ms so rapid keystrokes do not cause thrashing.
2. **Filters** errors and warnings up to the `maxErrorsToTrack` limit (default 100).
3. **Normalises** each `vscode.Diagnostic` into a `ParsedError` with a stable cache key, severity, source (`ts`, `eslint`, …), and any embedded stack frames.
4. **Sends** each error for AI analysis.
5. **Updates** the sidebar webview in real time.

To disable, set `autodebug.enableRealTimeAnalysis` to `false`.

---

### 2. AI Error Summarization

**Command:** `AutoDebug: Summarize Error` (right-click menu or Command Palette)  
**File:** `src/services/aiService.ts`

For each error the service:

1. Checks an **in-memory cache** keyed by `message::file::line`.
2. Sends a structured prompt to the active AI backend requesting JSON with keys: `errorType`, `explanation`, `possibleCause`, `suggestedFix`, `codeExample`, `documentationLinks`, `confidence`.
3. The first 600 characters of the surrounding source code are included as context.
4. Falls back to the Pattern KB if the LLM is unavailable or returns malformed JSON.

**Result shown in the sidebar Errors tab:**
- Plain-English explanation of the error
- Most likely cause
- Suggested one-line fix
- Runnable code example
- Links to relevant documentation
- Confidence percentage

---

### 3. Root Cause Tracing

**Command:** `AutoDebug: Find Root Cause` (right-click menu or Command Palette)  
**File:** `src/modules/rootCauseAnalyzer.ts`

1. Scans the workspace for relevant source files via `workspaceScanner`.
2. Builds a prompt containing the error **plus up to 3 relevant file snippets** (60 lines each).
3. Asks the LLM: *"Where in this codebase does this error originate, and what is the call chain?"*
4. Falls back to a heuristic approach when no LLM is available:
   - Follows the stack trace to the deepest non-library workspace frame.
   - Cross-references variable and symbol names across files.
   - Reports a call chain with `file:line` positions.

**Result opens in a Webview panel** (beside the editor) with:
- Root file + line highlighted
- Call chain breakdown
- Confidence colour-coded: **green ≥ 75%**, **orange ≥ 40%**, **red < 40%**

---

### 4. Stack Trace Cleaning

**File:** `src/modules/stackTraceCleaner.ts`

Automatically filters raw Node.js / browser stack traces:

| Step | What Happens |
|---|---|
| Library filter | Removes all `node_modules` frames (toggleable) |
| Internals filter | Removes `node:internal/`, `timers.js`, `process.nextTick`, etc. |
| Deduplication | Removes consecutive identical frames |
| Relative paths | Converts absolute paths to workspace-relative for readability |
| Depth grouping | Groups remaining frames by call depth |

The cleaned stack appears in the sidebar and in any root cause / summarization panel.

---

### 5. AI Debug Chat

**Location:** Chat tab in the AutoDebug AI sidebar  
**File:** `src/modules/debugAssistant.ts`

Maintains a **bounded conversation history** (last 20 messages). Each query:

1. Injects the currently selected error as system context.
2. Appends the conversation history.
3. Sends your question to the active AI backend.
4. Renders the response with basic Markdown (bold, inline code, links).

**Starter suggestions** are auto-generated from the selected error:
- *"Why is this TypeError happening?"*
- *"How do I fix the error in `file.ts`?"*
- *"What is the root cause?"*

---

### 6. Performance Analyzer

**Command:** `AutoDebug: Analyze Performance` (right-click menu or Command Palette)  
**File:** `src/modules/performanceAnalyzer.ts`

Scans the **active file** for 10 performance anti-patterns:

| Pattern | Severity | What It Detects |
|---|---|---|
| Missing `useEffect` deps | High | `useEffect(fn)` with no dependency array |
| `forEach` + `push` anti-pattern | Medium | `.forEach(x => arr.push(…))` — use `.map()` |
| Large array allocation | High | `new Array(N)` where N > 10 000 |
| `setInterval` leak | High | `setInterval` without a cleanup `return` |
| Event listener leak | High | `addEventListener` without matching `removeEventListener` |
| JSON deep-clone | Medium | `JSON.parse(JSON.stringify(…))` |
| Unbounded `Promise.all` | Critical | `Promise.all(largeArray.map(…))` |
| Direct DOM manipulation in React | Medium | `document.getElementById` inside a React component |
| Full module `require` | Medium | `require('lodash')` instead of named imports |
| Infinite loop risk | Critical | `while (true)` with no visible `break` |

Also computes **cyclomatic complexity** (decision point count) and colour-codes it:
- **Green < 5** — Simple
- **Orange 5–9** — Moderate
- **Red ≥ 10** — Complex; refactor recommended

Results are shown in a rich Webview panel.

---

### 7. Git Blame Integration

**Command:** `AutoDebug: Show Git Blame for Line` (right-click menu or Command Palette)  
**File:** `src/modules/gitBlameAnalyzer.ts`

Uses `git blame --porcelain -L N,N <file>` under the hood. Returns:
- Commit hash (short)
- Author name and email
- Commit date (ISO format)
- Commit summary message

Right-clicking any line and selecting **Show Git Blame** displays a notification:

> *"Line 42 last changed by Jane Doe on 2025-11-10 — fix: handle null user response"*

`blameFile()` returns blame info for every line — used in the root cause panel to show who last touched the flagged lines.

---

### 8. Error Heatmap

**Command:** `AutoDebug: Show Error Heatmap`  
**File:** `src/services/workspaceScanner.ts`

Tracks error + warning counts per file across all open documents. Updated every time diagnostics change. Displayed in the **Heatmap tab** of the sidebar as proportional bars styled with a red-to-green gradient (more errors = deeper red).

`getTopErrorFiles()` returns the 20 files with the highest combined `errorCount + warningCount`.

---

### 9. Hover Explanations

**File:** `src/providers/hoverProvider.ts`  
**Supported languages:** TypeScript, JavaScript, Python, Java, C#, Go, Rust, PHP, TSX, JSX

Hovering over an error-underlined token looks up the cached `ParsedError` for that `file + line` and returns a `MarkdownString` containing:
- Error type and raw message
- AI-generated explanation
- Suggested fix
- Documentation links
- Confidence percentage

---

### 10. Code Actions & Quick Fixes

**File:** `src/providers/codeActionProvider.ts`

Provides VS Code **Quick Fix** lightbulb actions on any error line:

| Action | What It Does |
|---|---|
| **Apply Fix** | Inserts the AI-suggested replacement at the error position, preserving current indentation |
| **Find Root Cause** | Opens the root cause Webview panel for this error |
| **Ask AI** | Focuses the sidebar chat with the error pre-selected |

---

### 11. ASTra Module Splitter

**Command:** `AutoDebug: Split Module (ASTra v2)` (right-click menu or Command Palette)  
**File:** `src/modules/moduleSplitter.ts` · `src/parsers/astParser.ts`

ASTra analyses a large source file and produces a **dry-run decomposition plan** — a full HTML report showing exactly which regions should move to which new files, without writing anything to disk.

#### How It Works

```
Active file (source code)
        │
        ▼
  astParser.ts  (TypeScript Compiler API for .ts/.tsx/.js/.jsx)
  ─────────────────────────────────────────────────────────────
  ts.createSourceFile()  →  walk AST nodes
  classifies each top-level declaration:
    • component   (JSX return)
    • hook        (useXxx + hook calls)
    • util        (pure function)
    • type        (interface / type alias / enum)
    • class       (class declaration)
    • constant    (top-level const)
  Falls back to bracket-depth heuristic for non-TS/JS languages.
        │
        ▼
  moduleSplitter.ts  ( analyse() )
  ─────────────────────────────────────────────────────────────
  1. Score each region for lines, complexity,
     code smells, and coupling
  2. Build type-routing map (reuse existing types.ts / interfaces.ts)
  3. Compute linkage graph (which regions import which)
  4. Generate test stubs for each extracted region
  5. Generate barrel export index.ts
  6. Return SplitPlan (dry run — nothing written)
        │
        ▼
  buildHtmlReport( SplitPlan )
  ─────────────────────────────────────────────────────────────
  7-tab Webview report (styled to match the error detection sidebar)
```

#### The 7-Tab Report

| Tab | Contents |
|---|---|
| **Overview** | File stats, parse engine badge, total regions, smells, high-complexity regions |
| **Regions** | Each detected code region with kind, line range, line count, complexity, smell flags, and proposed output file |
| **Type Routing** | Inline `interface` / `type` / `enum` declarations with the existing or new file they should move to |
| **Linkage** | Which regions depend on which other regions — helps sequence the extraction |
| **Test Stubs** | Auto-generated `describe` / `it` skeleton for each extracted region |
| **Barrel Export** | Ready-to-paste `index.ts` that re-exports every extracted module |
| **Raw Plan** | Full `SplitPlan` JSON for tooling integration |

#### Parse Engine

| Engine | Trigger | Accuracy |
|---|---|---|
| `typescript-ast` | `.ts`, `.tsx`, `.js`, `.jsx` | 100% — uses `ts.createSourceFile()` |
| `bracket-depth-fallback` | All other languages | Heuristic — approximation |

The active engine is shown as a badge in the report header. Configurable via `autodebug.moduleSplitter.parseEngine`.

#### Workspace Context Scanning

Before analysis, the command scans your workspace for:
- Existing `types.ts` / `interfaces.ts` / `*.d.ts` files (for type routing)
- Existing hook files (`hooks/use*.ts`)
- Utility files (`utils/*.ts`)
- Barrel index files (`index.ts`)

This ensures suggested output paths integrate with your existing file structure rather than creating duplicates.

**Supported file types:** `.ts` `.tsx` `.js` `.jsx` `.py` `.java` `.cs` `.go` `.rs` `.php`

---

## Commands

All commands are accessible via the **Command Palette** (`Cmd+Shift+P`) and most are also in the **editor right-click context menu**.

| Command | Context Menu | Description |
|---|---|---|
| `AutoDebug: Summarize Error` | ✓ (requires selection) | Summarize the error near the cursor using AI |
| `AutoDebug: Explain Selected Code` | ✓ (requires selection) | Explain a selected code block in plain English |
| `AutoDebug: Find Root Cause` | ✓ | Trace the root cause of the error at the cursor |
| `AutoDebug: Open Dashboard` | — (title bar) | Focus the AutoDebug AI sidebar |
| `AutoDebug: Clear All Errors` | — | Clear cached errors and reset the sidebar |
| `AutoDebug: Show Error Heatmap` | — | Display top-error files in a notification |
| `AutoDebug: Analyze Workspace` | — | Scan all workspace files for errors |
| `AutoDebug: Analyze Performance` | ✓ | Detect performance anti-patterns in the active file |
| `AutoDebug: Show Git Blame for Line` | ✓ | Show who last modified the current line |
| `AutoDebug: Split Module (ASTra v2)` | ✓ | Run the ASTra module decomposition analysis |

---

## Configuration

Open **Settings → AutoDebug AI** or edit `settings.json` directly.

### General

| Setting | Type | Default | Description |
|---|---|---|---|
| `autodebug.enableRealTimeAnalysis` | boolean | `true` | Analyse errors as diagnostics change |
| `autodebug.maxErrorsToTrack` | number | `100` | Maximum errors processed at one time |
| `autodebug.filterLibraryFrames` | boolean | `true` | Remove `node_modules` frames from stack traces |
| `autodebug.enableHeatmap` | boolean | `true` | Track per-file error counts |
| `autodebug.clusterSimilarErrors` | boolean | `true` | Group errors of the same type |
| `autodebug.aiBackend` | enum | `"auto"` | Force a backend: `auto` \| `copilot` \| `github-models` \| `pattern-kb` |

### Module Splitter (ASTra)

| Setting | Type | Default | Description |
|---|---|---|---|
| `autodebug.moduleSplitter.minLinesForExtraction` | number | `15` | Minimum region size before it is flagged for extraction |
| `autodebug.moduleSplitter.complexityThreshold` | number | `10` | Cyclomatic complexity above which a region is flagged |
| `autodebug.moduleSplitter.enableTypeRouting` | boolean | `true` | Route inline types to existing `types.ts` / `interfaces.ts` files |
| `autodebug.moduleSplitter.parseEngine` | enum | `"auto"` | Override parse engine: `auto` \| `typescript-ast` \| `bracket-depth` |

---

## Architecture

```
src/
├── extension.ts                 Activation, command wiring, status bar, diagnostic listener
├── parsers/
│   ├── errorParser.ts           vscode.Diagnostic → ParsedError
│   └── astParser.ts             TypeScript Compiler API → ASTRegion[]  (ASTra)
├── services/
│   ├── llmService.ts            AI gateway: Copilot → GitHub Models → Pattern KB
│   ├── aiService.ts             High-level AI ops: summarize, rootCause, fix, chat
│   └── workspaceScanner.ts      File index + error heatmap tracker
├── modules/
│   ├── errorSummarizer.ts       Batched error summarization with caching
│   ├── rootCauseAnalyzer.ts     Root cause tracing with workspace context
│   ├── stackTraceCleaner.ts     Stack trace filtering and formatting
│   ├── debugAssistant.ts        Chat session with bounded history
│   ├── gitBlameAnalyzer.ts      git blame wrapper (per-line and per-file)
│   ├── performanceAnalyzer.ts   10 anti-pattern detectors + cyclomatic complexity
│   └── moduleSplitter.ts        ASTra analysis engine + 7-tab HTML report builder
├── providers/
│   ├── hoverProvider.ts         Error explanations on hover
│   ├── codeActionProvider.ts    Quick Fix code actions
│   └── sidebarProvider.ts       Webview sidebar controller
├── commands/
│   ├── summarizeError.ts        Command: summarize selected error text
│   ├── explainCode.ts           Command: explain selected code block
│   └── splitModule.ts           Command: run ASTra on active file
├── utils/
│   ├── logger.ts                Structured logger → AutoDebug AI output channel
│   └── fileUtils.ts             File reading helpers
└── webview/
    └── dashboard.html           Sidebar UI (HTML/CSS/JS, VS Code theme variables)
```

**Key design decisions:**
- **Zero external runtime dependencies** — only `typescript` (for the AST parser) plus the VS Code API.
- **Single AI gateway** in `llmService.ts` — swap backends without touching any feature code.
- **In-memory caching** for error summaries — same error is never sent to the LLM twice per session.
- **Dry-run only** for ASTra — the module splitter never writes files, it only produces a plan.
- **CSP-safe webview** — `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'` with no external resource loading.

---

## Extending the Extension

### Add a new error pattern (offline KB)

In `src/services/aiService.ts`, append to the `PATTERN_KB` array:

```typescript
{
    pattern: /your error regex here/i,
    type: 'ErrorType',
    explanation: 'What this error means in plain English.',
    cause: 'Why it typically occurs.',
    fix: 'How to fix it.',
    example: '// before\nconst bad = ...\n// after\nconst good = ...',
    docs: ['https://developer.mozilla.org/...']
}
```

### Add a new performance anti-pattern

In `src/modules/performanceAnalyzer.ts`, append to the `PATTERNS` array:

```typescript
{
    name: 'Pattern Name',
    regex: /your detection regex/gi,
    description: 'What this pattern detects.',
    fix: 'Recommended replacement.',
    severity: 'high' as const   // 'critical' | 'high' | 'medium' | 'low'
}
```

### Support a new language in hover / code actions

In `src/extension.ts`, add to the `allLanguages` array:

```typescript
{ scheme: 'file', language: 'ruby' }
```

### Add a new AI provider

In `src/services/llmService.ts`:
1. Add a `sendViaMyProvider()` method.
2. Call it in the `send()` method waterfall after the existing providers.

### Add a new ASTra region kind

In `src/parsers/astParser.ts`, update the `classifyName()` function with the new naming convention rules. Add the kind to the `RegionKind` union type and update the routing logic in `src/modules/moduleSplitter.ts`.

---

*Built with TypeScript + VS Code Extension API · AutoDebug AI v1.1.0*
