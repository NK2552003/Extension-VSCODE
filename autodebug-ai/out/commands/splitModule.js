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
exports.registerSidebarForSplitter = registerSidebarForSplitter;
exports.createSplitFiles = createSplitFiles;
exports.splitModuleCommand = splitModuleCommand;
exports.splitWithModeCommand = splitWithModeCommand;
exports.createSplitFilesCommand = createSplitFilesCommand;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const moduleSplitter_1 = require("../modules/moduleSplitter");
const llmService_1 = require("../services/llmService");
const logger_1 = require("../utils/logger");
/** Last analysed plan — held in memory so the "create files" action works. */
let _lastPlan = null;
let _lastSourceFile = null;
/** Registered singleton sidebar provider — set by extension.ts on activation. */
let _sidebarProvider;
function registerSidebarForSplitter(provider) {
    _sidebarProvider = provider;
}
// ── Workspace context ─────────────────────────────────────────────────────────
/** Scan the workspace for existing type / hook / utility / barrel files. */
async function buildWorkspaceContext(sourceFilePath) {
    const uriToPath = (uris) => uris.map(u => u.fsPath);
    const [typeUris, hookUris, utilUris, indexUris] = await Promise.all([
        vscode.workspace.findFiles('**/{types,type,interfaces,*.d}.{ts,tsx}', '**/node_modules/**', 30),
        vscode.workspace.findFiles('**/hooks/use*.{ts,tsx}', '**/node_modules/**', 30),
        vscode.workspace.findFiles('**/utils/*.{ts,tsx,js,jsx}', '**/node_modules/**', 30),
        vscode.workspace.findFiles('**/index.{ts,tsx,js,jsx}', '**/node_modules/**', 30),
    ]);
    return {
        existingTypeFiles: uriToPath(typeUris),
        existingHookFiles: uriToPath(hookUris),
        existingUtilFiles: uriToPath(utilUris),
        existingIndexFiles: uriToPath(indexUris),
        sourceDir: path.dirname(sourceFilePath),
    };
}
// ── AI enhancement ────────────────────────────────────────────────────────────
/**
 * Ask the LLM to rewrite the generated content for each proposed file
 * with proper imports, full export syntax, and connectivity comments.
 */
async function enhanceWithAI(plan, sourceCode, progress) {
    const candidates = plan.proposedFiles.filter(pf => !pf.routedToExisting);
    if (candidates.length === 0) {
        return;
    }
    for (let i = 0; i < candidates.length; i++) {
        const pf = candidates[i];
        progress?.report({ message: `AI enhancing ${pf.fileName} (${i + 1}/${candidates.length})…` });
        const region = plan.regions.find(r => r.id === pf.sourceRegionId);
        if (!region) {
            continue;
        }
        const regionSrc = sourceCode
            .split('\n')
            .slice(region.startLine - 1, region.endLine)
            .join('\n');
        const prompt = `You are a senior TypeScript/React engineer performing a module split.

SOURCE FILE: ${plan.sourceFile}  (${plan.language})

REGION TO EXTRACT — "${region.name}" (${region.kind}):
\`\`\`
${regionSrc}
\`\`\`

OTHER REGIONS IN THE SAME FILE (connectivity context):
${plan.regions.filter(r => r.id !== region.id).map(r => `• ${r.name} (${r.kind})`).join('\n')}

YOUR TASK: Produce the complete content of the new file: ${pf.fileName}

Rules:
1. Include ALL necessary import statements at the top.
2. Preserve the EXACT original logic — do not refactor behaviour.
3. Add a named export for "${region.name}".
4. Add a brief JSDoc comment explaining what was extracted and why.
5. If the region depends on symbols from the same source file, add: // TODO: import { <symbol> } from './<sourceBase>'
6. Output ONLY the file content — no markdown fences, no explanations.`;
        try {
            const resp = await llmService_1.llmService.send([
                { role: 'system', content: 'You write clean, production-ready TypeScript/React. Output file content only — no code fences.' },
                { role: 'user', content: prompt },
            ], undefined, 2048);
            if (resp.text.trim().length > 40) {
                let content = resp.text.trim()
                    .replace(/^```(?:typescript|ts|tsx|javascript|js|jsx)?\n?/i, '')
                    .replace(/\n?```\s*$/i, '');
                pf.generatedContent = content;
            }
        }
        catch (err) {
            logger_1.logger.warn(`splitModule: AI enhancement failed for ${pf.fileName}`, err);
        }
    }
}
// ── File creation ─────────────────────────────────────────────────────────────
async function createSplitFiles(plan, sourceFilePath) {
    const sourceDir = path.dirname(sourceFilePath);
    const files = plan.proposedFiles.filter(pf => !pf.routedToExisting);
    if (files.length === 0) {
        vscode.window.showInformationMessage('AutoDebug AI: No files to create — all regions retained.');
        return;
    }
    // Show a QuickPick so user can confirm which files to write
    const items = files.map(pf => ({
        label: `$(new-file) ${pf.fileName}`,
        description: `~${pf.estimatedLines} lines`,
        detail: `Region: ${pf.regionName}`,
        picked: true,
    }));
    const chosen = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: `Select files to create (${files.length} proposed)`,
        title: 'AutoDebug AI — Create Split Files',
    });
    if (!chosen || chosen.length === 0) {
        return;
    }
    const selectedNames = new Set(chosen.map((c) => c.label.replace('$(new-file) ', '')));
    const toCreate = files.filter(pf => selectedNames.has(pf.fileName));
    let created = 0;
    let skipped = 0;
    for (const pf of toCreate) {
        const abs = path.join(sourceDir, pf.fileName);
        const dir = path.dirname(abs);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        if (fs.existsSync(abs)) {
            const overwrite = await vscode.window.showWarningMessage(`${pf.fileName} already exists. Overwrite?`, { modal: false }, 'Overwrite', 'Skip');
            if (overwrite !== 'Overwrite') {
                skipped++;
                continue;
            }
        }
        fs.writeFileSync(abs, pf.generatedContent, 'utf-8');
        created++;
        const uri = vscode.Uri.file(abs);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
    }
    // Write barrel index only if it doesn't exist yet
    if (created > 0 && plan.barrelExport) {
        const indexPath = path.join(sourceDir, 'index.ts');
        if (!fs.existsSync(indexPath)) {
            fs.writeFileSync(indexPath, plan.barrelExport, 'utf-8');
        }
    }
    vscode.window.showInformationMessage(`AutoDebug AI: Created ${created} file(s)${skipped > 0 ? `, skipped ${skipped}` : ''}.`);
}
// ── Main command ──────────────────────────────────────────────────────────────
async function splitModuleCommand(mode) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage('AutoDebug AI: Open a source file to split.');
        return;
    }
    const doc = editor.document;
    const fileName = doc.fileName;
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    const supported = ['ts', 'tsx', 'js', 'jsx', 'py', 'java', 'cs', 'go', 'rs', 'php'];
    if (!supported.includes(ext)) {
        vscode.window.showWarningMessage(`AutoDebug AI: Module Splitter supports ${supported.join(', ')} files. This file (${ext}) is not yet supported.`);
        return;
    }
    // If mode wasn't passed, ask the user
    if (!mode) {
        const pick = await vscode.window.showQuickPick([
            { label: '$(symbol-misc) AST Only', description: 'Fast structural analysis (no AI)', id: 'ast' },
            { label: '$(sparkle) AI Only', description: 'AI-driven split with full code', id: 'ai' },
            { label: '$(symbol-misc)$(sparkle) AST + AI', description: 'AST analysis enhanced with AI', id: 'ast+ai' },
        ], { placeHolder: 'Choose split mode', title: 'AutoDebug AI — Module Splitter' });
        if (!pick) {
            return;
        }
        mode = pick.id;
    }
    const sourceCode = doc.getText();
    const shortName = fileName.split('/').pop() ?? fileName;
    const useAI = mode === 'ai' || mode === 'ast+ai';
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `AutoDebug AI: Splitting ${shortName} [${mode}]…`,
        cancellable: false,
    }, async (progress) => {
        try {
            if (_sidebarProvider) {
                _sidebarProvider.reveal();
                await new Promise(r => setTimeout(r, 400));
                _sidebarProvider.postMessage({
                    type: 'splitLoading',
                    message: `${mode === 'ast' ? '⚙ AST' : mode === 'ai' ? '✦ AI' : '⚙+✦ AST+AI'} analysing ${shortName}…`,
                });
            }
            await new Promise(r => setTimeout(r, 80));
            progress.report({ message: 'scanning workspace…' });
            const ctx = await buildWorkspaceContext(fileName);
            progress.report({ message: 'parsing AST…' });
            const plan = moduleSplitter_1.moduleSplitter.analyse(sourceCode, shortName, ctx);
            if (useAI && plan.proposedFiles.length > 0) {
                progress.report({ message: `AI enhancing ${plan.proposedFiles.length} region(s)…` });
                await enhanceWithAI(plan, sourceCode, progress);
            }
            // Remember for "Create Files" action
            _lastPlan = plan;
            _lastSourceFile = fileName;
            // Open rich webview report
            progress.report({ message: 'building report…' });
            const html = moduleSplitter_1.moduleSplitter.buildHtmlReport(plan);
            const panel = vscode.window.createWebviewPanel('autodebug.moduleSplitter', `Split — ${shortName}`, vscode.ViewColumn.Beside, { enableScripts: true });
            panel.webview.html = html;
            if (_sidebarProvider) {
                _sidebarProvider.updateSplitPlan(plan);
            }
            const msg = plan.summary.extractionCount === 0
                ? `✔ ${shortName} is healthy (MI ${plan.metrics.maintainabilityIndex}/100). No splits needed.`
                : `${plan.summary.extractionCount} module(s) identified — click "Create Files" in sidebar.`;
            vscode.window.showInformationMessage(`AutoDebug AI: ${msg}`);
            logger_1.logger.info(`ModuleSplitter[${mode}]: ${plan.regions.length} region(s), ` +
                `${plan.summary.extractionCount} extraction(s), ` +
                `${plan.circularRisks.length} circular risk(s)`);
        }
        catch (err) {
            logger_1.logger.error('splitModuleCommand failed', err);
            vscode.window.showErrorMessage('AutoDebug AI: Module Splitter failed. See Output panel for details.');
            if (_sidebarProvider) {
                _sidebarProvider.postMessage({ type: 'splitError', message: 'Analysis failed. See Output panel.' });
            }
        }
    });
}
/** Called when user picks a mode from the sidebar buttons. */
async function splitWithModeCommand(mode) {
    await splitModuleCommand(mode);
}
/** Called from the sidebar "Create Files" button. */
async function createSplitFilesCommand() {
    if (!_lastPlan || !_lastSourceFile) {
        vscode.window.showWarningMessage('AutoDebug AI: Run a Split analysis first.');
        return;
    }
    await createSplitFiles(_lastPlan, _lastSourceFile);
}
//# sourceMappingURL=splitModule.js.map