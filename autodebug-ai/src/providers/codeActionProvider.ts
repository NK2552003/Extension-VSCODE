import * as vscode from 'vscode';
import { ParsedError } from '../parsers/errorParser';
import { aiService } from '../services/aiService';
import { logger } from '../utils/logger';

export class AutoDebugCodeActionProvider implements vscode.CodeActionProvider {
    private errorMap: Map<string, ParsedError[]> = new Map();

    static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix,
        vscode.CodeActionKind.Empty
    ];

    updateErrors(uri: vscode.Uri, errors: ParsedError[]): void {
        this.errorMap.set(uri.toString(), errors);
    }

    async provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range,
        _context: vscode.CodeActionContext,
        _token: vscode.CancellationToken
    ): Promise<vscode.CodeAction[]> {
        const key = document.uri.toString();
        const errors = this.errorMap.get(key);
        if (!errors || errors.length === 0) { return []; }

        const actions: vscode.CodeAction[] = [];

        const affectedErrors = errors.filter(e => {
            const errorLine = e.line - 1;
            return range.start.line <= errorLine && errorLine <= range.end.line;
        });

        for (const error of affectedErrors.slice(0, 3)) {
            try {
                const fixes = await aiService.generateFix(error);
                for (const fix of fixes.slice(0, 2)) {
                    const action = this.createFixAction(document, error, fix);
                    if (action) { actions.push(action); }
                }

                // Always add "Explain Error" action
                const explainAction = new vscode.CodeAction(
                    `AutoDebug: Explain "${error.type}"`,
                    vscode.CodeActionKind.Empty
                );
                explainAction.command = {
                    command: 'autodebug.summarizeError',
                    title: 'Explain Error',
                    arguments: [error]
                };
                actions.push(explainAction);

                // Add "Find Root Cause" action
                const rootAction = new vscode.CodeAction(
                    `AutoDebug: Find Root Cause`,
                    vscode.CodeActionKind.Empty
                );
                rootAction.command = {
                    command: 'autodebug.findRootCause',
                    title: 'Find Root Cause',
                    arguments: [error]
                };
                actions.push(rootAction);
            } catch (err) {
                logger.error('CodeActionProvider: failed', err);
            }
        }

        return actions;
    }

    private createFixAction(
        document: vscode.TextDocument,
        error: ParsedError,
        fixCode: string
    ): vscode.CodeAction | null {
        const lines = fixCode.split('\n').filter(l => !l.startsWith('//'));
        const actualFix = lines.join('\n').trim();
        if (!actualFix) { return null; }

        const action = new vscode.CodeAction(
            `AutoDebug Fix: ${actualFix.slice(0, 40)}${actualFix.length > 40 ? '…' : ''}`,
            vscode.CodeActionKind.QuickFix
        );
        action.isPreferred = true;
        action.command = {
            command: 'autodebug.applyFix',
            title: 'Apply Fix',
            arguments: [document.uri, error.line - 1, error.column - 1, actualFix]
        };
        return action;
    }
}

export const codeActionProvider = new AutoDebugCodeActionProvider();
