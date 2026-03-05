import * as vscode from 'vscode';
import { ParsedError, parseDiagnostic, clusterErrors } from '../parsers/errorParser';
import { aiService, ErrorSummary } from '../services/aiService';
import { logger } from '../utils/logger';

export interface ErrorAnalysisResult {
    error: ParsedError;
    summary: ErrorSummary;
}

export class ErrorSummarizer {
    private summaryCache: Map<string, ErrorAnalysisResult> = new Map();

    async summarize(error: ParsedError): Promise<ErrorAnalysisResult> {
        const cached = this.summaryCache.get(error.id);
        if (cached) { return cached; }

        try {
            const summary = await aiService.summarizeError(error);
            const result: ErrorAnalysisResult = { error, summary };
            this.summaryCache.set(error.id, result);
            return result;
        } catch (err) {
            logger.error('ErrorSummarizer: failed to summarize', err);
            return {
                error,
                summary: {
                    errorType: error.type,
                    explanation: error.message,
                    possibleCause: 'Unable to analyze at this time.',
                    location: `${error.relativeFile}:${error.line}`,
                    suggestedFix: 'Review the code at the error location.',
                    codeExample: '',
                    documentationLinks: [],
                    confidence: 0
                }
            };
        }
    }

    async summarizeAll(errors: ParsedError[]): Promise<ErrorAnalysisResult[]> {
        return Promise.all(errors.map(e => this.summarize(e)));
    }

    getClusteredErrors(errors: ParsedError[]): Map<string, ParsedError[]> {
        return clusterErrors(errors);
    }

    formatForHover(result: ErrorAnalysisResult): vscode.MarkdownString {
        const md = new vscode.MarkdownString(undefined, true);
        md.isTrusted = true;
        md.supportHtml = false;

        md.appendMarkdown(`## AutoDebug AI — ${result.summary.errorType}\n\n`);
        md.appendMarkdown(`**Explanation:** ${result.summary.explanation}\n\n`);
        md.appendMarkdown(`**Possible Cause:** ${result.summary.possibleCause}\n\n`);
        md.appendMarkdown(`**Suggested Fix:** ${result.summary.suggestedFix}\n\n`);

        if (result.summary.codeExample) {
            md.appendMarkdown(`**Example:**\n`);
            md.appendCodeblock(result.summary.codeExample, 'typescript');
        }

        if (result.summary.documentationLinks.length > 0) {
            md.appendMarkdown('\n**Documentation:**\n');
            for (const link of result.summary.documentationLinks) {
                md.appendMarkdown(`- [${link}](${link})\n`);
            }
        }

        return md;
    }

    clearCache(): void {
        this.summaryCache.clear();
    }
}

export const errorSummarizer = new ErrorSummarizer();
