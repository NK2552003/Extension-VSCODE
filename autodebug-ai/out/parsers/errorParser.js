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
exports.parseDiagnostic = parseDiagnostic;
exports.parseStackTrace = parseStackTrace;
exports.inferErrorType = inferErrorType;
exports.clusterErrors = clusterErrors;
const vscode = __importStar(require("vscode"));
const fileUtils_1 = require("../utils/fileUtils");
let errorCounter = 0;
function parseDiagnostic(diagnostic, uri) {
    const filePath = uri.fsPath;
    return {
        id: `error_${++errorCounter}_${Date.now()}`,
        message: typeof diagnostic.message === 'string' ? diagnostic.message : String(diagnostic.message),
        type: inferErrorType(diagnostic.message),
        severity: diagnostic.severity ?? vscode.DiagnosticSeverity.Error,
        file: filePath,
        relativeFile: (0, fileUtils_1.getRelativePath)(filePath),
        line: diagnostic.range.start.line + 1,
        column: diagnostic.range.start.character + 1,
        source: diagnostic.source ?? 'unknown',
        code: typeof diagnostic.code === 'object' ? diagnostic.code?.value : diagnostic.code,
        stackTrace: [],
        rawDiagnostic: diagnostic,
        timestamp: Date.now()
    };
}
function parseStackTrace(rawStack) {
    const frames = [];
    // Match common Node.js / V8 stack frame formats
    const patterns = [
        // "    at functionName (file:line:col)"
        /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/,
        // "    at file:line:col"
        /^\s*at\s+(.+?):(\d+):(\d+)$/,
    ];
    for (const line of rawStack.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('at ')) {
            continue;
        }
        let frame = null;
        for (const pattern of patterns) {
            const match = trimmed.match(pattern);
            if (match) {
                let funcName;
                let filePath;
                let lineNum;
                let colNum;
                if (match.length === 5) {
                    // "at funcName (file:line:col)"
                    funcName = match[1] ?? '<anonymous>';
                    filePath = match[2] ?? '';
                    lineNum = parseInt(match[3] ?? '0');
                    colNum = parseInt(match[4] ?? '0');
                }
                else {
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
                    isWorkspaceFile: (0, fileUtils_1.isWorkspaceFile)(filePath)
                };
                break;
            }
        }
        if (frame) {
            frames.push(frame);
        }
    }
    return frames;
}
function inferErrorType(message) {
    const msg = message.toLowerCase();
    if (msg.includes('typeerror')) {
        return 'TypeError';
    }
    if (msg.includes('referenceerror')) {
        return 'ReferenceError';
    }
    if (msg.includes('syntaxerror')) {
        return 'SyntaxError';
    }
    if (msg.includes('rangeerror')) {
        return 'RangeError';
    }
    if (msg.includes('cannot read') || msg.includes('undefined')) {
        return 'TypeError';
    }
    if (msg.includes('is not defined')) {
        return 'ReferenceError';
    }
    if (msg.includes('is not a function')) {
        return 'TypeError';
    }
    if (msg.includes('missing') || msg.includes('expected')) {
        return 'SyntaxError';
    }
    if (msg.includes('import') || msg.includes('module')) {
        return 'ModuleError';
    }
    if (msg.includes('async') || msg.includes('promise') || msg.includes('await')) {
        return 'AsyncError';
    }
    if (msg.includes('hook') || msg.includes('react')) {
        return 'ReactError';
    }
    if (msg.includes('type') || msg.includes('assignable')) {
        return 'TypeError';
    }
    return 'Error';
}
function clusterErrors(errors) {
    const clusters = new Map();
    for (const error of errors) {
        const key = generateClusterKey(error);
        const existing = clusters.get(key);
        if (existing) {
            existing.push(error);
        }
        else {
            clusters.set(key, [error]);
        }
    }
    return clusters;
}
function generateClusterKey(error) {
    // Normalize message — remove file-specific parts
    const normalized = error.message
        .replace(/:\s*\d+/g, ':N') // line numbers
        .replace(/'[^']*'/g, "'X'") // quoted strings
        .replace(/"[^"]*"/g, '"X"') // double-quoted strings
        .replace(/\b\d+\b/g, 'N') // bare numbers
        .toLowerCase()
        .trim()
        .slice(0, 80);
    return `${error.type}::${normalized}`;
}
//# sourceMappingURL=errorParser.js.map