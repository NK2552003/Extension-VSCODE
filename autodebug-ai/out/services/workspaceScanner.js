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
exports.workspaceScanner = exports.WorkspaceScanner = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fileUtils_1 = require("../utils/fileUtils");
const logger_1 = require("../utils/logger");
class WorkspaceScanner {
    constructor() {
        this.fileContentCache = new Map();
        this.heatmap = new Map();
        this.cacheMaxAge = 30000; // 30 seconds
        this.cacheTimestamps = new Map();
    }
    async scanWorkspace() {
        const result = new Map();
        const folders = vscode.workspace.workspaceFolders;
        if (!folders) {
            return result;
        }
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
                }
                catch {
                    // skip unreadable files
                }
            }));
        }
        catch (err) {
            logger_1.logger.warn('WorkspaceScanner: scan failed', err);
        }
        return result;
    }
    async getFileContent(filePath) {
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
        }
        catch {
            return null;
        }
    }
    updateHeatmap(uri, diagnostics) {
        const filePath = uri.fsPath;
        if (!(0, fileUtils_1.isWorkspaceFile)(filePath)) {
            return;
        }
        const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
        const warnings = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Warning).length;
        this.heatmap.set(filePath, {
            file: filePath,
            relativeFile: (0, fileUtils_1.getRelativePath)(filePath),
            errorCount: errors,
            warningCount: warnings,
            totalCount: errors + warnings,
            lastUpdated: Date.now()
        });
    }
    getHeatmap() {
        return Array.from(this.heatmap.values())
            .filter(e => e.totalCount > 0)
            .sort((a, b) => b.totalCount - a.totalCount);
    }
    getTopErrorFiles(limit = 10) {
        return this.getHeatmap().slice(0, limit);
    }
    findImports(filePath, content) {
        const imports = [];
        const patterns = [
            /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
            /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
            /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        ];
        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(content)) !== null) {
                const importPath = match[1];
                if (importPath && !importPath.startsWith('.')) {
                    continue;
                }
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
    async getContextForFile(filePath) {
        const ctx = new Map();
        const content = await this.getFileContent(filePath);
        if (!content) {
            return ctx;
        }
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
    clearCache() {
        this.fileContentCache.clear();
        this.cacheTimestamps.clear();
    }
    dispose() {
        this.clearCache();
        this.heatmap.clear();
    }
}
exports.WorkspaceScanner = WorkspaceScanner;
exports.workspaceScanner = new WorkspaceScanner();
//# sourceMappingURL=workspaceScanner.js.map