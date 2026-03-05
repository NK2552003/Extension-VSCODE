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
exports.errorSummarizer = exports.ErrorSummarizer = void 0;
const vscode = __importStar(require("vscode"));
const errorParser_1 = require("../parsers/errorParser");
const aiService_1 = require("../services/aiService");
const logger_1 = require("../utils/logger");
class ErrorSummarizer {
    constructor() {
        this.summaryCache = new Map();
    }
    async summarize(error) {
        const cached = this.summaryCache.get(error.id);
        if (cached) {
            return cached;
        }
        try {
            const summary = await aiService_1.aiService.summarizeError(error);
            const result = { error, summary };
            this.summaryCache.set(error.id, result);
            return result;
        }
        catch (err) {
            logger_1.logger.error('ErrorSummarizer: failed to summarize', err);
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
    async summarizeAll(errors) {
        return Promise.all(errors.map(e => this.summarize(e)));
    }
    getClusteredErrors(errors) {
        return (0, errorParser_1.clusterErrors)(errors);
    }
    formatForHover(result) {
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
    clearCache() {
        this.summaryCache.clear();
    }
}
exports.ErrorSummarizer = ErrorSummarizer;
exports.errorSummarizer = new ErrorSummarizer();
//# sourceMappingURL=errorSummarizer.js.map