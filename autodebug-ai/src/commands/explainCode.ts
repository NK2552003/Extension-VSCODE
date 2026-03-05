import * as vscode from 'vscode';
import { aiService } from '../services/aiService';
import { inferErrorType } from '../parsers/errorParser';
import { logger } from '../utils/logger';

export async function explainCodeCommand(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage('AutoDebug AI: Open a file to explain code.');
        return;
    }

    const selection = editor.selection;
    const code = editor.document.getText(
        selection.isEmpty
            ? new vscode.Range(
                Math.max(0, selection.active.line - 5),
                0,
                Math.min(editor.document.lineCount - 1, selection.active.line + 5),
                Number.MAX_SAFE_INTEGER
            )
            : selection
    );

    if (!code.trim()) {
        vscode.window.showInformationMessage('AutoDebug AI: Select code or position cursor on a line to explain.');
        return;
    }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'AutoDebug AI: Analyzing code…', cancellable: false },
        async () => {
            try {
                const patterns = aiService.detectBugPatterns(code);
                const panel = vscode.window.createWebviewPanel(
                    'autodebug.explainCode',
                    'AutoDebug AI: Code Analysis',
                    vscode.ViewColumn.Beside,
                    { enableScripts: false }
                );
                panel.webview.html = buildExplainHtml(code, patterns);
            } catch (err) {
                logger.error('explainCodeCommand: failed', err);
                vscode.window.showErrorMessage('AutoDebug AI: Failed to analyze code.');
            }
        }
    );
}

function buildExplainHtml(
    code: string,
    patterns: Array<{ name: string; description: string; fix: string }>
): string {
    function escH(s: string): string {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Inline SVG icons — no scripts required, no emoji
    const svgSearch = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>`;
    const svgCode   = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
    const svgWarn   = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
    const svgFix    = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="3"/><path d="M4.22 4.22l.71.71M1 12h1M20 12h1M4.93 19.07l.71-.71M19.07 19.07l-.71-.71M18 12a6 6 0 1 0-12 0c0 2.22 1.21 4.16 3 5.2V19a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-1.8c1.79-1.04 3-2.98 3-5.2z"/></svg>`;
    const svgCheck  = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
    const svgBug    = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2l1.5 1.5"/><path d="M14.5 3.5L16 2"/><path d="M9 9h6"/><path d="M9 12h6"/><path d="M9 15h6"/><path d="M4 12H2"/><path d="M22 12h-2"/><path d="M4 6H2"/><path d="M22 6h-2"/><path d="M4 18H2"/><path d="M22 18h-2"/><path d="M17.5 5.5A2.121 2.121 0 0 0 16 5H8a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7a2.121 2.121 0 0 0-.5-1.5z"/></svg>`;

    const patternCards = patterns.length > 0
        ? patterns.map(p => `
<div class="pattern-card">
  <div class="pattern-name">${svgWarn} ${escH(p.name)}</div>
  <div class="pattern-desc">${escH(p.description)}</div>
  <div class="pattern-fix">
    <span class="fix-icon">${svgFix}</span>
    <div><span class="fix-label">Suggested Fix</span>&nbsp; ${escH(p.fix)}</div>
  </div>
</div>`).join('')
        : `<div class="all-clear">${svgCheck}<span>No common bug patterns detected in the selected code.</span></div>`;

    const countBadge = patterns.length > 0
        ? `<span class="badge warn">${patterns.length} pattern${patterns.length !== 1 ? 's' : ''}</span>`
        : `<span class="badge ok">Clean</span>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <title>AutoDebug AI — Code Analysis</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #d4d4d4);
      line-height: 1.6;
    }

    /* ── Page header ── */
    .page-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px 20px;
      background: var(--vscode-sideBarSectionHeader-background, rgba(127,127,127,0.05));
      border-bottom: 1px solid var(--vscode-panel-border, #404040);
    }
    .page-header-icon {
      width: 36px; height: 36px;
      display: flex; align-items: center; justify-content: center;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border-radius: 8px;
      flex-shrink: 0;
    }
    .page-header-text h1 {
      font-size: 14px;
      font-weight: 600;
      color: var(--vscode-foreground, #d4d4d4);
      line-height: 1.3;
    }
    .page-header-text p {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888);
      margin-top: 2px;
    }

    /* ── Content ── */
    .content {
      padding: 16px 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    /* ── Section card ── */
    .section {
      border: 1px solid var(--vscode-panel-border, #404040);
      border-radius: 6px;
      overflow: hidden;
    }
    .section-header {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 8px 12px;
      background: var(--vscode-sideBarSectionHeader-background, rgba(127,127,127,0.06));
      border-bottom: 1px solid var(--vscode-panel-border, #404040);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground, #888);
    }
    .section-header svg { flex-shrink: 0; }
    .section-header .spacer { flex: 1; }
    .section-body { padding: 12px; }

    /* ── Code block ── */
    pre {
      font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
      font-size: calc(var(--vscode-font-size, 13px) - 1px);
      background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.08));
      border: 1px solid var(--vscode-panel-border, #333);
      padding: 12px 14px;
      border-radius: 4px;
      overflow: auto;
      color: var(--vscode-editor-foreground, #ce9178);
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.55;
      margin: 0;
      max-height: 320px;
    }

    /* ── Pattern card ── */
    .pattern-card {
      background: var(--vscode-inputValidation-warningBackground, rgba(53,42,5,0.4));
      border: 1px solid var(--vscode-editorWarning-foreground, #cca700);
      border-left-width: 3px;
      border-radius: 4px;
      padding: 10px 12px;
      margin-bottom: 8px;
    }
    .pattern-card:last-child { margin-bottom: 0; }
    .pattern-name {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-editorWarning-foreground, #cca700);
      margin-bottom: 6px;
    }
    .pattern-name svg { flex-shrink: 0; }
    .pattern-desc {
      font-size: 12px;
      color: var(--vscode-foreground, #ccc);
      line-height: 1.5;
      margin-bottom: 8px;
    }
    .pattern-fix {
      display: flex;
      align-items: flex-start;
      gap: 7px;
      background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.08));
      border: 1px solid var(--vscode-panel-border, #404040);
      border-radius: 3px;
      padding: 7px 10px;
      font-size: 11px;
      color: var(--vscode-foreground, #ccc);
      line-height: 1.45;
    }
    .fix-icon {
      color: var(--vscode-terminal-ansiGreen, #4ec9b0);
      flex-shrink: 0;
      margin-top: 1px;
    }
    .fix-label {
      font-weight: 700;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--vscode-terminal-ansiGreen, #4ec9b0);
    }

    /* ── All-clear ── */
    .all-clear {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border: 1px solid #4caf50;
      border-left-width: 3px;
      border-radius: 4px;
      font-size: 12px;
      color: #4caf50;
      background: rgba(76,175,80,0.06);
    }
    .all-clear svg { flex-shrink: 0; }

    /* ── Badges ── */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      font-size: 10px;
      font-weight: 600;
      padding: 1px 7px;
      border-radius: 10px;
    }
    .badge.warn { background: rgba(204,167,0,0.18); color: var(--vscode-editorWarning-foreground, #cca700); }
    .badge.ok   { background: rgba(76,175,80,0.15); color: #4caf50; }

    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, rgba(100,100,100,0.4)); border-radius: 3px; }
  </style>
</head>
<body>

<div class="page-header">
  <div class="page-header-icon">${svgSearch}</div>
  <div class="page-header-text">
    <h1>Code Analysis</h1>
    <p>AutoDebug AI — Bug Pattern Detection</p>
  </div>
</div>

<div class="content">
  <div class="section">
    <div class="section-header">${svgCode} Selected Code</div>
    <div class="section-body">
      <pre>${escH(code)}</pre>
    </div>
  </div>

  <div class="section">
    <div class="section-header">
      ${svgBug} Bug Pattern Analysis
      <span class="spacer"></span>
      ${countBadge}
    </div>
    <div class="section-body">
      ${patternCards}
    </div>
  </div>
</div>

</body>
</html>`;
}
