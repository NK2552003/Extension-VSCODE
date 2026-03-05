import { ParsedError } from '../parsers/errorParser';
import { aiService, ChatResponse } from '../services/aiService';
import { logger } from '../utils/logger';

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
    codeSnippets?: string[];
    relatedLinks?: string[];
}

export class DebugAssistant {
    private history: ChatMessage[] = [];
    private activeError: ParsedError | null = null;

    setActiveError(error: ParsedError | null): void {
        this.activeError = error;
        if (error) {
            this.history.push({
                role: 'system',
                content: `Context: Analyzing error in ${error.relativeFile}:${error.line} — ${error.message}`,
                timestamp: Date.now()
            });
        }
    }

    async ask(question: string): Promise<ChatMessage> {
        const userMsg: ChatMessage = {
            role: 'user',
            content: question,
            timestamp: Date.now()
        };
        this.history.push(userMsg);

        try {
            const context = this.buildContext();
            const response: ChatResponse = await aiService.answerDebugQuestion(
                question,
                this.activeError,
                context
            );

            const assistantMsg: ChatMessage = {
                role: 'assistant',
                content: response.answer,
                timestamp: Date.now(),
                codeSnippets: response.codeSnippets,
                relatedLinks: response.relatedErrors
            };
            this.history.push(assistantMsg);
            return assistantMsg;
        } catch (err) {
            logger.error('DebugAssistant: failed to answer', err);
            const errorMsg: ChatMessage = {
                role: 'assistant',
                content: 'Sorry, I encountered an error while processing your question. Please try again.',
                timestamp: Date.now()
            };
            this.history.push(errorMsg);
            return errorMsg;
        }
    }

    getHistory(): ChatMessage[] {
        return this.history.filter(m => m.role !== 'system');
    }

    clearHistory(): void {
        this.history = [];
        this.activeError = null;
    }

    private buildContext(): string {
        const recent = this.history.slice(-6).map(m => `${m.role}: ${m.content}`).join('\n');
        return recent;
    }

    getSuggestedQuestions(error: ParsedError | null): string[] {
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

export const debugAssistant = new DebugAssistant();
