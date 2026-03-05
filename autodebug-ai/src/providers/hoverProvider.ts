import * as vscode from 'vscode';
import { ParsedError } from '../parsers/errorParser';
import { errorSummarizer } from '../modules/errorSummarizer';
import { logger } from '../utils/logger';

export class AutoDebugHoverProvider implements vscode.HoverProvider {
    private errorMap: Map<string, ParsedError[]> = new Map();

    updateErrors(uri: vscode.Uri, errors: ParsedError[]): void {
        this.errorMap.set(uri.toString(), errors);
    }

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.Hover | null> {
        const key = document.uri.toString();
        const errors = this.errorMap.get(key);
        if (!errors || errors.length === 0) { return null; }

        // Find an error at the hovered line
        const error = errors.find(e => e.line - 1 === position.line);
        if (!error) { return null; }

        try {
            const result = await errorSummarizer.summarize(error);
            const md = errorSummarizer.formatForHover(result);
            const range = new vscode.Range(
                position.line, 0,
                position.line, document.lineAt(position.line).text.length
            );
            return new vscode.Hover(md, range);
        } catch (err) {
            logger.error('HoverProvider: failed', err);
            return null;
        }
    }
}

export const hoverProvider = new AutoDebugHoverProvider();
