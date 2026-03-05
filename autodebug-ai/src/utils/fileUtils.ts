import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export function getWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
    return vscode.workspace.workspaceFolders ?? [];
}

export function getWorkspaceRoot(): string | undefined {
    return getWorkspaceFolders()[0]?.uri.fsPath;
}

export function isWorkspaceFile(filePath: string): boolean {
    const root = getWorkspaceRoot();
    if (!root) { return false; }
    return filePath.startsWith(root) && !filePath.includes('node_modules');
}

export function getRelativePath(filePath: string): string {
    const root = getWorkspaceRoot();
    if (!root) { return filePath; }
    return path.relative(root, filePath);
}

export function readFileSync(filePath: string): string | null {
    try {
        return fs.readFileSync(filePath, 'utf-8');
    } catch {
        return null;
    }
}

export async function readFileAsync(filePath: string): Promise<string | null> {
    try {
        const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
        return Buffer.from(content).toString('utf-8');
    } catch {
        return null;
    }
}

export function getLineFromFile(filePath: string, lineNumber: number): string | null {
    const content = readFileSync(filePath);
    if (!content) { return null; }
    const lines = content.split('\n');
    return lines[lineNumber] ?? null;
}

export function getLinesAround(filePath: string, lineNumber: number, context = 3): string[] {
    const content = readFileSync(filePath);
    if (!content) { return []; }
    const lines = content.split('\n');
    const start = Math.max(0, lineNumber - context);
    const end = Math.min(lines.length - 1, lineNumber + context);
    return lines.slice(start, end + 1).map((line, i) => `${start + i + 1}: ${line}`);
}

export function uriToPath(uri: vscode.Uri): string {
    return uri.fsPath;
}

export function pathToUri(filePath: string): vscode.Uri {
    return vscode.Uri.file(filePath);
}
