import * as vscode from 'vscode';
import { getRelativePath, isWorkspaceFile } from '../utils/fileUtils';

export interface ParsedError {
    id: string;
    message: string;
    type: string;
    severity: vscode.DiagnosticSeverity;
    file: string;
    relativeFile: string;
    line: number;
    column: number;
    source: string;
    code: string | number | undefined;
    stackTrace: StackFrame[];
    rawDiagnostic?: vscode.Diagnostic;
    timestamp: number;
}

export interface StackFrame {
    raw: string;
    file: string;
    line: number;
    column: number;
    functionName: string;
    isWorkspaceFile: boolean;
}

let errorCounter = 0;

export function parseDiagnostic(
    diagnostic: vscode.Diagnostic,
    uri: vscode.Uri
): ParsedError {
    const filePath = uri.fsPath;
    return {
        id: `error_${++errorCounter}_${Date.now()}`,
        message: typeof diagnostic.message === 'string' ? diagnostic.message : String(diagnostic.message),
        type: inferErrorType(diagnostic.message),
        severity: diagnostic.severity ?? vscode.DiagnosticSeverity.Error,
        file: filePath,
        relativeFile: getRelativePath(filePath),
        line: diagnostic.range.start.line + 1,
        column: diagnostic.range.start.character + 1,
        source: diagnostic.source ?? 'unknown',
        code: typeof diagnostic.code === 'object' ? diagnostic.code?.value : diagnostic.code,
        stackTrace: [],
        rawDiagnostic: diagnostic,
        timestamp: Date.now()
    };
}

export function parseStackTrace(rawStack: string): StackFrame[] {
    const frames: StackFrame[] = [];
    // Match common Node.js / V8 stack frame formats
    const patterns = [
        // "    at functionName (file:line:col)"
        /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/,
        // "    at file:line:col"
        /^\s*at\s+(.+?):(\d+):(\d+)$/,
    ];

    for (const line of rawStack.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('at ')) { continue; }

        let frame: StackFrame | null = null;
        for (const pattern of patterns) {
            const match = trimmed.match(pattern);
            if (match) {
                let funcName: string;
                let filePath: string;
                let lineNum: number;
                let colNum: number;

                if (match.length === 5) {
                    // "at funcName (file:line:col)"
                    funcName = match[1] ?? '<anonymous>';
                    filePath = match[2] ?? '';
                    lineNum = parseInt(match[3] ?? '0');
                    colNum = parseInt(match[4] ?? '0');
                } else {
                    funcName = '<anonymous>';
                    filePath = match[1] ?? '';
                    lineNum = parseInt(match[2] ?? '0');
                    colNum = parseInt(match[3] ?? '0');
                }

                frame = {
                    raw: trimmed,
                    file: filePath,
                    line: lineNum,
                    column: colNum,
                    functionName: funcName,
                    isWorkspaceFile: isWorkspaceFile(filePath)
                };
                break;
            }
        }
        if (frame) { frames.push(frame); }
    }
    return frames;
}

export function inferErrorType(message: string): string {
    const msg = message.toLowerCase();
    if (msg.includes('typeerror')) { return 'TypeError'; }
    if (msg.includes('referenceerror')) { return 'ReferenceError'; }
    if (msg.includes('syntaxerror')) { return 'SyntaxError'; }
    if (msg.includes('rangeerror')) { return 'RangeError'; }
    if (msg.includes('cannot read') || msg.includes('undefined')) { return 'TypeError'; }
    if (msg.includes('is not defined')) { return 'ReferenceError'; }
    if (msg.includes('is not a function')) { return 'TypeError'; }
    if (msg.includes('missing') || msg.includes('expected')) { return 'SyntaxError'; }
    if (msg.includes('import') || msg.includes('module')) { return 'ModuleError'; }
    if (msg.includes('async') || msg.includes('promise') || msg.includes('await')) { return 'AsyncError'; }
    if (msg.includes('hook') || msg.includes('react')) { return 'ReactError'; }
    if (msg.includes('type') || msg.includes('assignable')) { return 'TypeError'; }
    return 'Error';
}

export function clusterErrors(errors: ParsedError[]): Map<string, ParsedError[]> {
    const clusters = new Map<string, ParsedError[]>();
    for (const error of errors) {
        const key = generateClusterKey(error);
        const existing = clusters.get(key);
        if (existing) {
            existing.push(error);
        } else {
            clusters.set(key, [error]);
        }
    }
    return clusters;
}

function generateClusterKey(error: ParsedError): string {
    // Normalize message — remove file-specific parts
    const normalized = error.message
        .replace(/:\s*\d+/g, ':N')             // line numbers
        .replace(/'[^']*'/g, "'X'")             // quoted strings
        .replace(/"[^"]*"/g, '"X"')             // double-quoted strings
        .replace(/\b\d+\b/g, 'N')              // bare numbers
        .toLowerCase()
        .trim()
        .slice(0, 80);
    return `${error.type}::${normalized}`;
}
