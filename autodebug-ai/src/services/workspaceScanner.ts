import * as vscode from 'vscode';
import * as path from 'path';
import { isWorkspaceFile, getRelativePath } from '../utils/fileUtils';
import { logger } from '../utils/logger';

export interface HeatmapEntry {
    file: string;
    relativeFile: string;
    errorCount: number;
    warningCount: number;
    totalCount: number;
    lastUpdated: number;
}

export class WorkspaceScanner {
    private fileContentCache: Map<string, string> = new Map();
    private heatmap: Map<string, HeatmapEntry> = new Map();
    private readonly cacheMaxAge = 30_000; // 30 seconds
    private cacheTimestamps: Map<string, number> = new Map();

    async scanWorkspace(): Promise<Map<string, string>> {
        const result = new Map<string, string>();
        const folders = vscode.workspace.workspaceFolders;
        if (!folders) { return result; }

        const include = '**/*.{ts,tsx,js,jsx,py,java,cs,go,rb,php,swift,kt}';
        const exclude = '**/node_modules/**,**/dist/**,**/out/**,**/.git/**,**/build/**';

        try {
            const files = await vscode.workspace.findFiles(include, exclude, 500);
            await Promise.all(files.map(async (uri) => {
                try {
                    const content = await vscode.workspace.fs.readFile(uri);
                    const text = Buffer.from(content).toString('utf-8');
                    result.set(uri.fsPath, text);
                    this.fileContentCache.set(uri.fsPath, text);
                    this.cacheTimestamps.set(uri.fsPath, Date.now());
                } catch {
                    // skip unreadable files
                }
            }));
        } catch (err) {
            logger.warn('WorkspaceScanner: scan failed', err);
        }

        return result;
    }

    async getFileContent(filePath: string): Promise<string | null> {
        const ts = this.cacheTimestamps.get(filePath);
        if (ts && Date.now() - ts < this.cacheMaxAge) {
            return this.fileContentCache.get(filePath) ?? null;
        }
        try {
            const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
            const text = Buffer.from(content).toString('utf-8');
            this.fileContentCache.set(filePath, text);
            this.cacheTimestamps.set(filePath, Date.now());
            return text;
        } catch {
            return null;
        }
    }

    updateHeatmap(uri: vscode.Uri, diagnostics: readonly vscode.Diagnostic[]): void {
        const filePath = uri.fsPath;
        if (!isWorkspaceFile(filePath)) { return; }

        const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
        const warnings = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Warning).length;

        this.heatmap.set(filePath, {
            file: filePath,
            relativeFile: getRelativePath(filePath),
            errorCount: errors,
            warningCount: warnings,
            totalCount: errors + warnings,
            lastUpdated: Date.now()
        });
    }

    getHeatmap(): HeatmapEntry[] {
        return Array.from(this.heatmap.values())
            .filter(e => e.totalCount > 0)
            .sort((a, b) => b.totalCount - a.totalCount);
    }

    getTopErrorFiles(limit = 10): HeatmapEntry[] {
        return this.getHeatmap().slice(0, limit);
    }

    findImports(filePath: string, content: string): string[] {
        const imports: string[] = [];
        const patterns = [
            /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
            /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
            /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        ];
        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(content)) !== null) {
                const importPath = match[1];
                if (importPath && !importPath.startsWith('.')) { continue; }
                if (importPath) {
                    // Resolve relative to the file's directory
                    const dir = path.dirname(filePath);
                    const resolved = path.resolve(dir, importPath);
                    imports.push(resolved);
                }
            }
        }
        return [...new Set(imports)];
    }

    async getContextForFile(filePath: string): Promise<Map<string, string>> {
        const ctx = new Map<string, string>();
        const content = await this.getFileContent(filePath);
        if (!content) { return ctx; }

        ctx.set(filePath, content);

        const imports = this.findImports(filePath, content);
        for (const imp of imports) {
            for (const ext of ['.ts', '.tsx', '.js', '.jsx', '']) {
                const full = imp + ext;
                const c = await this.getFileContent(full);
                if (c) {
                    ctx.set(full, c);
                    break;
                }
            }
        }
        return ctx;
    }

    clearCache(): void {
        this.fileContentCache.clear();
        this.cacheTimestamps.clear();
    }

    dispose(): void {
        this.clearCache();
        this.heatmap.clear();
    }
}

export const workspaceScanner = new WorkspaceScanner();
