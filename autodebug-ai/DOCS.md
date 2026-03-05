# AutoDebug AI — Complete Documentation

**Version:** 1.0.0  
**VS Code Engine:** `^1.90.0`  
**Language:** TypeScript 5.3  
**Build:** `tsc -p ./` → `out/`

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [AI Backends](#ai-backends)
4. [Features](#features)
   - [Real-Time Error Analysis](#1-real-time-error-analysis)
   - [AI-Powered Error Summarization](#2-ai-powered-error-summarization)
   - [Root Cause Tracing](#3-root-cause-tracing)
   - [Stack Trace Cleaning](#4-stack-trace-cleaning)
   - [AI Debug Assistant Chat](#5-ai-debug-assistant-chat)
   - [Performance Analyzer](#6-performance-analyzer)
   - [Git Blame Integration](#7-git-blame-integration)
   - [Error Heatmap](#8-error-heatmap)
   - [Hover Provider](#9-hover-provider)
   - [Code Actions (Quick Fixes)](#10-code-actions-quick-fixes)
5. [Commands](#commands)
6. [Configuration](#configuration)
7. [File Structure](#file-structure)
8. [How It Was Built](#how-it-was-built)
9. [Extending the Extension](#extending-the-extension)

---

## Overview

AutoDebug AI is a VS Code extension that provides intelligent, AI-powered debugging assistance directly in your editor. It monitors diagnostics in real time, classifies and explains errors, traces root causes, detects performance anti-patterns, and lets you chat with an AI assistant about any error — all without leaving VS Code.

**Key capabilities:**
- Connects to **GitHub Copilot** (via VS Code LM API) or **GitHub Models** (REST API) for LLM-powered analysis
- Falls back to a curated **Pattern Knowledge Base** when no AI token is available
- Displays results in a persistent sidebar webview with Lucide SVG icons
- Zero external runtime dependencies (pure TypeScript + VS Code API)

---

## Architecture

```
src/
├── extension.ts              — Activation, wiring, status bar, commands
├── parsers/
│   └── errorParser.ts        — Convert vscode.Diagnostic → ParsedError
├── services/
│   ├── llmService.ts         — AI gateway (Copilot → GitHub Models → fallback)
│   ├── aiService.ts          — High-level AI operations (summarize, rootcause, fix, chat)
│   └── workspaceScanner.ts   — Workspace file indexing and heatmap tracking
├── modules/
│   ├── errorSummarizer.ts    — Batched error summarization with caching
│   ├── rootCauseAnalyzer.ts  — Root cause analysis orchestration
│   ├── stackTraceCleaner.ts  — Stack trace filtering and formatting
│   ├── debugAssistant.ts     — Chat session management
│   ├── gitBlameAnalyzer.ts   — Git blame integration (per-line and per-file)
│   └── performanceAnalyzer.ts — 10 performance anti-pattern detectors
├── providers/
│   ├── hoverProvider.ts      — Error explanations on hover
│   ├── codeActionProvider.ts — Quick Fix code actions
│   └── sidebarProvider.ts    — Webview sidebar controller
├── commands/
│   ├── summarizeError.ts     — Command: summarize selected error
│   └── explainCode.ts        — Command: explain selected code
├── utils/
│   ├── logger.ts             — Structured logger with output channel
│   └── fileUtils.ts          — File reading utilities
└── webview/
    └── dashboard.html        — Full sidebar UI (HTML/CSS/JS, Lucide SVG icons)
```

**Data flow:**

```
vscode.Diagnostic events
        ↓
  errorParser.ts        → ParsedError (normalized, with ID)
        ↓
  errorSummarizer.ts    → calls aiService.summarizeError()
        ↓
  aiService.ts          → llmService.send() [Copilot / GitHub Models / Pattern KB]
        ↓
  sidebarProvider.ts    → postMessage() → dashboard.html renders result
```

---

## AI Backends

AutoDebug AI tries three backends in order:

### 1. GitHub Copilot (VS Code LM API)

**API:** `vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' })`  
**Requires:** GitHub Copilot subscription, signed into VS Code  
**How it works:**
```typescript
const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
const response = await models[0].sendRequest(messages, {}, cancellationToken);
for await (const chunk of response.text) { text += chunk; }
```
The `sendRequest` call streams the response. The extension accumulates all chunks into a single string.

### 2. GitHub Models (REST API)

**Endpoint:** `https://models.inference.ai.azure.com/chat/completions`  
**Model:** `gpt-4o`  
**Auth:** Acquired via `vscode.authentication.getSession('github', ['read:user'], { silent: true })`  
**How it works:**
```typescript
const session = await vscode.authentication.getSession('github', ['read:user'], { silent: true });
// Uses session.accessToken as Bearer token for OpenAI-compatible REST call
```
This uses the GitHub account already signed into VS Code — **no separate API key needed**.

### 3. Pattern Knowledge Base (Offline Fallback)

12 built-in regex patterns covering the most common JS/TS/React errors:
- `TypeError: Cannot read properties of undefined/null`
- `TypeError: is not a function`
- `ReferenceError: is not defined`
- `SyntaxError: Unexpected token`
- `TypeError: .map is not a function`
- React: Invalid Hook Call, Maximum update depth exceeded
- `UnhandledPromiseRejection`
- `Module not found / Cannot find module`
- TypeScript: `Type X is not assignable`, `Property does not exist on type`

---

## Features

### 1. Real-Time Error Analysis

**File:** `src/extension.ts` (diagnostic listener)  
**Trigger:** `vscode.languages.onDidChangeDiagnostics`

Every time diagnostics change (TypeScript errors, ESLint warnings, etc.), the extension:
1. Debounces 600ms to avoid thrashing
2. Filters errors and warnings (up to `maxErrorsToTrack`, default 100)
3. Passes each diagnostic through `errorParser.ts` → `ParsedError`
4. Sends to `errorSummarizer.ts` for AI analysis
5. Updates the sidebar webview

**ParsedError shape:**
```typescript
interface ParsedError {
  id: string;           // MD5-like hash for cache key
  type: string;         // "TypeError", "SyntaxError", etc.
  message: string;      // Raw error message
  file: string;         // Absolute path
  relativeFile: string; // Workspace-relative
  line: number;
  column: number;
  severity: 0|1|2;      // Error, Warning, Info
  source: string;       // "ts", "eslint", etc.
  stackTrace: StackFrame[];
}
```

### 2. AI-Powered Error Summarization

**File:** `src/services/aiService.ts`  
**Method:** `aiService.summarizeError(error, surroundingCode)`

For each error, the service:
1. Checks an in-memory cache (keyed by `message::file::line`)
2. Calls `llmService.send()` with a structured JSON-requesting prompt
3. Parses the LLM's JSON response into an `ErrorSummary`
4. Falls back to pattern KB if LLM is unavailable or response is malformed

**Prompt format (sent to LLM):**
```
Return ONLY valid JSON with these keys:
{"errorType":"","explanation":"","possibleCause":"","suggestedFix":"","codeExample":"","documentationLinks":[],"confidence":0.95}

Error: TypeError — Cannot read properties of undefined (reading 'map')
File: src/components/List.tsx:42  Source: ts
Code: (first 600 chars of surrounding code)
```

**Returned `ErrorSummary`:**
```typescript
interface ErrorSummary {
  errorType: string;
  explanation: string;       // Plain English explanation
  possibleCause: string;     // Likely root cause
  location: string;          // "file.ts:42"
  suggestedFix: string;      // One-line fix description
  codeExample: string;       // Runnable code example
  documentationLinks: string[];
  confidence: number;        // 0–1
  aiSource?: string;         // "gpt-4o (copilot)" etc.
}
```

### 3. Root Cause Tracing

**File:** `src/modules/rootCauseAnalyzer.ts` + `src/services/aiService.ts`  
**Command:** `autodebug.findRootCause`

1. Collects workspace source files via `workspaceScanner`
2. Builds a prompt with the error + up to 3 relevant file snippets (60 lines each)
3. Asks LLM: "Where in the codebase does this error originate?"
4. Falls back to heuristic analysis:
   - Traces workspace stack frames (deepest non-library frame = root)
   - Cross-references variable names across files
   - Reports call chain with file:line positions

The result is shown in a Webview panel with confidence percentage color-coded:
- Green `>75%`, Orange `>40%`, Red otherwise

### 4. Stack Trace Cleaning

**File:** `src/modules/stackTraceCleaner.ts`

Filters raw Node.js/browser stack traces:
- Removes `node_modules` frames (configurable via `autodebug.filterLibraryFrames`)
- Removes Node.js internals (`node:internal/`, `timers.js`, etc.)
- Deduplicates consecutive identical frames
- Highlights workspace frames with relative paths
- Groups frames by call depth

### 5. AI Debug Assistant Chat

**File:** `src/modules/debugAssistant.ts` + sidebar `panel-chat`

Maintains a conversation history. When you ask a question:
1. Sets the active error context (if one is selected)
2. Builds a prompt with: system prompt + active error context + conversation history + your question
3. Sends to `llmService` for a streaming response
4. Formats the response with basic Markdown rendering (bold, code, links)

**Starter suggestions** auto-populate based on the selected error:
- "Why is this TypeError happening?"
- "How do I fix the error in file.ts?"
- "What is the root cause?"

### 6. Performance Analyzer

**File:** `src/modules/performanceAnalyzer.ts`  
**Command:** `autodebug.analyzePerformance`

Scans the active file for 10 performance anti-patterns:

| Pattern | Severity | What It Detects |
|---|---|---|
| Missing useEffect deps | High | `useEffect(fn)` with no dependency array |
| forEach+push anti-pattern | Medium | `.forEach(x => arr.push(...))` instead of `.map()` |
| Large array allocation | High | `new Array(N)` with N > 10,000 |
| setInterval leak | High | `setInterval` without cleanup return |
| Event listener leak | High | `addEventListener` without `removeEventListener` |
| JSON deep clone | Medium | `JSON.parse(JSON.stringify(…))` |
| Unbounded Promise.all | Critical | `Promise.all(largeArray.map(…))` |
| Direct DOM in React | Medium | `document.getElementById` alongside JSX |
| Full module require | Medium | `require('lodash')` instead of named imports |
| Infinite loop risk | Critical | `while(true)` without visible break |

Also computes **cyclomatic complexity** (number of decision points) and color-codes it:
- Green `< 5`: Simple  
- Orange `5–9`: Moderate  
- Red `≥ 10`: Complex — refactor recommended

### 7. Git Blame Integration

**File:** `src/modules/gitBlameAnalyzer.ts`  
**Command:** `autodebug.showBlame`

Uses `execSync('git blame --porcelain -L N,N filepath')` to get per-line blame info:
- Commit hash, author name, author email
- Commit timestamp (converted to ISO date)
- Commit summary message

`blameLine(filePath, lineNumber)` → `GitBlameInfo | null`  
`blameFile(filePath)` → `GitBlameInfo[]` (one per line)  
`getRecentDiff()` → last 5 commits with diff summary

**Usage:** Right-click any line → "AutoDebug: Show Git Blame for Line" shows a notification with who introduced the code and when.

### 8. Error Heatmap

**File:** `src/services/workspaceScanner.ts`

Tracks error/warning counts per file across all open documents. Updated every time diagnostics change.

`getTopErrorFiles()` → sorted by `errorCount + warningCount`, top 20 files

Displayed in the Heatmap tab as proportional bars with red/green gradient (more errors = redder).

### 9. Hover Provider

**File:** `src/providers/hoverProvider.ts`

Registered for 10 languages (TS, JS, Python, Java, C#, Go, Rust, PHP, TSX, JSX).

On hover over an error line:
1. Looks up the cached `ParsedError` for that file+line
2. Returns a `MarkdownString` with:
   - Error type + message
   - AI explanation (if available)
   - Suggested fix
   - Documentation links
   - Confidence percentage

### 10. Code Actions (Quick Fixes)

**File:** `src/providers/codeActionProvider.ts`

Provides `QuickFix` code actions on error lines:
- **Apply Fix:** Calls `autodebug.applyFix` to insert the AI-suggested code replace at the error line (indentation-preserving)
- **Find Root Cause:** Opens the root cause webview panel
- **Ask AI:** Opens the chat sidebar with the error pre-selected

---

## Commands

| Command | Title | Description |
|---|---|---|
| `autodebug.summarizeError` | AutoDebug: Summarize Error | Summarize the error near the cursor |
| `autodebug.explainCode` | AutoDebug: Explain Selected Code | Explain the selected code block |
| `autodebug.findRootCause` | AutoDebug: Find Root Cause | Open root cause analysis panel |
| `autodebug.showDashboard` | AutoDebug: Open Dashboard | Focus the AutoDebug sidebar |
| `autodebug.clearErrors` | AutoDebug: Clear All Errors | Clear cached errors and sidebar |
| `autodebug.showHeatmap` | AutoDebug: Show Error Heatmap | Show top error files in a notification |
| `autodebug.analyzeWorkspace` | AutoDebug: Analyze Workspace | Scan all workspace files for errors |
| `autodebug.analyzePerformance` | AutoDebug: Analyze Performance | Detect performance issues in active file |
| `autodebug.showBlame` | AutoDebug: Show Git Blame for Line | Show git blame for cursor line |
| `autodebug.applyFix` | (internal) | Apply a suggested fix to the editor |

---

## Configuration

Settings available under `AutoDebug AI` in VS Code settings:

| Setting | Type | Default | Description |
|---|---|---|---|
| `autodebug.enableRealTimeAnalysis` | boolean | `true` | Enable real-time error analysis |
| `autodebug.maxErrorsToTrack` | number | `100` | Max errors to process at once |
| `autodebug.filterLibraryFrames` | boolean | `true` | Filter node_modules from stack traces |
| `autodebug.enableHeatmap` | boolean | `true` | Track file-level error heatmap |
| `autodebug.clusterSimilarErrors` | boolean | `true` | Group similar errors by type |
| `autodebug.aiBackend` | enum | `"auto"` | Force a specific AI backend (`auto`\|`copilot`\|`github-models`\|`pattern-kb`) |

---

## File Structure

```
autodebug-ai/
├── src/
│   ├── extension.ts
│   ├── parsers/errorParser.ts
│   ├── services/
│   │   ├── llmService.ts
│   │   ├── aiService.ts
│   │   └── workspaceScanner.ts
│   ├── modules/
│   │   ├── errorSummarizer.ts
│   │   ├── rootCauseAnalyzer.ts
│   │   ├── stackTraceCleaner.ts
│   │   ├── debugAssistant.ts
│   │   ├── gitBlameAnalyzer.ts
│   │   └── performanceAnalyzer.ts
│   ├── providers/
│   │   ├── hoverProvider.ts
│   │   ├── codeActionProvider.ts
│   │   └── sidebarProvider.ts
│   ├── commands/
│   │   ├── summarizeError.ts
│   │   └── explainCode.ts
│   ├── utils/
│   │   ├── logger.ts
│   │   └── fileUtils.ts
│   └── webview/
│       └── dashboard.html
├── resources/
│   └── icon.svg
├── out/                   (compiled JS, git-ignored)
├── package.json
├── tsconfig.json
├── DOCS.md
└── .vscode/
    ├── launch.json        (run Extension Development Host)
    └── tasks.json         (compile on launch)
```

---

## How It Was Built

### Step 1: Project Scaffold

Created with TypeScript 5.3, targeting VS Code engine `^1.90.0`. The project uses standard `tsc` compilation (no webpack/esbuild) for simplicity and fast iteration.

`package.json` defines:
- `activationEvents: ["onStartupFinished"]` — activates on VS Code startup
- Sidebar view container + webview view
- 9 commands registered in the `contributes.commands` section
- Context menu entries for editor right-click

### Step 2: Error Parser

`errorParser.ts` converts raw `vscode.Diagnostic` objects into normalized `ParsedError` structs with stable IDs (MD5-like hash), relative file paths (for portability), and parsed stack trace frames (from the diagnostic message text).

### Step 3: LLM Service Gateway

`llmService.ts` was designed as a **single AI gateway** with three layers:

1. **VS Code LM API** — `vscode.lm.selectChatModels()` returns `LanguageModelChat` objects. We call `model.sendRequest()` which returns an async iterable of text chunks (streaming).

2. **GitHub Models REST API** — The same GitHub OAuth session VS Code uses for Copilot/GitHub can be accessed via `vscode.authentication.getSession('github', ['read:user'], { silent: true })`. This token can authenticate against `https://models.inference.ai.azure.com` — GitHub's OpenAI-compatible inference endpoint.

3. **Pattern KB fallback** — 12 regex patterns with handcrafted explanations, causes, fixes, and MDN documentation links.

### Step 4: AI Service

`aiService.ts` provides the high-level operations (summarize, root cause, generate fix, chat). Each method follows the same pattern:
1. Try LLM path (via `llmService.send()`)
2. Parse structured JSON response
3. Fall back to pattern/heuristic if LLM fails or is unavailable

Response parsing is tolerant: tries `JSON.parse()` first, falls back to treating the entire response as plain text.

### Step 5: Modules

Each module handles one concern:
- **`errorSummarizer.ts`** — batches errors, calls `aiService.summarizeError()` with surrounding code context, caches results
- **`rootCauseAnalyzer.ts`** — reads workspace files, builds context, calls `aiService.findRootCause()`
- **`stackTraceCleaner.ts`** — pure string manipulation, no async
- **`debugAssistant.ts`** — maintains bounded conversation history (last 20 messages), builds prompts
- **`performanceAnalyzer.ts`** — 10 regex-based detectors + cyclomatic complexity counter
- **`gitBlameAnalyzer.ts`** — wraps `execSync('git blame --porcelain')` output parser

### Step 6: Providers

- **`hoverProvider.ts`** — implements `vscode.HoverProvider`, looks up cached `ParsedError` for the hovered position, returns `MarkdownString`
- **`codeActionProvider.ts`** — implements `vscode.CodeActionProvider`, returns `QuickFix` actions for error lines
- **`sidebarProvider.ts`** — implements `vscode.WebviewViewProvider`, manages message passing between extension and the HTML webview

### Step 7: Dashboard Webview

`dashboard.html` is a single-file HTML/CSS/JS application. It uses:
- **Lucide SVG icons** (inline, no CDN) for bug, trash, search, chart, check, location pin, warning, and chat icons
- **VS Code CSS variables** (`--vscode-foreground`, `--vscode-input-background`, etc.) for automatic theme adaptation
- **Content Security Policy:** `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'` — no external resources loaded
- **Four tabs:** Errors, Root Cause, Heatmap, Assistant
- **Real-time message handler** using `window.addEventListener('message', ...)` to receive updates from the extension host

### Step 8: Status Bar

On activation, a status bar item shows the AI backend state:
- `$(sync~spin) AutoDebug: Connecting AI…` during probe
- `$(check) AutoDebug: Copilot AI` if Copilot is available
- `$(github) AutoDebug: GitHub Models` if GitHub token works
- `$(database) AutoDebug: Pattern KB` if offline

### Step 9: Commands and Keybindings

Commands are registered via `vscode.commands.registerCommand()` in `extension.ts`. They read the active text editor and diagnostics, then run the appropriate module. Two new commands were added in this version:
- `autodebug.analyzePerformance` — opens a Webview panel with performance issues
- `autodebug.showBlame` — shows git blame for the cursor line in a notification

---

## Extending the Extension

### Add a new error pattern

In `src/services/aiService.ts`, add to `PATTERN_KB`:
```typescript
{
    pattern: /your regex here/i,
    type: 'ErrorType',
    explanation: 'What this error means.',
    cause: 'Why it occurs.',
    fix: 'How to fix it.',
    example: '// code example\nconst fixed = ...',
    docs: ['https://...']
}
```

### Add a new performance anti-pattern

In `src/modules/performanceAnalyzer.ts`, add to the `PATTERNS` array:
```typescript
{
    name: 'Pattern Name',
    regex: /your regex/gi,
    description: 'What it detects.',
    fix: 'Recommended fix.',
    severity: 'high' as const
}
```

### Support a new language

In `extension.ts`, add to the `allLanguages` array:
```typescript
{ scheme: 'file', language: 'ruby' }
```

### Add a new LLM provider

In `src/services/llmService.ts`, add a new `sendViaXxx()` method and call it in the `send()` waterfall after the existing providers.

---

*Built with TypeScript + VS Code Extension API. No runtime dependencies.*
