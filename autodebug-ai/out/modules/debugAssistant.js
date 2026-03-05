"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.debugAssistant = exports.DebugAssistant = void 0;
const aiService_1 = require("../services/aiService");
const logger_1 = require("../utils/logger");
class DebugAssistant {
    constructor() {
        this.history = [];
        this.activeError = null;
    }
    setActiveError(error) {
        this.activeError = error;
        if (error) {
            this.history.push({
                role: 'system',
                content: `Context: Analyzing error in ${error.relativeFile}:${error.line} — ${error.message}`,
                timestamp: Date.now()
            });
        }
    }
    async ask(question) {
        const userMsg = {
            role: 'user',
            content: question,
            timestamp: Date.now()
        };
        this.history.push(userMsg);
        try {
            const context = this.buildContext();
            const response = await aiService_1.aiService.answerDebugQuestion(question, this.activeError, context);
            const assistantMsg = {
                role: 'assistant',
                content: response.answer,
                timestamp: Date.now(),
                codeSnippets: response.codeSnippets,
                relatedLinks: response.relatedErrors
            };
            this.history.push(assistantMsg);
            return assistantMsg;
        }
        catch (err) {
            logger_1.logger.error('DebugAssistant: failed to answer', err);
            const errorMsg = {
                role: 'assistant',
                content: 'Sorry, I encountered an error while processing your question. Please try again.',
                timestamp: Date.now()
            };
            this.history.push(errorMsg);
            return errorMsg;
        }
    }
    getHistory() {
        return this.history.filter(m => m.role !== 'system');
    }
    clearHistory() {
        this.history = [];
        this.activeError = null;
    }
    buildContext() {
        const recent = this.history.slice(-6).map(m => `${m.role}: ${m.content}`).join('\n');
        return recent;
    }
    getSuggestedQuestions(error) {
        if (!error) {
            return [
                'What is the most common cause of TypeErrors?',
                'How do I handle async errors properly?',
                'What are React Hook rules?'
            ];
        }
        return [
            `Why is this ${error.type} happening?`,
            `How do I fix the error in ${error.relativeFile}?`,
            `What is the root cause of this error?`,
            `Show me a code fix for this error.`,
            `What documentation should I read for this error?`
        ];
    }
}
exports.DebugAssistant = DebugAssistant;
exports.debugAssistant = new DebugAssistant();
//# sourceMappingURL=debugAssistant.js.map