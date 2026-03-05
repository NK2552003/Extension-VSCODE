import * as vscode from 'vscode';
import { ParsedError, parseDiagnostic } from '../parsers/errorParser';
import { errorSummarizer } from '../modules/errorSummarizer';
import { rootCauseAnalyzer } from '../modules/rootCauseAnalyzer';
import { stackTraceCleaner } from '../modules/stackTraceCleaner';
import { logger } from '../utils/logger';

export async function summarizeErrorCommand(errorArg?: ParsedError): Promise<void> {
    const editor = vscode.window.activeTextEditor;

    // If called from code action with pre-parsed error
    if (errorArg) {
        await showErrorSummaryPanel(errorArg);
        return;
    }

    if (!editor) {
        vscode.window.showInformationMessage('AutoDebug AI: Open a file with errors to summarize.');
        return;
    }

    const uri = editor.document.uri;
    const diagnostics = vscode.languages.getDiagnostics(uri);

    if (diagnostics.length === 0) {
        vscode.window.showInformationMessage('AutoDebug AI: No errors found in the current file.');
        return;
    }

    const cursorLine = editor.selection.active.line;
    let target = diagnostics.find(d => d.range.start.line === cursorLine)
        ?? diagnostics[0];

    const parsed = parseDiagnostic(target, uri);

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'AutoDebug AI: Analyzing error…', cancellable: false },
        async () => {
            try {
                const result = await errorSummarizer.summarize(parsed);
                await showErrorSummaryPanel(parsed, result.summary);
            } catch (err) {
                logger.error('summarizeErrorCommand: failed', err);
                vscode.window.showErrorMessage('AutoDebug AI: Failed to analyze error.');
            }
        }
    );
}

async function showErrorSummaryPanel(error: ParsedError, summary?: Awaited<ReturnType<typeof errorSummarizer.summarize>>['summary']): Promise<void> {
    if (!summary) {
        const result = await errorSummarizer.summarize(error);
        summary = result.summary;
    }

    const panel = vscode.window.createWebviewPanel(
        'autodebug.errorSummary',
        `AutoDebug AI: ${error.type} — ${error.relativeFile}:${error.line}`,
        vscode.ViewColumn.Beside,
        { enableScripts: false }
    );

    panel.webview.html = buildSummaryHtml(error, summary);
}

function buildSummaryHtml(error: ParsedError, summary: { explanation: string; possibleCause: string; location: string; suggestedFix: string; codeExample: string; documentationLinks: string[]; confidence: number }): string {
    function escH(s: string): string {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Inline SVGs
    const svgBug    = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2l1.5 1.5"/><path d="M14.5 3.5L16 2"/><path d="M9 9h6"/><path d="M9 12h6"/><path d="M9 15h6"/><path d="M4 12H2"/><path d="M22 12h-2"/><path d="M4 6H2"/><path d="M22 6h-2"/><path d="M4 18H2"/><path d="M22 18h-2"/><path d="M17.5 5.5A2.121 2.121 0 0 0 16 5H8a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7a2.121 2.121 0 0 0-.5-1.5z"/></svg>`;
    const svgMsg    = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
    const svgInfo   = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
    const svgSearch = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>`;
    const svgFix    = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="3"/><path d="M4.22 4.22l.71.71M1 12h1M20 12h1M4.93 19.07l.71-.71M19.07 19.07l-.71-.71M18 12a6 6 0 1 0-12 0c0 2.22 1.21 4.16 3 5.2V19a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-1.8c1.79-1.04 3-2.98 3-5.2z"/></svg>`;
    const svgBook   = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`;
    const svgPin    = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;

    const confidence = Math.round(summary.confidence * 100);
    const confColor  = confidence > 75 ? '#4caf50' : confidence > 40 ? 'var(--vscode-editorWarning-foreground, #cca700)' : 'var(--vscode-editorError-foreground, #f14c4c)';
    const confBadgeBg = confidence > 75 ? 'rgba(76,175,80,0.12)' : confidence > 40 ? 'rgba(204,167,0,0.12)' : 'rgba(241,76,76,0.12)';
    const confBadgeBorder = confidence > 75 ? 'rgba(76,175,80,0.25)' : confidence > 40 ? 'rgba(204,167,0,0.25)' : 'rgba(241,76,76,0.25)';

    const docsHtml = summary.documentationLinks.length
        ? summary.documentationLinks.map(l =>
            `<div style="margin:3px 0"><a href="${escH(l)}">${escH(l.replace(/https?:\/\/(www\.)?/, ''))}</a></div>`
          ).join('')
        : '';

    const codeHtml = summary.codeExample
        ? `<pre>${escH(summary.codeExample)}</pre>`
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <title>AutoDebug AI — Error Analysis</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #d4d4d4);
      line-height: 1.6;
    }
    a { color: var(--vscode-textLink-foreground, #3794ff); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .page-header {
      display: flex; align-items: center; gap: 12px;
      padding: 16px 20px;
      background: var(--vscode-sideBarSectionHeader-background, rgba(127,127,127,0.05));
      border-bottom: 1px solid var(--vscode-panel-border, #404040);
    }
    .page-header-icon {
      width: 36px; height: 36px; display: flex; align-items: center; justify-content: center;
      background: var(--vscode-editorError-foreground, #f14c4c);
      color: #fff; border-radius: 8px; flex-shrink: 0;
    }
    .page-header-text h1 {
      font-size: 14px; font-weight: 600;
      color: var(--vscode-foreground, #d4d4d4); line-height: 1.3;
    }
    .page-header-text p {
      font-size: 11px; color: var(--vscode-descriptionForeground, #888); margin-top: 2px;
    }
    .meta-row {
      display: flex; flex-wrap: wrap; gap: 5px;
      padding: 10px 20px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.1));
      background: var(--vscode-sideBar-background, #1e1e1e);
    }
    .badge {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 10px; font-weight: 600;
      padding: 2px 8px; border-radius: 10px;
      background: rgba(127,127,127,0.12);
      color: var(--vscode-descriptionForeground, #aaa);
      border: 1px solid rgba(127,127,127,0.18);
    }
    .badge.conf { background: ${confBadgeBg}; color: ${confColor}; border-color: ${confBadgeBorder}; }
    .content { padding: 14px 20px; display: flex; flex-direction: column; gap: 12px; }
    .section {
      border: 1px solid var(--vscode-panel-border, #404040);
      border-radius: 6px; overflow: hidden;
    }
    .section-header {
      display: flex; align-items: center; gap: 7px;
      padding: 7px 12px;
      background: var(--vscode-sideBarSectionHeader-background, rgba(127,127,127,0.05));
      border-bottom: 1px solid var(--vscode-panel-border, #404040);
      font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--vscode-descriptionForeground, #888);
    }
    .section-header svg { flex-shrink: 0; }
    .section-body { padding: 12px 14px; font-size: 12px; line-height: 1.55; }
    .section-body p { color: var(--vscode-foreground, #ccc); }
    pre {
      font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
      font-size: calc(var(--vscode-font-size, 13px) - 1px);
      background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.08));
      border: 1px solid var(--vscode-panel-border, #404040);
      padding: 10px 12px; border-radius: 4px; overflow: auto;
      color: var(--vscode-editor-foreground, #ce9178);
      white-space: pre-wrap; word-break: break-word; margin-top: 8px; line-height: 1.55;
    }
    .fix-block {
      background: rgba(78,201,176,0.06);
      border: 1px solid rgba(78,201,176,0.2);
      border-left: 3px solid var(--vscode-terminal-ansiGreen, #4ec9b0);
      border-radius: 4px; padding: 8px 12px;
      font-size: 12px; color: var(--vscode-foreground, #ccc); line-height: 1.5;
    }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, rgba(100,100,100,0.4)); border-radius: 3px; }
  </style>
</head>
<body>

<div class="page-header">
  <div class="page-header-icon">${svgBug}</div>
  <div class="page-header-text">
    <h1>${escH(error.type)}</h1>
    <p>AutoDebug AI — Error Analysis</p>
  </div>
</div>

<div class="meta-row">
  <span class="badge">${svgPin} ${escH(error.relativeFile)}:${error.line}</span>
  <span class="badge conf">Confidence: ${confidence}%</span>
</div>

<div class="content">
  <div class="section">
    <div class="section-header">${svgMsg} Error Message</div>
    <div class="section-body"><p>${escH(error.message)}</p></div>
  </div>
  <div class="section">
    <div class="section-header">${svgInfo} Explanation</div>
    <div class="section-body"><p>${escH(summary.explanation)}</p></div>
  </div>
  <div class="section">
    <div class="section-header">${svgSearch} Possible Cause</div>
    <div class="section-body"><p>${escH(summary.possibleCause)}</p></div>
  </div>
  <div class="section">
    <div class="section-header">${svgFix} Suggested Fix</div>
    <div class="section-body">
      <div class="fix-block">${escH(summary.suggestedFix)}</div>
      ${codeHtml}
    </div>
  </div>
  ${docsHtml ? `<div class="section">
    <div class="section-header">${svgBook} Documentation</div>
    <div class="section-body">${docsHtml}</div>
  </div>` : ''}
</div>

</body>
</html>`;
}
