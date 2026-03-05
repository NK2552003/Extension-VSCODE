import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ParsedError } from '../parsers/errorParser';
import { ErrorAnalysisResult } from '../modules/errorSummarizer';
import { HeatmapEntry } from '../services/workspaceScanner';
import { ChatMessage } from '../modules/debugAssistant';
import { SplitPlan } from '../modules/moduleSplitter';
import { logger } from '../utils/logger';

export type SidebarMessage =
    | { type: 'webviewReady' }
    | { type: 'askQuestion'; question: string }
    | { type: 'selectError'; errorId: string }
    | { type: 'applyFix'; errorId: string; fixIndex: number }
    | { type: 'openFile'; file: string; line: number }
    | { type: 'clearErrors' }
    | { type: 'showHeatmap' }
    | { type: 'analyzeWorkspace' }
    | { type: 'splitWithMode'; mode: 'ast' | 'ai' | 'ast+ai' }
    | { type: 'createSplitFiles' };

export class SidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'autodebug.sidebarView';
    private _view?: vscode.WebviewView;
    private extensionUri: vscode.Uri;
    /** Messages queued before the webview view is resolved. Flushed on first open. */
    private _pendingMessages: object[] = [];
    /** Message handlers registered before the view was resolved. Applied on first open. */
    private _pendingHandlers: Array<(message: SidebarMessage) => void> = [];
    private _handlerDisposables: vscode.Disposable[] = [];

    constructor(extensionUri: vscode.Uri) {
        this.extensionUri = extensionUri;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extensionUri, 'src', 'webview')
            ]
        };

        webviewView.webview.html = this.getHtmlContent(webviewView.webview);

        // Apply any handlers registered before the view was ready
        for (const handler of this._pendingHandlers) {
            const d = webviewView.webview.onDidReceiveMessage(handler);
            this._handlerDisposables.push(d);
        }
        this._pendingHandlers = [];

        // Flush any messages that were posted before the view was ready
        if (this._pendingMessages.length > 0) {
            // Give the webview JS a moment to initialize before replaying
            setTimeout(() => {
                for (const msg of this._pendingMessages) {
                    webviewView.webview.postMessage(msg).then(undefined, (err) => {
                        logger.warn('SidebarProvider: failed to flush pending message', err);
                    });
                }
                this._pendingMessages = [];
            }, 300);
        }
    }

    /** Reveal the sidebar panel. If it hasn't been opened yet this triggers resolveWebviewView. */
    reveal(): void {
        if (this._view) {
            this._view.show(true);
        } else {
            // Force the panel open — this will trigger resolveWebviewView
            vscode.commands.executeCommand(`${SidebarProvider.viewType}.focus`);
        }
    }

    postMessage(message: object): void {
        if (this._view) {
            this._view.webview.postMessage(message).then(undefined, (err) => {
                logger.warn('SidebarProvider: failed to post message', err);
            });
        } else {
            // Queue the message — it will be flushed when the view opens
            this._pendingMessages.push(message);
        }
    }

    onMessage(handler: (message: SidebarMessage) => void): vscode.Disposable | undefined {
        if (this._view) {
            const d = this._view.webview.onDidReceiveMessage(handler);
            this._handlerDisposables.push(d);
            return d;
        }
        // Queue the handler — it will be applied when resolveWebviewView fires
        this._pendingHandlers.push(handler);
        return new vscode.Disposable(() => {
            const idx = this._pendingHandlers.indexOf(handler);
            if (idx !== -1) { this._pendingHandlers.splice(idx, 1); }
        });
    }

    updateErrors(results: ErrorAnalysisResult[]): void {
        this.postMessage({ type: 'updateErrors', errors: results.map(r => this.serializeResult(r)) });
    }

    updateHeatmap(entries: HeatmapEntry[]): void {
        this.postMessage({ type: 'updateHeatmap', entries });
    }

    updateChat(history: ChatMessage[]): void {
        this.postMessage({ type: 'updateChat', history });
    }

    /**
     * Push a Module Splitter plan summary to the sidebar webview.
     * The webview can render a compact card showing split count,
     * health score, circular risks, and extraction file names.
     */
    updateSplitPlan(plan: SplitPlan): void {
        this.postMessage({
            type: 'splitPlan',
            data: {
                sourceFile:       plan.sourceFile,
                language:         plan.language,
                parseEngine:      plan.parseEngine,
                health:           plan.metrics.overallHealth,
                maintainability:  plan.metrics.maintainabilityIndex,
                avgComplexity:    plan.metrics.avgCyclomaticComplexity,
                extractionCount:  plan.summary.extractionCount,
                retainedCount:    plan.summary.retainedCount,
                typeRoutingCount: plan.summary.typeRoutingCount,
                circularRisks:    plan.circularRisks,
                smellCount:       plan.codeSmells.length,
                criticalSmells:   plan.codeSmells.filter(s => s.severity === 'critical').map(s => s.name),
                proposedFiles:    plan.proposedFiles.map(pf => ({
                    fileName:    pf.fileName,
                    regionName:  pf.regionName,
                    lines:       pf.estimatedLines,
                    testFile:    pf.testFilePath,
                    linkedTo:    pf.linkedTo,
                    linkedFrom:  pf.linkedFrom,
                    routedTo:    pf.routedToExisting,
                    generatedContent: pf.generatedContent,
                })),
                recommendation:   plan.summary.recommendation,
            },
        });
    }

    showLoading(message: string): void {
        this.postMessage({ type: 'loading', message });
    }

    showError(message: string): void {
        this.postMessage({ type: 'error', message });
    }

    private serializeResult(r: ErrorAnalysisResult): object {
        return {
            id: r.error.id,
            type: r.error.type,
            message: r.error.message,
            severity: r.error.severity,
            file: r.error.relativeFile,
            line: r.error.line,
            column: r.error.column,
            source: r.error.source,
            timestamp: r.error.timestamp,
            summary: {
                explanation: r.summary.explanation,
                possibleCause: r.summary.possibleCause,
                suggestedFix: r.summary.suggestedFix,
                codeExample: r.summary.codeExample,
                documentationLinks: r.summary.documentationLinks,
                confidence: r.summary.confidence
            }
        };
    }

    private getHtmlContent(webview: vscode.Webview): string {
        const webviewPath = path.join(this.extensionUri.fsPath, 'src', 'webview', 'dashboard.html');
        try {
            let html = fs.readFileSync(webviewPath, 'utf-8');
            // Replace asset src/href with webview URIs
            html = html.replace(/__CSP_NONCE__/g, this.generateNonce());
            return html;
        } catch {
            return this.getFallbackHtml(webview);
        }
    }

    private generateNonce(): string {
        let nonce = '';
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            nonce += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return nonce;
    }

    private getFallbackHtml(_webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>AutoDebug AI</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); margin: 0; padding: 8px; }
  </style>
</head>
<body>
  <p>AutoDebug AI loaded. Open a file with errors to begin.</p>
</body>
</html>`;
    }

    get view(): vscode.WebviewView | undefined {
        return this._view;
    }
}
