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
exports.SidebarProvider = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const logger_1 = require("../utils/logger");
class SidebarProvider {
    constructor(extensionUri) {
        /** Messages queued before the webview view is resolved. Flushed on first open. */
        this._pendingMessages = [];
        /** Message handlers registered before the view was resolved. Applied on first open. */
        this._pendingHandlers = [];
        this._handlerDisposables = [];
        this.extensionUri = extensionUri;
    }
    resolveWebviewView(webviewView, _context, _token) {
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
                        logger_1.logger.warn('SidebarProvider: failed to flush pending message', err);
                    });
                }
                this._pendingMessages = [];
            }, 300);
        }
    }
    /** Reveal the sidebar panel. If it hasn't been opened yet this triggers resolveWebviewView. */
    reveal() {
        if (this._view) {
            this._view.show(true);
        }
        else {
            // Force the panel open — this will trigger resolveWebviewView
            vscode.commands.executeCommand(`${SidebarProvider.viewType}.focus`);
        }
    }
    postMessage(message) {
        if (this._view) {
            this._view.webview.postMessage(message).then(undefined, (err) => {
                logger_1.logger.warn('SidebarProvider: failed to post message', err);
            });
        }
        else {
            // Queue the message — it will be flushed when the view opens
            this._pendingMessages.push(message);
        }
    }
    onMessage(handler) {
        if (this._view) {
            const d = this._view.webview.onDidReceiveMessage(handler);
            this._handlerDisposables.push(d);
            return d;
        }
        // Queue the handler — it will be applied when resolveWebviewView fires
        this._pendingHandlers.push(handler);
        return new vscode.Disposable(() => {
            const idx = this._pendingHandlers.indexOf(handler);
            if (idx !== -1) {
                this._pendingHandlers.splice(idx, 1);
            }
        });
    }
    updateErrors(results) {
        this.postMessage({ type: 'updateErrors', errors: results.map(r => this.serializeResult(r)) });
    }
    updateHeatmap(entries) {
        this.postMessage({ type: 'updateHeatmap', entries });
    }
    updateChat(history) {
        this.postMessage({ type: 'updateChat', history });
    }
    /**
     * Push a Module Splitter plan summary to the sidebar webview.
     * The webview can render a compact card showing split count,
     * health score, circular risks, and extraction file names.
     */
    updateSplitPlan(plan) {
        this.postMessage({
            type: 'splitPlan',
            data: {
                sourceFile: plan.sourceFile,
                language: plan.language,
                parseEngine: plan.parseEngine,
                health: plan.metrics.overallHealth,
                maintainability: plan.metrics.maintainabilityIndex,
                avgComplexity: plan.metrics.avgCyclomaticComplexity,
                extractionCount: plan.summary.extractionCount,
                retainedCount: plan.summary.retainedCount,
                typeRoutingCount: plan.summary.typeRoutingCount,
                circularRisks: plan.circularRisks,
                smellCount: plan.codeSmells.length,
                criticalSmells: plan.codeSmells.filter(s => s.severity === 'critical').map(s => s.name),
                proposedFiles: plan.proposedFiles.map(pf => ({
                    fileName: pf.fileName,
                    regionName: pf.regionName,
                    lines: pf.estimatedLines,
                    testFile: pf.testFilePath,
                    linkedTo: pf.linkedTo,
                    linkedFrom: pf.linkedFrom,
                    routedTo: pf.routedToExisting,
                    generatedContent: pf.generatedContent,
                })),
                recommendation: plan.summary.recommendation,
            },
        });
    }
    showLoading(message) {
        this.postMessage({ type: 'loading', message });
    }
    showError(message) {
        this.postMessage({ type: 'error', message });
    }
    serializeResult(r) {
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
    getHtmlContent(webview) {
        const webviewPath = path.join(this.extensionUri.fsPath, 'src', 'webview', 'dashboard.html');
        try {
            let html = fs.readFileSync(webviewPath, 'utf-8');
            // Replace asset src/href with webview URIs
            html = html.replace(/__CSP_NONCE__/g, this.generateNonce());
            return html;
        }
        catch {
            return this.getFallbackHtml(webview);
        }
    }
    generateNonce() {
        let nonce = '';
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            nonce += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return nonce;
    }
    getFallbackHtml(_webview) {
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
    get view() {
        return this._view;
    }
}
exports.SidebarProvider = SidebarProvider;
SidebarProvider.viewType = 'autodebug.sidebarView';
//# sourceMappingURL=sidebarProvider.js.map