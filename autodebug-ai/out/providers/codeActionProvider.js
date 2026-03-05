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
exports.codeActionProvider = exports.AutoDebugCodeActionProvider = void 0;
const vscode = __importStar(require("vscode"));
const aiService_1 = require("../services/aiService");
const logger_1 = require("../utils/logger");
class AutoDebugCodeActionProvider {
    constructor() {
        this.errorMap = new Map();
    }
    updateErrors(uri, errors) {
        this.errorMap.set(uri.toString(), errors);
    }
    async provideCodeActions(document, range, _context, _token) {
        const key = document.uri.toString();
        const errors = this.errorMap.get(key);
        if (!errors || errors.length === 0) {
            return [];
        }
        const actions = [];
        const affectedErrors = errors.filter(e => {
            const errorLine = e.line - 1;
            return range.start.line <= errorLine && errorLine <= range.end.line;
        });
        for (const error of affectedErrors.slice(0, 3)) {
            try {
                const fixes = await aiService_1.aiService.generateFix(error);
                for (const fix of fixes.slice(0, 2)) {
                    const action = this.createFixAction(document, error, fix);
                    if (action) {
                        actions.push(action);
                    }
                }
                // Always add "Explain Error" action
                const explainAction = new vscode.CodeAction(`AutoDebug: Explain "${error.type}"`, vscode.CodeActionKind.Empty);
                explainAction.command = {
                    command: 'autodebug.summarizeError',
                    title: 'Explain Error',
                    arguments: [error]
                };
                actions.push(explainAction);
                // Add "Find Root Cause" action
                const rootAction = new vscode.CodeAction(`AutoDebug: Find Root Cause`, vscode.CodeActionKind.Empty);
                rootAction.command = {
                    command: 'autodebug.findRootCause',
                    title: 'Find Root Cause',
                    arguments: [error]
                };
                actions.push(rootAction);
            }
            catch (err) {
                logger_1.logger.error('CodeActionProvider: failed', err);
            }
        }
        return actions;
    }
    createFixAction(document, error, fixCode) {
        const lines = fixCode.split('\n').filter(l => !l.startsWith('//'));
        const actualFix = lines.join('\n').trim();
        if (!actualFix) {
            return null;
        }
        const action = new vscode.CodeAction(`AutoDebug Fix: ${actualFix.slice(0, 40)}${actualFix.length > 40 ? '…' : ''}`, vscode.CodeActionKind.QuickFix);
        action.isPreferred = true;
        action.command = {
            command: 'autodebug.applyFix',
            title: 'Apply Fix',
            arguments: [document.uri, error.line - 1, error.column - 1, actualFix]
        };
        return action;
    }
}
exports.AutoDebugCodeActionProvider = AutoDebugCodeActionProvider;
AutoDebugCodeActionProvider.providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
    vscode.CodeActionKind.Empty
];
exports.codeActionProvider = new AutoDebugCodeActionProvider();
//# sourceMappingURL=codeActionProvider.js.map