import { StackFrame, parseStackTrace } from '../parsers/errorParser';
import { isWorkspaceFile, getRelativePath } from '../utils/fileUtils';

export interface CleanedStackTrace {
    workspaceFrames: StackFrame[];
    filteredFrames: StackFrame[];
    allFrames: StackFrame[];
    summary: string;
}

const LIBRARY_PATTERNS = [
    /node_modules/,
    /internal\/modules/,
    /electron\/dist/,
    /webpack\/runtime/,
    /\(native\)/,
    /wasm-functions/,
];

export class StackTraceCleaner {
    clean(rawStackTrace: string): CleanedStackTrace {
        const allFrames = parseStackTrace(rawStackTrace);
        return this.cleanFrames(allFrames);
    }

    cleanFrames(frames: StackFrame[]): CleanedStackTrace {
        const workspaceFrames = frames.filter(f => f.isWorkspaceFile && !this.isLibraryFrame(f));
        const filteredFrames = frames.filter(f => this.isLibraryFrame(f) || !f.isWorkspaceFile);

        const summary = this.generateSummary(workspaceFrames, filteredFrames);

        return {
            workspaceFrames,
            filteredFrames,
            allFrames: frames,
            summary
        };
    }

    private isLibraryFrame(frame: StackFrame): boolean {
        return LIBRARY_PATTERNS.some(p => p.test(frame.file));
    }

    formatClean(cleaned: CleanedStackTrace): string {
        if (cleaned.workspaceFrames.length === 0) {
            return '(No workspace frames found in stack trace)';
        }
        const lines = cleaned.workspaceFrames.map(f =>
            `  at ${f.functionName !== '<anonymous>' ? f.functionName + ' ' : ''}(${getRelativePath(f.file)}:${f.line}:${f.column})`
        );
        return lines.join('\n');
    }

    formatFull(cleaned: CleanedStackTrace, collapsed = true): string {
        const workspacePart = cleaned.workspaceFrames.map(f =>
            `  at ${f.functionName !== '<anonymous>' ? f.functionName + ' ' : ''}(${getRelativePath(f.file)}:${f.line}:${f.column}) ← workspace`
        );
        const libraryPart = collapsed
            ? [`  ... ${cleaned.filteredFrames.length} library frames (collapsed)`]
            : cleaned.filteredFrames.map(f => `  at ${f.raw} (library)`);

        return [...workspacePart, ...libraryPart].join('\n');
    }

    private generateSummary(workspace: StackFrame[], filtered: StackFrame[]): string {
        const total = workspace.length + filtered.length;
        return `${workspace.length} workspace frame${workspace.length !== 1 ? 's' : ''} | ${filtered.length} library frame${filtered.length !== 1 ? 's' : ''} filtered (${total} total)`;
    }

    getEntryPoint(cleaned: CleanedStackTrace): StackFrame | null {
        return cleaned.workspaceFrames[0] ?? null;
    }

    getDeepestFrame(cleaned: CleanedStackTrace): StackFrame | null {
        return cleaned.workspaceFrames[cleaned.workspaceFrames.length - 1] ?? null;
    }
}

export const stackTraceCleaner = new StackTraceCleaner();
