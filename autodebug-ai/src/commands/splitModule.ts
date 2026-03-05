import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { moduleSplitter, WorkspaceContext, SplitPlan, ProposedFile } from '../modules/moduleSplitter';
import { llmService } from '../services/llmService';
import { logger } from '../utils/logger';
import { SidebarProvider } from '../providers/sidebarProvider';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SplitMode = 'ast' | 'ai' | 'ast+ai';

/** Last analysed plan — held in memory so the "create files" action works. */
let _lastPlan: SplitPlan | null = null;
let _lastSourceFile: string | null = null;

/** Registered singleton sidebar provider — set by extension.ts on activation. */
let _sidebarProvider: SidebarProvider | undefined;

export function registerSidebarForSplitter(provider: SidebarProvider): void {
    _sidebarProvider = provider;
}

// ── Workspace context ─────────────────────────────────────────────────────────

/** Scan the workspace for existing type / hook / utility / barrel files. */
async function buildWorkspaceContext(sourceFilePath: string): Promise<WorkspaceContext> {
    const uriToPath = (uris: vscode.Uri[]): string[] => uris.map(u => u.fsPath);

    const [typeUris, hookUris, utilUris, indexUris] = await Promise.all([
        vscode.workspace.findFiles('**/{types,type,interfaces,*.d}.{ts,tsx}', '**/node_modules/**', 30),
        vscode.workspace.findFiles('**/hooks/use*.{ts,tsx}',                   '**/node_modules/**', 30),
        vscode.workspace.findFiles('**/utils/*.{ts,tsx,js,jsx}',              '**/node_modules/**', 30),
        vscode.workspace.findFiles('**/index.{ts,tsx,js,jsx}',                '**/node_modules/**', 30),
    ]);

    return {
        existingTypeFiles:  uriToPath(typeUris),
        existingHookFiles:  uriToPath(hookUris),
        existingUtilFiles:  uriToPath(utilUris),
        existingIndexFiles: uriToPath(indexUris),
        sourceDir:          path.dirname(sourceFilePath),
    };
}

// ── AI enhancement ────────────────────────────────────────────────────────────

/**
 * Ask the LLM to rewrite the generated content for each proposed file
 * with proper imports, full export syntax, and connectivity comments.
 */
async function enhanceWithAI(
    plan: SplitPlan,
    sourceCode: string,
    progress?: vscode.Progress<{ message?: string }>
): Promise<void> {
    const candidates = plan.proposedFiles.filter(pf => !pf.routedToExisting);
    if (candidates.length === 0) { return; }

    for (let i = 0; i < candidates.length; i++) {
        const pf = candidates[i];
        progress?.report({ message: `AI enhancing ${pf.fileName} (${i + 1}/${candidates.length})…` });

        const region = plan.regions.find(r => r.id === pf.sourceRegionId);
        if (!region) { continue; }

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
            const resp = await llmService.send([
                { role: 'system', content: 'You write clean, production-ready TypeScript/React. Output file content only — no code fences.' },
                { role: 'user',   content: prompt },
            ], undefined, 2048);
            if (resp.text.trim().length > 40) {
                let content = resp.text.trim()
                    .replace(/^```(?:typescript|ts|tsx|javascript|js|jsx)?\n?/i, '')
                    .replace(/\n?```\s*$/i, '');
                pf.generatedContent = content;
            }
        } catch (err) {
            logger.warn(`splitModule: AI enhancement failed for ${pf.fileName}`, err);
        }
    }
}

// ── File creation ─────────────────────────────────────────────────────────────

export async function createSplitFiles(plan: SplitPlan, sourceFilePath: string): Promise<void> {
    const sourceDir = path.dirname(sourceFilePath);
    const files     = plan.proposedFiles.filter(pf => !pf.routedToExisting);

    if (files.length === 0) {
        vscode.window.showInformationMessage('AutoDebug AI: No files to create — all regions retained.');
        return;
    }

    // Show a QuickPick so user can confirm which files to write
    const items = files.map(pf => ({
        label:       `$(new-file) ${pf.fileName}`,
        description: `~${pf.estimatedLines} lines`,
        detail:      `Region: ${pf.regionName}`,
        picked:      true,
    }));

    const chosen = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: `Select files to create (${files.length} proposed)`,
        title:       'AutoDebug AI — Create Split Files',
    });

    if (!chosen || chosen.length === 0) { return; }

    const selectedNames = new Set(chosen.map((c: vscode.QuickPickItem) => c.label.replace('$(new-file) ', '')));
    const toCreate      = files.filter(pf => selectedNames.has(pf.fileName));

    let created = 0;
    let skipped = 0;

    for (const pf of toCreate) {
        const abs = path.join(sourceDir, pf.fileName);
        const dir = path.dirname(abs);

        if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }

        if (fs.existsSync(abs)) {
            const overwrite = await vscode.window.showWarningMessage(
                `${pf.fileName} already exists. Overwrite?`, { modal: false }, 'Overwrite', 'Skip'
            );
            if (overwrite !== 'Overwrite') { skipped++; continue; }
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

    vscode.window.showInformationMessage(
        `AutoDebug AI: Created ${created} file(s)${skipped > 0 ? `, skipped ${skipped}` : ''}.`
    );
}

// ── Main command ──────────────────────────────────────────────────────────────

export async function splitModuleCommand(mode?: SplitMode): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage('AutoDebug AI: Open a source file to split.');
        return;
    }

    const doc      = editor.document;
    const fileName = doc.fileName;
    const ext      = fileName.split('.').pop()?.toLowerCase() ?? '';

    const supported = ['ts', 'tsx', 'js', 'jsx', 'py', 'java', 'cs', 'go', 'rs', 'php'];
    if (!supported.includes(ext)) {
        vscode.window.showWarningMessage(
            `AutoDebug AI: Module Splitter supports ${supported.join(', ')} files. This file (${ext}) is not yet supported.`
        );
        return;
    }

    // If mode wasn't passed, ask the user
    if (!mode) {
        const pick = await vscode.window.showQuickPick([
            { label: '$(symbol-misc) AST Only',         description: 'Fast structural analysis (no AI)', id: 'ast'    as SplitMode },
            { label: '$(sparkle) AI Only',              description: 'AI-driven split with full code',   id: 'ai'     as SplitMode },
            { label: '$(symbol-misc)$(sparkle) AST + AI', description: 'AST analysis enhanced with AI', id: 'ast+ai' as SplitMode },
        ], { placeHolder: 'Choose split mode', title: 'AutoDebug AI — Module Splitter' });
        if (!pick) { return; }
        mode = (pick as { label: string; id: SplitMode }).id;
    }

    const sourceCode = doc.getText();
    const shortName  = fileName.split('/').pop() ?? fileName;
    const useAI      = mode === 'ai' || mode === 'ast+ai';

    await vscode.window.withProgress(
        {
            location:    vscode.ProgressLocation.Notification,
            title:       `AutoDebug AI: Splitting ${shortName} [${mode}]…`,
            cancellable: false,
        },
        async progress => {
            try {
                if (_sidebarProvider) {
                    _sidebarProvider.reveal();
                    await new Promise(r => setTimeout(r, 400));
                    _sidebarProvider.postMessage({
                        type:    'splitLoading',
                        message: `${mode === 'ast' ? '⚙ AST' : mode === 'ai' ? '✦ AI' : '⚙+✦ AST+AI'} analysing ${shortName}…`,
                    });
                }
                await new Promise(r => setTimeout(r, 80));

                progress.report({ message: 'scanning workspace…' });
                const ctx = await buildWorkspaceContext(fileName);

                progress.report({ message: 'parsing AST…' });
                const plan: SplitPlan = moduleSplitter.analyse(sourceCode, shortName, ctx);

                if (useAI && plan.proposedFiles.length > 0) {
                    progress.report({ message: `AI enhancing ${plan.proposedFiles.length} region(s)…` });
                    await enhanceWithAI(plan, sourceCode, progress);
                }

                // Remember for "Create Files" action
                _lastPlan       = plan;
                _lastSourceFile = fileName;

                // Open rich webview report
                progress.report({ message: 'building report…' });
                const html  = moduleSplitter.buildHtmlReport(plan);
                const panel = vscode.window.createWebviewPanel(
                    'autodebug.moduleSplitter',
                    `Split — ${shortName}`,
                    vscode.ViewColumn.Beside,
                    { enableScripts: true }
                );
                panel.webview.html = html;

                if (_sidebarProvider) {
                    _sidebarProvider.updateSplitPlan(plan);
                }

                const msg =
                    plan.summary.extractionCount === 0
                        ? `✔ ${shortName} is healthy (MI ${plan.metrics.maintainabilityIndex}/100). No splits needed.`
                        : `${plan.summary.extractionCount} module(s) identified — click "Create Files" in sidebar.`;

                vscode.window.showInformationMessage(`AutoDebug AI: ${msg}`);

                logger.info(
                    `ModuleSplitter[${mode}]: ${plan.regions.length} region(s), ` +
                    `${plan.summary.extractionCount} extraction(s), ` +
                    `${plan.circularRisks.length} circular risk(s)`
                );
            } catch (err) {
                logger.error('splitModuleCommand failed', err);
                vscode.window.showErrorMessage('AutoDebug AI: Module Splitter failed. See Output panel for details.');
                if (_sidebarProvider) {
                    _sidebarProvider.postMessage({ type: 'splitError', message: 'Analysis failed. See Output panel.' });
                }
            }
        }
    );
}

/** Called when user picks a mode from the sidebar buttons. */
export async function splitWithModeCommand(mode: SplitMode): Promise<void> {
    await splitModuleCommand(mode);
}

/** Called from the sidebar "Create Files" button. */
export async function createSplitFilesCommand(): Promise<void> {
    if (!_lastPlan || !_lastSourceFile) {
        vscode.window.showWarningMessage('AutoDebug AI: Run a Split analysis first.');
        return;
    }
    await createSplitFiles(_lastPlan, _lastSourceFile);
}
