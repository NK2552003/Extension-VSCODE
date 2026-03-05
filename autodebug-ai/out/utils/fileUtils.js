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
exports.getWorkspaceFolders = getWorkspaceFolders;
exports.getWorkspaceRoot = getWorkspaceRoot;
exports.isWorkspaceFile = isWorkspaceFile;
exports.getRelativePath = getRelativePath;
exports.readFileSync = readFileSync;
exports.readFileAsync = readFileAsync;
exports.getLineFromFile = getLineFromFile;
exports.getLinesAround = getLinesAround;
exports.uriToPath = uriToPath;
exports.pathToUri = pathToUri;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
function getWorkspaceFolders() {
    return vscode.workspace.workspaceFolders ?? [];
}
function getWorkspaceRoot() {
    return getWorkspaceFolders()[0]?.uri.fsPath;
}
function isWorkspaceFile(filePath) {
    const root = getWorkspaceRoot();
    if (!root) {
        return false;
    }
    return filePath.startsWith(root) && !filePath.includes('node_modules');
}
function getRelativePath(filePath) {
    const root = getWorkspaceRoot();
    if (!root) {
        return filePath;
    }
    return path.relative(root, filePath);
}
function readFileSync(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf-8');
    }
    catch {
        return null;
    }
}
async function readFileAsync(filePath) {
    try {
        const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
        return Buffer.from(content).toString('utf-8');
    }
    catch {
        return null;
    }
}
function getLineFromFile(filePath, lineNumber) {
    const content = readFileSync(filePath);
    if (!content) {
        return null;
    }
    const lines = content.split('\n');
    return lines[lineNumber] ?? null;
}
function getLinesAround(filePath, lineNumber, context = 3) {
    const content = readFileSync(filePath);
    if (!content) {
        return [];
    }
    const lines = content.split('\n');
    const start = Math.max(0, lineNumber - context);
    const end = Math.min(lines.length - 1, lineNumber + context);
    return lines.slice(start, end + 1).map((line, i) => `${start + i + 1}: ${line}`);
}
function uriToPath(uri) {
    return uri.fsPath;
}
function pathToUri(filePath) {
    return vscode.Uri.file(filePath);
}
//# sourceMappingURL=fileUtils.js.map