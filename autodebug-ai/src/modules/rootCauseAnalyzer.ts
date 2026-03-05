import { ParsedError } from '../parsers/errorParser';
import { aiService, RootCauseAnalysis } from '../services/aiService';
import { workspaceScanner } from '../services/workspaceScanner';
import { logger } from '../utils/logger';

export class RootCauseAnalyzer {
    async analyze(error: ParsedError): Promise<RootCauseAnalysis> {
        try {
            const ctx = await workspaceScanner.getContextForFile(error.file);
            return await aiService.findRootCause(error, ctx);
        } catch (err) {
            logger.error('RootCauseAnalyzer: failed', err);
            return {
                rootFile: error.relativeFile,
                rootLine: error.line,
                reason: 'Could not trace root cause automatically.',
                callChain: [],
                confidence: 0
            };
        }
    }

    formatAnalysis(analysis: RootCauseAnalysis): string {
        const lines: string[] = [];
        lines.push(`Root Cause Location: ${analysis.rootFile}:${analysis.rootLine}`);
        lines.push(`Reason: ${analysis.reason}`);
        if (analysis.callChain.length > 0) {
            lines.push('\nCall Chain:');
            lines.push(...analysis.callChain.map((c, i) => `  ${i + 1}. ${c}`));
        }
        lines.push(`\nConfidence: ${Math.round(analysis.confidence * 100)}%`);
        return lines.join('\n');
    }
}

export const rootCauseAnalyzer = new RootCauseAnalyzer();
