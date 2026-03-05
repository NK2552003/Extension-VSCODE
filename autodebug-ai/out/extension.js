"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const errorParser_1 = require("./parsers/errorParser");
const errorSummarizer_1 = require("./modules/errorSummarizer");
const rootCauseAnalyzer_1 = require("./modules/rootCauseAnalyzer");
const debugAssistant_1 = require("./modules/debugAssistant");
const workspaceScanner_1 = require("./services/workspaceScanner");
const aiService_1 = require("./services/aiService");
const llmService_1 = require("./services/llmService");
const gitBlameAnalyzer_1 = require("./modules/gitBlameAnalyzer");
const performanceAnalyzer_1 = require("./modules/performanceAnalyzer");
const hoverProvider_1 = require("./providers/hoverProvider");
const codeActionProvider_1 = require("./providers/codeActionProvider");
const sidebarProvider_1 = require("./providers/sidebarProvider");
const summarizeError_1 = require("./commands/summarizeError");
const explainCode_1 = require("./commands/explainCode");
const splitModule_1 = require("./commands/splitModule");
const logger_1 = require("./utils/logger");
// Debounce utility
function debounce(fn, ms) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}
function activate(context) {
    logger_1.logger.info('AutoDebug AI activating…');
    // ── AI Status Bar ─────────────────────────────────────────────────────────
    const aiStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    aiStatusBar.text = '$(sync~spin) AutoDebug: Connecting AI…';
    aiStatusBar.tooltip = 'AutoDebug AI — initializing AI backend';
    aiStatusBar.show();
    context.subscriptions.push(aiStatusBar);
    // Initialize LLM service in background and update status bar
    llmService_1.llmService.initialize().then(() => {
        const status = llmService_1.llmService.getStatus();
        if (status.copilot) {
            aiStatusBar.text = '$(check) AutoDebug: Copilot AI';
            aiStatusBar.tooltip = 'AutoDebug AI — powered by GitHub Copilot';
            aiStatusBar.backgroundColor = undefined;
        }
        else if (status.githubModels) {
            aiStatusBar.text = '$(github) AutoDebug: GitHub Models';
            aiStatusBar.tooltip = 'AutoDebug AI — powered by GitHub Models API';
            aiStatusBar.backgroundColor = undefined;
        }
        else {
            aiStatusBar.text = '$(database) AutoDebug: Pattern KB';
            aiStatusBar.tooltip = 'AutoDebug AI — using pattern knowledge base (no AI token found)';
        }
    }).catch(() => {
        aiStatusBar.text = '$(warning) AutoDebug: Offline';
    });
    // ── Sidebar provider ──────────────────────────────────────────────────────
    const sidebarProvider = new sidebarProvider_1.SidebarProvider(context.extensionUri);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(sidebarProvider_1.SidebarProvider.viewType, sidebarProvider, { webviewOptions: { retainContextWhenHidden: true } }));
    // Register sidebar with the module splitter command so split plans appear there
    (0, splitModule_1.registerSidebarForSplitter)(sidebarProvider);
    // ── Language selectors for providers ─────────────────────────────────────
    const allLanguages = [
        { scheme: 'file', language: 'typescript' },
        { scheme: 'file', language: 'typescriptreact' },
        { scheme: 'file', language: 'javascript' },
        { scheme: 'file', language: 'javascriptreact' },
        { scheme: 'file', language: 'python' },
        { scheme: 'file', language: 'java' },
        { scheme: 'file', language: 'csharp' },
        { scheme: 'file', language: 'go' },
        { scheme: 'file', language: 'rust' },
        { scheme: 'file', language: 'php' },
    ];
    // ── Hover provider ────────────────────────────────────────────────────────
    context.subscriptions.push(vscode.languages.registerHoverProvider(allLanguages, hoverProvider_1.hoverProvider));
    // ── Code action provider ──────────────────────────────────────────────────
    context.subscriptions.push(vscode.languages.registerCodeActionsProvider(allLanguages, codeActionProvider_1.codeActionProvider, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Empty] }));
    // ── Diagnostic listener (core pipeline) ──────────────────────────────────
    const processDiagnostics = debounce(async (uri, diagnostics) => {
        const config = vscode.workspace.getConfiguration('autodebug');
        if (!config.get('enableRealTimeAnalysis', true)) {
            return;
        }
        const maxErrors = config.get('maxErrorsToTrack', 100);
        setImmediate(async () => {
            try {
                workspaceScanner_1.workspaceScanner.updateHeatmap(uri, diagnostics);
                const parsed = diagnostics
                    .filter(d => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning)
                    .slice(0, maxErrors)
                    .map(d => (0, errorParser_1.parseDiagnostic)(d, uri));
                hoverProvider_1.hoverProvider.updateErrors(uri, parsed);
                codeActionProvider_1.codeActionProvider.updateErrors(uri, parsed);
                if (parsed.length > 0) {
                    const results = await errorSummarizer_1.errorSummarizer.summarizeAll(parsed);
                    sidebarProvider.updateErrors(results);
                    sidebarProvider.updateHeatmap(workspaceScanner_1.workspaceScanner.getTopErrorFiles());
                }
                else {
                    // pass empty to clear
                    sidebarProvider.updateErrors([]);
                    sidebarProvider.updateHeatmap(workspaceScanner_1.workspaceScanner.getTopErrorFiles());
                }
            }
            catch (err) {
                logger_1.logger.error('Diagnostic processing failed', err);
            }
        });
    }, 600);
    context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(async (event) => {
        for (const uri of event.uris) {
            const diagnostics = vscode.languages.getDiagnostics(uri);
            processDiagnostics(uri, diagnostics);
        }
    }));
    // ── Active editor change ─── reload diagnostics for current file ──────────
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
            const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
            processDiagnostics(editor.document.uri, diagnostics);
        }
    }));
    // ── Sidebar message handler ───────────────────────────────────────────────
    const disposable = sidebarProvider.onMessage(async (message) => {
        switch (message.type) {
            case 'webviewReady': {
                // Send current diagnostics
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    const diags = vscode.languages.getDiagnostics(editor.document.uri);
                    processDiagnostics(editor.document.uri, diags);
                }
                break;
            }
            case 'askQuestion': {
                try {
                    const response = await debugAssistant_1.debugAssistant.ask(message.question);
                    sidebarProvider.updateChat(debugAssistant_1.debugAssistant.getHistory());
                }
                catch (err) {
                    logger_1.logger.error('Chat question failed', err);
                }
                break;
            }
            case 'selectError': {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    break;
                }
                const diags = vscode.languages.getDiagnostics(editor.document.uri);
                const parsed = diags.map(d => (0, errorParser_1.parseDiagnostic)(d, editor.document.uri));
                const target = parsed.find(e => e.id === message.errorId) ?? parsed[0];
                if (target) {
                    debugAssistant_1.debugAssistant.setActiveError(target);
                }
                break;
            }
            case 'openFile': {
                try {
                    const uri = vscode.Uri.file(message.file);
                    const doc = await vscode.workspace.openTextDocument(uri);
                    const line = Math.max(0, message.line - 1);
                    await vscode.window.showTextDocument(doc, {
                        selection: new vscode.Range(line, 0, line, 0),
                        viewColumn: vscode.ViewColumn.One
                    });
                }
                catch (err) {
                    // Try relative path
                    const folders = vscode.workspace.workspaceFolders;
                    if (folders) {
                        for (const folder of folders) {
                            try {
                                const absPath = vscode.Uri.joinPath(folder.uri, message.file);
                                const doc = await vscode.workspace.openTextDocument(absPath);
                                const line = Math.max(0, message.line - 1);
                                await vscode.window.showTextDocument(doc, {
                                    selection: new vscode.Range(line, 0, line, 0)
                                });
                                break;
                            }
                            catch { /* continue */ }
                        }
                    }
                }
                break;
            }
            case 'clearErrors': {
                errorSummarizer_1.errorSummarizer.clearCache();
                aiService_1.aiService.clearCache();
                sidebarProvider.updateErrors([]);
                sidebarProvider.updateHeatmap([]);
                break;
            }
            case 'analyzeWorkspace': {
                await analyzeWorkspaceCommand(sidebarProvider);
                break;
            }
            case 'splitWithMode': {
                await (0, splitModule_1.splitWithModeCommand)(message.mode);
                break;
            }
            case 'createSplitFiles': {
                await (0, splitModule_1.createSplitFilesCommand)();
                break;
            }
        }
    });
    if (disposable) {
        context.subscriptions.push(disposable);
    }
    // ── Commands ──────────────────────────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('autodebug.summarizeError', summarizeError_1.summarizeErrorCommand), vscode.commands.registerCommand('autodebug.explainCode', explainCode_1.explainCodeCommand), vscode.commands.registerCommand('autodebug.splitModule', splitModule_1.splitModuleCommand), vscode.commands.registerCommand('autodebug.splitModuleAst', () => (0, splitModule_1.splitWithModeCommand)('ast')), vscode.commands.registerCommand('autodebug.splitModuleAI', () => (0, splitModule_1.splitWithModeCommand)('ai')), vscode.commands.registerCommand('autodebug.splitModuleAstAI', () => (0, splitModule_1.splitWithModeCommand)('ast+ai')), vscode.commands.registerCommand('autodebug.createSplitFiles', splitModule_1.createSplitFilesCommand), vscode.commands.registerCommand('autodebug.findRootCause', async (errorArg) => {
        const editor = vscode.window.activeTextEditor;
        let target = errorArg;
        if (!target && editor) {
            const diags = vscode.languages.getDiagnostics(editor.document.uri).filter(d => d.severity === vscode.DiagnosticSeverity.Error);
            if (diags.length > 0) {
                const cursorLine = editor.selection.active.line;
                const diag = diags.find(d => d.range.start.line === cursorLine) ?? diags[0];
                target = (0, errorParser_1.parseDiagnostic)(diag, editor.document.uri);
            }
        }
        if (!target) {
            await vscode.window.showInformationMessage('AutoDebug AI: No error found to trace.');
            return;
        }
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'AutoDebug AI: Tracing root cause…', cancellable: false }, async () => {
            const analysis = await rootCauseAnalyzer_1.rootCauseAnalyzer.analyze(target);
            const formatted = rootCauseAnalyzer_1.rootCauseAnalyzer.formatAnalysis(analysis);
            const panel = vscode.window.createWebviewPanel('autodebug.rootCause', `AutoDebug AI: Root Cause — ${target.relativeFile}`, vscode.ViewColumn.Beside, { enableScripts: false });
            panel.webview.html = buildRootCauseHtml(target, formatted, analysis);
        });
    }), vscode.commands.registerCommand('autodebug.showDashboard', () => {
        vscode.commands.executeCommand('workbench.view.extension.autodebug-sidebar');
    }), vscode.commands.registerCommand('autodebug.clearErrors', () => {
        errorSummarizer_1.errorSummarizer.clearCache();
        aiService_1.aiService.clearCache();
        sidebarProvider.updateErrors([]);
        sidebarProvider.updateHeatmap([]);
        vscode.window.showInformationMessage('AutoDebug AI: Error cache cleared.');
    }), vscode.commands.registerCommand('autodebug.showHeatmap', () => {
        const entries = workspaceScanner_1.workspaceScanner.getTopErrorFiles();
        if (entries.length === 0) {
            vscode.window.showInformationMessage('AutoDebug AI: No heatmap data yet. Errors will be tracked as they appear.');
            return;
        }
        const lines = entries.map((e, i) => `${i + 1}. ${e.relativeFile} — ${e.errorCount} error(s), ${e.warningCount} warning(s)`);
        vscode.window.showInformationMessage(`AutoDebug AI Heatmap:\n${lines.slice(0, 5).join('\n')}`, { modal: true });
    }), vscode.commands.registerCommand('autodebug.analyzeWorkspace', () => analyzeWorkspaceCommand(sidebarProvider)), vscode.commands.registerCommand('autodebug.analyzePerformance', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            await vscode.window.showInformationMessage('AutoDebug AI: Open a file to analyze performance.');
            return;
        }
        const code = editor.document.getText();
        const issues = performanceAnalyzer_1.performanceAnalyzer.analyze(code);
        const complexityResult = performanceAnalyzer_1.performanceAnalyzer.analyzeComplexity(code);
        if (issues.length === 0) {
            await vscode.window.showInformationMessage('AutoDebug AI: No performance issues detected in this file!');
            return;
        }
        const panel = vscode.window.createWebviewPanel('autodebug.performance', `Performance — ${editor.document.fileName.split('/').pop()}`, vscode.ViewColumn.Beside, { enableScripts: false });
        panel.webview.html = buildPerformanceHtml(issues, complexityResult, editor.document.fileName);
    }), vscode.commands.registerCommand('autodebug.showBlame', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            await vscode.window.showInformationMessage('AutoDebug AI: Open a file to show git blame.');
            return;
        }
        const line = editor.selection.active.line + 1;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'AutoDebug AI: Running git blame…', cancellable: false }, async () => {
            try {
                const blame = await gitBlameAnalyzer_1.gitBlameAnalyzer.blameLine(editor.document.fileName, line);
                if (!blame) {
                    await vscode.window.showInformationMessage('AutoDebug AI: No git blame data for this line.');
                    return;
                }
                const msg = `Line ${line} — ${blame.author} (${blame.date.slice(0, 10)})\nCommit: ${blame.commit.slice(0, 8)}\n${blame.message}`;
                await vscode.window.showInformationMessage(msg);
            }
            catch (err) {
                await vscode.window.showWarningMessage('AutoDebug AI: Git blame failed. Is this file in a git repo?');
            }
        });
    }), vscode.commands.registerCommand('autodebug.applyFix', async (uri, lineIndex, _colIndex, fixCode) => {
        const doc = await vscode.workspace.openTextDocument(uri);
        const edit = new vscode.WorkspaceEdit();
        const line = doc.lineAt(lineIndex);
        const range = new vscode.Range(lineIndex, 0, lineIndex, line.text.length);
        // Prefix with original indent
        const indent = line.text.match(/^(\s*)/)?.[1] ?? '';
        edit.replace(uri, range, indent + fixCode.split('\n').join('\n' + indent));
        const success = await vscode.workspace.applyEdit(edit);
        if (success) {
            vscode.window.showInformationMessage('AutoDebug AI: Fix applied.');
        }
        else {
            vscode.window.showWarningMessage('AutoDebug AI: Could not apply fix automatically. Copy the suggestion manually.');
        }
    }));
    // ── Initial scan ──────────────────────────────────────────────────────────
    setTimeout(() => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const diags = vscode.languages.getDiagnostics(editor.document.uri);
            if (diags.length > 0) {
                processDiagnostics(editor.document.uri, diags);
            }
        }
    }, 1500);
    logger_1.logger.info('AutoDebug AI activated successfully.');
}
async function analyzeWorkspaceCommand(sidebar) {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'AutoDebug AI: Scanning workspace…', cancellable: false }, async () => {
        try {
            await workspaceScanner_1.workspaceScanner.scanWorkspace();
            // Re-process all open diagnostics
            const allDiags = vscode.languages.getDiagnostics();
            const processed = [];
            for (const [uri, diagnostics] of allDiags) {
                workspaceScanner_1.workspaceScanner.updateHeatmap(uri, diagnostics);
                const errors = diagnostics
                    .filter(d => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning)
                    .slice(0, 20)
                    .map(d => (0, errorParser_1.parseDiagnostic)(d, uri));
                const results = await errorSummarizer_1.errorSummarizer.summarizeAll(errors);
                processed.push(...results);
            }
            sidebar.updateErrors(processed);
            sidebar.updateHeatmap(workspaceScanner_1.workspaceScanner.getTopErrorFiles());
            vscode.window.showInformationMessage(`AutoDebug AI: Workspace scan complete. Found ${processed.length} issue(s).`);
        }
        catch (err) {
            logger_1.logger.error('analyzeWorkspaceCommand: failed', err);
            vscode.window.showErrorMessage('AutoDebug AI: Workspace scan failed.');
        }
    });
}
function buildPerformanceHtml(issues, complexityResult, fileName) {
    const complexity = complexityResult.cyclomaticComplexity;
    function escH(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    const severityColor = (s) => s === 'critical' ? 'var(--vscode-editorError-foreground, #f14c4c)' : s === 'high' ? 'var(--vscode-editorWarning-foreground, #cca700)' : 'var(--vscode-editorInfo-foreground, #3794ff)';
    const severityBg = (s) => s === 'critical' ? 'rgba(241,76,76,0.08)' : s === 'high' ? 'rgba(204,167,0,0.08)' : 'rgba(55,148,255,0.08)';
    const rows = issues.map(i => `
        <div style="background:${severityBg(i.severity)};border-radius:5px;padding:10px 12px;margin:6px 0;border:1px solid var(--vscode-panel-border,rgba(127,127,127,0.18));border-left:3px solid ${severityColor(i.severity)}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
            <span style="font-weight:600;color:var(--vscode-foreground,#d4d4d4);font-size:12px">${escH(i.name)}</span>
            <span style="font-size:10px;padding:1px 7px;border-radius:10px;background:${severityBg(i.severity)};color:${severityColor(i.severity)};border:1px solid ${severityColor(i.severity).replace(')', ',0.3)').replace('var(', 'rgba(').replace('var(--vscode-editorError-foreground, ', '').replace('var(--vscode-editorWarning-foreground, ', '').replace('var(--vscode-editorInfo-foreground, ', '')};font-weight:600">${escH(i.severity)}</span>
          </div>
          <div style="font-size:11px;color:var(--vscode-foreground,#ccc);margin:4px 0 5px;line-height:1.45">${escH(i.description)}</div>
          <div style="font-size:10px;color:var(--vscode-descriptionForeground,#777);margin-bottom:6px">Line ${i.line}</div>
          <div style="font-size:11px;background:rgba(78,201,176,0.06);border:1px solid rgba(78,201,176,0.2);border-left:2px solid var(--vscode-terminal-ansiGreen,#4ec9b0);border-radius:3px;padding:5px 9px;color:var(--vscode-terminal-ansiGreen,#4ec9b0);line-height:1.4">${escH(i.fix)}</div>
        </div>`).join('');
    const complexityColor = complexity < 5 ? '#4caf50' : complexity < 10 ? 'var(--vscode-editorWarning-foreground,#cca700)' : 'var(--vscode-editorError-foreground,#f14c4c)';
    const complexityLabel = complexity < 5 ? 'Simple' : complexity < 10 ? 'Moderate' : 'Complex — consider refactoring';
    const shortName = escH(fileName.split('/').pop() ?? '');
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>Performance Analysis</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family,'Segoe UI',system-ui,sans-serif); font-size: var(--vscode-font-size,13px); background: var(--vscode-editor-background,#1e1e1e); color: var(--vscode-editor-foreground,#d4d4d4); line-height: 1.6; }
  a { color: var(--vscode-textLink-foreground,#3794ff); text-decoration: none; }
  ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-track { background: transparent; } ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background,rgba(100,100,100,0.4)); border-radius: 3px; }
</style>
</head><body>
<div style="display:flex;align-items:center;gap:12px;padding:16px 20px;background:var(--vscode-sideBarSectionHeader-background,rgba(127,127,127,0.05));border-bottom:1px solid var(--vscode-panel-border,#404040)">
  <div style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;background:var(--vscode-button-background,#0e639c);color:#fff;border-radius:8px;flex-shrink:0">
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
  </div>
  <div><div style="font-size:14px;font-weight:600;color:var(--vscode-foreground,#d4d4d4)">${shortName}</div><div style="font-size:11px;color:var(--vscode-descriptionForeground,#888);margin-top:2px">AutoDebug AI — Performance Analysis</div></div>
</div>
<div style="display:flex;gap:6px;padding:10px 20px;border-bottom:1px solid var(--vscode-panel-border,rgba(127,127,127,0.1));flex-wrap:wrap">
  <span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;background:rgba(127,127,127,0.1);color:var(--vscode-descriptionForeground,#aaa);border:1px solid rgba(127,127,127,0.18)">${issues.length} issue${issues.length !== 1 ? 's' : ''}</span>
  <span style="display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;background:rgba(127,127,127,0.1);color:${complexityColor};border:1px solid rgba(127,127,127,0.18)">Complexity: ${complexity} &mdash; ${complexityLabel}</span>
</div>
<div style="padding:14px 20px">${rows || '<div style="color:var(--vscode-descriptionForeground,#888);font-size:12px;padding:20px 0;text-align:center">No performance issues detected.</div>'}</div>
</body></html>`;
}
function buildRootCauseHtml(error, formatted, analysis) {
    function escapeHtml(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    const chainHtml = analysis.callChain.length > 0
        ? `<pre>${escapeHtml(analysis.callChain.join('\n'))}</pre>`
        : '';
    const conf = Math.round(analysis.confidence * 100);
    const confColor = conf > 75 ? '#4caf50' : conf > 40 ? 'var(--vscode-editorWarning-foreground,#cca700)' : 'var(--vscode-editorError-foreground,#f14c4c)';
    const confBg = conf > 75 ? 'rgba(76,175,80,0.12)' : conf > 40 ? 'rgba(204,167,0,0.12)' : 'rgba(241,76,76,0.12)';
    const confBorder = conf > 75 ? 'rgba(76,175,80,0.25)' : conf > 40 ? 'rgba(204,167,0,0.25)' : 'rgba(241,76,76,0.25)';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <title>AutoDebug AI — Root Cause</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--vscode-font-family,'Segoe UI',system-ui,sans-serif); font-size: var(--vscode-font-size,13px); background: var(--vscode-editor-background,#1e1e1e); color: var(--vscode-editor-foreground,#d4d4d4); line-height: 1.6; }
    a { color: var(--vscode-textLink-foreground,#3794ff); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .page-header { display:flex; align-items:center; gap:12px; padding:16px 20px; background:var(--vscode-sideBarSectionHeader-background,rgba(127,127,127,0.05)); border-bottom:1px solid var(--vscode-panel-border,#404040); }
    .page-header-icon { width:36px; height:36px; display:flex; align-items:center; justify-content:center; background:var(--vscode-editorWarning-foreground,#cca700); color:#000; border-radius:8px; flex-shrink:0; }
    .page-header-text h1 { font-size:14px; font-weight:600; color:var(--vscode-foreground,#d4d4d4); line-height:1.3; }
    .page-header-text p  { font-size:11px; color:var(--vscode-descriptionForeground,#888); margin-top:2px; }
    .meta-row { display:flex; flex-wrap:wrap; gap:5px; padding:10px 20px; border-bottom:1px solid var(--vscode-panel-border,rgba(127,127,127,0.1)); }
    .badge { display:inline-flex; align-items:center; gap:4px; font-size:10px; font-weight:600; padding:2px 8px; border-radius:10px; background:rgba(127,127,127,0.12); color:var(--vscode-descriptionForeground,#aaa); border:1px solid rgba(127,127,127,0.18); }
    .badge.conf { background:${confBg}; color:${confColor}; border-color:${confBorder}; }
    .content { padding:14px 20px; display:flex; flex-direction:column; gap:12px; }
    .section { border:1px solid var(--vscode-panel-border,#404040); border-radius:6px; overflow:hidden; }
    .section-header { display:flex; align-items:center; gap:7px; padding:7px 12px; background:var(--vscode-sideBarSectionHeader-background,rgba(127,127,127,0.05)); border-bottom:1px solid var(--vscode-panel-border,#404040); font-size:10px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:var(--vscode-descriptionForeground,#888); }
    .section-body { padding:12px 14px; font-size:12px; line-height:1.55; color:var(--vscode-foreground,#ccc); }
    .label { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:var(--vscode-descriptionForeground,#777); margin-bottom:4px; }
    .label + p { margin-bottom:10px; }
    pre { font-family:var(--vscode-editor-font-family,'Consolas',monospace); font-size:calc(var(--vscode-font-size,13px) - 1px); background:var(--vscode-textCodeBlock-background,rgba(127,127,127,0.08)); border:1px solid var(--vscode-panel-border,#404040); padding:10px 12px; border-radius:4px; overflow:auto; color:var(--vscode-editor-foreground,#ce9178); white-space:pre-wrap; word-break:break-word; margin-top:6px; line-height:1.55; }
    ::-webkit-scrollbar { width:6px; } ::-webkit-scrollbar-track { background:transparent; } ::-webkit-scrollbar-thumb { background:var(--vscode-scrollbarSlider-background,rgba(100,100,100,0.4)); border-radius:3px; }
  </style>
</head>
<body>

<div class="page-header">
  <div class="page-header-icon">
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/></svg>
  </div>
  <div class="page-header-text">
    <h1>Root Cause Analysis</h1>
    <p>AutoDebug AI — ${escapeHtml(error.type)}</p>
  </div>
</div>

<div class="meta-row">
  <span class="badge">
    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
    ${escapeHtml(error.relativeFile)}:${error.line}
  </span>
  <span class="badge conf">Confidence: ${conf}%</span>
</div>

<div class="content">
  <div class="section">
    <div class="section-header">
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
      Error
    </div>
    <div class="section-body">${escapeHtml(error.message)}</div>
  </div>
  <div class="section">
    <div class="section-header">
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      Root Cause
    </div>
    <div class="section-body">
      <div class="label">Location</div>
      <p>${escapeHtml(analysis.rootFile)}:${analysis.rootLine}</p>
      <div class="label">Reason</div>
      <p>${escapeHtml(analysis.reason)}</p>
    </div>
  </div>
  ${chainHtml ? `<div class="section">
    <div class="section-header">
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
      Call Chain
    </div>
    <div class="section-body">${chainHtml}</div>
  </div>` : ''}
</div>

</body>
</html>`;
}
function deactivate() {
    workspaceScanner_1.workspaceScanner.dispose();
    llmService_1.llmService.dispose();
    logger_1.logger.info('AutoDebug AI deactivated.');
    logger_1.logger.dispose();
}
//# sourceMappingURL=extension.js.map