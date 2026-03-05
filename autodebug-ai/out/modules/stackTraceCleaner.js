"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stackTraceCleaner = exports.StackTraceCleaner = void 0;
const errorParser_1 = require("../parsers/errorParser");
const fileUtils_1 = require("../utils/fileUtils");
const LIBRARY_PATTERNS = [
    /node_modules/,
    /internal\/modules/,
    /electron\/dist/,
    /webpack\/runtime/,
    /\(native\)/,
    /wasm-functions/,
];
class StackTraceCleaner {
    clean(rawStackTrace) {
        const allFrames = (0, errorParser_1.parseStackTrace)(rawStackTrace);
        return this.cleanFrames(allFrames);
    }
    cleanFrames(frames) {
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
    isLibraryFrame(frame) {
        return LIBRARY_PATTERNS.some(p => p.test(frame.file));
    }
    formatClean(cleaned) {
        if (cleaned.workspaceFrames.length === 0) {
            return '(No workspace frames found in stack trace)';
        }
        const lines = cleaned.workspaceFrames.map(f => `  at ${f.functionName !== '<anonymous>' ? f.functionName + ' ' : ''}(${(0, fileUtils_1.getRelativePath)(f.file)}:${f.line}:${f.column})`);
        return lines.join('\n');
    }
    formatFull(cleaned, collapsed = true) {
        const workspacePart = cleaned.workspaceFrames.map(f => `  at ${f.functionName !== '<anonymous>' ? f.functionName + ' ' : ''}(${(0, fileUtils_1.getRelativePath)(f.file)}:${f.line}:${f.column}) ← workspace`);
        const libraryPart = collapsed
            ? [`  ... ${cleaned.filteredFrames.length} library frames (collapsed)`]
            : cleaned.filteredFrames.map(f => `  at ${f.raw} (library)`);
        return [...workspacePart, ...libraryPart].join('\n');
    }
    generateSummary(workspace, filtered) {
        const total = workspace.length + filtered.length;
        return `${workspace.length} workspace frame${workspace.length !== 1 ? 's' : ''} | ${filtered.length} library frame${filtered.length !== 1 ? 's' : ''} filtered (${total} total)`;
    }
    getEntryPoint(cleaned) {
        return cleaned.workspaceFrames[0] ?? null;
    }
    getDeepestFrame(cleaned) {
        return cleaned.workspaceFrames[cleaned.workspaceFrames.length - 1] ?? null;
    }
}
exports.StackTraceCleaner = StackTraceCleaner;
exports.stackTraceCleaner = new StackTraceCleaner();
//# sourceMappingURL=stackTraceCleaner.js.map