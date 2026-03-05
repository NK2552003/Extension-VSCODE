"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rootCauseAnalyzer = exports.RootCauseAnalyzer = void 0;
const aiService_1 = require("../services/aiService");
const workspaceScanner_1 = require("../services/workspaceScanner");
const logger_1 = require("../utils/logger");
class RootCauseAnalyzer {
    async analyze(error) {
        try {
            const ctx = await workspaceScanner_1.workspaceScanner.getContextForFile(error.file);
            return await aiService_1.aiService.findRootCause(error, ctx);
        }
        catch (err) {
            logger_1.logger.error('RootCauseAnalyzer: failed', err);
            return {
                rootFile: error.relativeFile,
                rootLine: error.line,
                reason: 'Could not trace root cause automatically.',
                callChain: [],
                confidence: 0
            };
        }
    }
    formatAnalysis(analysis) {
        const lines = [];
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
exports.RootCauseAnalyzer = RootCauseAnalyzer;
exports.rootCauseAnalyzer = new RootCauseAnalyzer();
//# sourceMappingURL=rootCauseAnalyzer.js.map