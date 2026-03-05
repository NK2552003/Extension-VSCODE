import { ParsedError } from '../parsers/errorParser';
import { llmService, LLMMessage } from './llmService';
import { logger } from '../utils/logger';

export interface ErrorSummary {
    errorType: string;
    explanation: string;
    possibleCause: string;
    location: string;
    suggestedFix: string;
    codeExample: string;
    documentationLinks: string[];
    confidence: number;
    aiSource?: string;
}

export interface RootCauseAnalysis {
    rootFile: string;
    rootLine: number;
    reason: string;
    callChain: string[];
    confidence: number;
    aiSource?: string;
}

export interface ChatResponse {
    answer: string;
    codeSnippets: string[];
    relatedErrors: string[];
    aiSource?: string;
}

const PATTERN_KB: Array<{
    pattern: RegExp;
    type: string;
    explanation: string;
    cause: string;
    fix: string;
    example: string;
    docs: string[];
}> = [
    {
        pattern: /cannot read propert(?:y|ies) of undefined/i,
        type: 'TypeError',
        explanation: 'You are trying to access a property on a variable that is `undefined`.',
        cause: 'The variable was never initialized, async operation incomplete, or API returned no data.',
        fix: 'Use optional chaining (`?.`) or add a null/undefined guard before accessing.',
        example: 'const value = obj?.property ?? defaultValue;\n\n// Guard clause:\nif (!obj) return null;',
        docs: ['https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Errors/Cant_access_property']
    },
    {
        pattern: /cannot read propert(?:y|ies) of null/i,
        type: 'TypeError',
        explanation: 'You are trying to access a property on `null`.',
        cause: 'DOM query returned null, API field missing, or variable explicitly null.',
        fix: 'Use optional chaining `obj?.property` or check `if (obj !== null)` before access.',
        example: 'const value = obj?.property ?? defaultValue;',
        docs: ['https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Errors/Cant_access_property']
    },
    {
        pattern: /is not a function/i,
        type: 'TypeError',
        explanation: 'You are calling something that is not a function.',
        cause: 'The value is undefined, null, or overwritten. A named import may be missing.',
        fix: 'Verify with: `if (typeof fn === "function") fn();`',
        example: 'if (typeof callback === "function") {\n  callback();\n}',
        docs: ['https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Errors/Not_a_function']
    },
    {
        pattern: /is not defined/i,
        type: 'ReferenceError',
        explanation: 'The variable or function has not been declared in the current scope.',
        cause: 'Missing import, typo in the name, or usage before declaration.',
        fix: 'Add the missing import or declare the variable before use.',
        example: 'import { myFunction } from "./module";\n\nconst myVar = initialValue;',
        docs: ['https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Errors/Not_defined']
    },
    {
        pattern: /unexpected token/i,
        type: 'SyntaxError',
        explanation: 'The parser encountered a token it did not expect.',
        cause: 'Mismatched braces, missing comma, or invalid syntax.',
        fix: 'Check the line and surrounding lines for unmatched brackets or missing semicolons.',
        example: '// Check for:\n// missing closing }\n// extra comma in object\n// missing parentheses',
        docs: ['https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Errors/Unexpected_token']
    },
    {
        pattern: /\.map is not a function|Cannot.*\.map\(\)/i,
        type: 'TypeError',
        explanation: 'You called `.map()` on a value that is not an array.',
        cause: 'Data has not loaded yet, or API returned a non-array value.',
        fix: 'Initialize with an empty array or validate before mapping.',
        example: 'const items = data?.items ?? [];\nconst result = items.map(x => x);\n\nif (Array.isArray(items)) items.map(...);',
        docs: ['https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map']
    },
    {
        pattern: /invalid hook call|hooks can only be called/i,
        type: 'ReactError',
        explanation: 'A React Hook is called outside of a React function component.',
        cause: 'Hooks must be called at the top level, not inside conditionals, loops, or class components.',
        fix: 'Move the Hook call to the top level of your function component.',
        example: '// WRONG:\nif (condition) { const [s,set] = useState(0); }\n// CORRECT:\nconst [s,set] = useState(0);\nif (condition) { /* use s */ }',
        docs: ['https://react.dev/warnings/invalid-hook-call-warning']
    },
    {
        pattern: /unhandled promise rejection/i,
        type: 'AsyncError',
        explanation: 'A Promise was rejected without being caught.',
        cause: 'An async operation failed with no .catch() or try/catch block.',
        fix: 'Wrap await calls in try/catch or add .catch() to Promise chains.',
        example: 'try {\n  const result = await fetchData();\n} catch (error) {\n  console.error("Failed:", error);\n}',
        docs: ['https://developer.mozilla.org/en-US/docs/Web/API/Window/unhandledrejection_event']
    },
    {
        pattern: /cannot find module|module not found/i,
        type: 'ModuleError',
        explanation: 'The imported module or file cannot be resolved.',
        cause: 'Package not installed, incorrect path, or typo in import.',
        fix: 'Run `npm install <package>` or correct the import path.',
        example: 'import { fn } from "./correctPath";\n\n// Install if missing:\n// npm install package-name',
        docs: ['https://nodejs.org/api/modules.html']
    },
    {
        pattern: /type.*is not assignable to type/i,
        type: 'TypeError (TypeScript)',
        explanation: 'TypeScript detected a type mismatch at compile time.',
        cause: 'A value of the wrong type is assigned or passed as an argument.',
        fix: 'Align the types, add a type assertion, or fix the data shape.',
        example: 'const val = someValue as ExpectedType;\n\n// Union type:\nconst val: string | undefined = maybeString;',
        docs: ['https://www.typescriptlang.org/docs/handbook/2/types-from-types.html']
    },
    {
        pattern: /property.*does not exist on type/i,
        type: 'TypeError (TypeScript)',
        explanation: 'You are accessing a property not declared on the TypeScript type.',
        cause: 'Type definition is incomplete, API shape changed, or typo in property name.',
        fix: 'Extend the type interface or use a type assertion.',
        example: 'interface MyType {\n  existingProp: string;\n  newProp?: number;\n}',
        docs: ['https://www.typescriptlang.org/docs/handbook/2/objects.html']
    },
    {
        pattern: /maximum update depth exceeded/i,
        type: 'ReactError',
        explanation: 'React detected an infinite render loop.',
        cause: 'A state update inside useEffect without proper dependencies.',
        fix: 'Add correct dependency array to useEffect to prevent re-triggering.',
        example: 'useEffect(() => {\n  if (value !== prevValue) setState(value);\n}, [value]);',
        docs: ['https://react.dev/errors/300']
    }
];

const BUG_PATTERNS = [
    { pattern: /\.map\(|\.filter\(|\.reduce\(/i, name: 'Array Method on Non-Array', description: 'Verify the value is an array before calling array methods.', fix: 'Guard with Array.isArray() or initialize with []' },
    { pattern: /useEffect|useCallback|useMemo/i, name: 'React Hook Dependency', description: 'Hooks may have missing or stale dependencies.', fix: 'Add all reactive values to dependency array' },
    { pattern: /\beval\s*\(/i, name: 'eval() Usage', description: 'eval() is a security risk and performance concern.', fix: 'Replace with JSON.parse or Function constructor' },
    { pattern: /console\.log(?!\s*\/\/)/i, name: 'Debug Statement', description: 'console.log() left in production code.', fix: 'Remove or replace with a proper logger' },
    { pattern: /TODO|FIXME|HACK|XXX/i, name: 'Technical Debt Marker', description: 'Unresolved technical debt comment.', fix: 'Create a ticket and track in your issue tracker' },
    { pattern: /\bvar\s+/i, name: 'var Declaration', description: 'var has function scope and hoisting which leads to bugs.', fix: 'Replace with const or let' }
];

export class AIService {
    private summaryCache: Map<string, ErrorSummary> = new Map();
    private rootCauseCache: Map<string, RootCauseAnalysis> = new Map();

    async summarizeError(error: ParsedError, surroundingCode = ''): Promise<ErrorSummary> {
        const key = `${error.message}::${error.file}::${error.line}`;
        if (this.summaryCache.has(key)) { return this.summaryCache.get(key)!; }

        const llmResult = await this.summaryViaLLM(error, surroundingCode);
        if (llmResult) {
            this.summaryCache.set(key, llmResult);
            return llmResult;
        }

        const patternResult = this.summaryViaPatterns(error);
        this.summaryCache.set(key, patternResult);
        return patternResult;
    }

    private async summaryViaLLM(error: ParsedError, code: string): Promise<ErrorSummary | null> {
        try {
            if (!llmService.getStatus().probed) { await llmService.initialize(); }
            const st = llmService.getStatus();
            if (!st.copilot && !st.githubModels) { return null; }

            const response = await llmService.send([
                { role: 'system', content: buildSystemPrompt() },
                { role: 'user',   content: buildSummaryPrompt(error, code) }
            ]);
            if (!response.text) { return null; }
            return parseLLMSummaryResponse(response.text, error, response.model);
        } catch (err) {
            logger.warn('AIService: LLM summary failed', err);
            return null;
        }
    }

    private summaryViaPatterns(error: ParsedError): ErrorSummary {
        for (const p of PATTERN_KB) {
            if (p.pattern.test(error.message)) {
                return {
                    errorType: p.type,
                    explanation: p.explanation,
                    possibleCause: p.cause,
                    location: `${error.relativeFile}:${error.line}`,
                    suggestedFix: p.fix,
                    codeExample: p.example,
                    documentationLinks: p.docs,
                    confidence: 0.88,
                    aiSource: 'pattern-kb'
                };
            }
        }
        return {
            errorType: error.type,
            explanation: `A ${error.type} occurred: ${error.message}`,
            possibleCause: 'Review the variable types and values at the reported location.',
            location: `${error.relativeFile}:${error.line}`,
            suggestedFix: 'Inspect the value with a debugger or console.log before the error line.',
            codeExample: '// Add before the error line:\nconsole.log("debug value:", yourVariable);',
            documentationLinks: ['https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Errors'],
            confidence: 0.4,
            aiSource: 'generic'
        };
    }

    async findRootCause(error: ParsedError, workspaceContext: Map<string, string>): Promise<RootCauseAnalysis> {
        if (this.rootCauseCache.has(error.id)) { return this.rootCauseCache.get(error.id)!; }

        let contextSnippet = '';
        let count = 0;
        for (const [file, content] of workspaceContext) {
            if (count++ >= 3) { break; }
            contextSnippet += `\n\n--- ${file.replace(/.*\//, '')} ---\n${content.split('\n').slice(0, 60).join('\n')}`;
        }

        const llmResult = await this.rootCauseViaLLM(error, contextSnippet);
        const result = llmResult ?? this.rootCauseViaHeuristics(error, workspaceContext);
        this.rootCauseCache.set(error.id, result);
        return result;
    }

    private async rootCauseViaLLM(error: ParsedError, context: string): Promise<RootCauseAnalysis | null> {
        try {
            const st = llmService.getStatus();
            if (!st.copilot && !st.githubModels) { return null; }
            const response = await llmService.send([
                { role: 'system', content: buildSystemPrompt() },
                { role: 'user',   content: buildRootCausePrompt(error, context) }
            ]);
            if (!response.text) { return null; }
            return parseLLMRootCauseResponse(response.text, error, response.model);
        } catch (err) {
            logger.warn('AIService: LLM root cause failed', err);
            return null;
        }
    }

    private rootCauseViaHeuristics(error: ParsedError, ctx: Map<string, string>): RootCauseAnalysis {
        const wsFrames = error.stackTrace.filter(f => f.isWorkspaceFile);
        let rootFile = error.relativeFile;
        let rootLine = error.line;
        let reason = 'The error originates at the reported location.';
        const callChain: string[] = [];

        if (wsFrames.length > 1) {
            const deepest = wsFrames[wsFrames.length - 1];
            rootFile = deepest.file;
            rootLine = deepest.line;
            callChain.push(...wsFrames.map(f => `${f.functionName} (${f.file}:${f.line})`));
            reason = `Error bubbled through ${wsFrames.length} frames. Originating at ${deepest.file}:${deepest.line}.`;
        }

        const varName = extractVarName(error.message);
        if (varName) {
            for (const [file, content] of ctx) {
                if (file === error.file) { continue; }
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (new RegExp(`(const|let|var|return)\\s+${varName}[\\s=]`).test(lines[i])) {
                        rootFile = file.replace(/.*\//, '');
                        rootLine = i + 1;
                        reason = `"${varName}" is defined/returned here. Verify it returns a defined value.`;
                        break;
                    }
                }
            }
        }

        return { rootFile, rootLine, reason, callChain, confidence: wsFrames.length > 1 ? 0.82 : 0.55, aiSource: 'heuristic' };
    }

    async generateFix(error: ParsedError, code = ''): Promise<string[]> {
        try {
            const st = llmService.getStatus();
            if (st.copilot || st.githubModels) {
                const response = await llmService.send([{ role: 'user', content: buildFixPrompt(error, code) }]);
                if (response.text) {
                    const fixes = extractCodeBlocks(response.text);
                    if (fixes.length > 0) { return fixes.slice(0, 3); }
                }
            }
        } catch (err) {
            logger.warn('AIService: LLM fix failed', err);
        }

        const summary = await this.summarizeError(error, code);
        const fixes: string[] = [];
        if (summary.codeExample) { fixes.push(summary.codeExample); }
        const msg = error.message.toLowerCase();
        if (msg.includes('cannot read') && msg.includes('undefined')) {
            const prop = error.message.match(/reading '([^']+)'/)?.[1];
            if (prop) {
                fixes.push(`obj?.${prop}`);
                fixes.push(`if (!obj) return null;\nobj.${prop}`);
            }
        }
        return [...new Set(fixes)];
    }

    async answerDebugQuestion(question: string, error: ParsedError | null, contextHistory: string): Promise<ChatResponse> {
        try {
            const st = llmService.getStatus();
            if (st.copilot || st.githubModels) {
                const ctx = error
                    ? `\n\nActive error: ${error.type} — ${error.message} @ ${error.relativeFile}:${error.line}`
                    : '';
                const msgs: LLMMessage[] = [
                    { role: 'user', content: `${buildSystemPrompt()}${ctx}\n\nHistory:\n${contextHistory}\n\nQuestion: ${question}` }
                ];
                const response = await llmService.send(msgs);
                if (response.text) {
                    return {
                        answer: stripCodeBlocks(response.text),
                        codeSnippets: extractCodeBlocks(response.text),
                        relatedErrors: [],
                        aiSource: `${response.source} (${response.model})`
                    };
                }
            }
        } catch (err) {
            logger.warn('AIService: LLM chat failed', err);
        }

        if (error) {
            const summary = await this.summarizeError(error);
            return {
                answer: `**${summary.errorType}** at \`${summary.location}\`\n\n${summary.explanation}\n\n**Cause:** ${summary.possibleCause}\n\n**Fix:** ${summary.suggestedFix}`,
                codeSnippets: summary.codeExample ? [summary.codeExample] : [],
                relatedErrors: summary.documentationLinks,
                aiSource: 'pattern-kb'
            };
        }
        return { answer: 'Select an error in the sidebar for AI analysis.', codeSnippets: [], relatedErrors: [], aiSource: 'none' };
    }

    detectBugPatterns(code: string): Array<{ name: string; description: string; fix: string }> {
        return BUG_PATTERNS.filter(p => p.pattern.test(code)).map(p => ({
            name: p.name, description: p.description, fix: p.fix
        }));
    }

    clearCache(): void {
        this.summaryCache.clear();
        this.rootCauseCache.clear();
    }
}

function buildSystemPrompt(): string {
    return `You are AutoDebug AI — an expert debugging assistant inside VS Code.
Analyze errors with precision. Provide actionable, correct fixes.
Respond with JSON when asked. Be concise and technical.`;
}

function buildSummaryPrompt(error: ParsedError, code: string): string {
    return `Return ONLY valid JSON (no markdown fences):
{"errorType":"","explanation":"","possibleCause":"","suggestedFix":"","codeExample":"","documentationLinks":[],"confidence":0.95}

Error: ${error.type}: ${error.message}
File: ${error.relativeFile}:${error.line}
${code ? `Code:\n${code.slice(0, 400)}` : ''}`;
}

function buildRootCausePrompt(error: ParsedError, context: string): string {
    return `Return ONLY valid JSON (no markdown fences):
{"rootFile":"","rootLine":0,"reason":"","callChain":[],"confidence":0.90}

Error: ${error.type}: ${error.message} @ ${error.relativeFile}:${error.line}
Context:${context.slice(0, 800)}`;
}

function buildFixPrompt(error: ParsedError, code: string): string {
    return `Generate 1-3 code fixes. Return ONLY \`\`\` code blocks.
Error: ${error.message}  File: ${error.relativeFile}:${error.line}
${code ? `Code:\n\`\`\`\n${code.slice(0, 500)}\n\`\`\`` : ''}`;
}

function parseLLMSummaryResponse(text: string, error: ParsedError, model: string): ErrorSummary | null {
    try {
        const clean = text.replace(/^```json\s*/im, '').replace(/```\s*$/m, '').trim();
        const p = JSON.parse(clean);
        return {
            errorType: String(p.errorType ?? error.type),
            explanation: String(p.explanation ?? ''),
            possibleCause: String(p.possibleCause ?? ''),
            location: `${error.relativeFile}:${error.line}`,
            suggestedFix: String(p.suggestedFix ?? ''),
            codeExample: String(p.codeExample ?? ''),
            documentationLinks: Array.isArray(p.documentationLinks) ? p.documentationLinks : [],
            confidence: typeof p.confidence === 'number' ? p.confidence : 0.9,
            aiSource: model
        };
    } catch {
        if (text.length < 20) { return null; }
        return {
            errorType: error.type,
            explanation: text.slice(0, 300),
            possibleCause: '',
            location: `${error.relativeFile}:${error.line}`,
            suggestedFix: text.slice(0, 200),
            codeExample: extractCodeBlocks(text)[0] ?? '',
            documentationLinks: [],
            confidence: 0.72,
            aiSource: model
        };
    }
}

function parseLLMRootCauseResponse(text: string, error: ParsedError, model: string): RootCauseAnalysis | null {
    try {
        const clean = text.replace(/^```json\s*/im, '').replace(/```\s*$/m, '').trim();
        const p = JSON.parse(clean);
        return {
            rootFile: String(p.rootFile ?? error.relativeFile),
            rootLine: typeof p.rootLine === 'number' ? p.rootLine : error.line,
            reason: String(p.reason ?? ''),
            callChain: Array.isArray(p.callChain) ? p.callChain : [],
            confidence: typeof p.confidence === 'number' ? p.confidence : 0.85,
            aiSource: model
        };
    } catch { return null; }
}

function extractCodeBlocks(text: string): string[] {
    const blocks: string[] = [];
    const re = /```(?:\w+)?\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const code = m[1].trim();
        if (code) { blocks.push(code); }
    }
    return blocks;
}

function stripCodeBlocks(text: string): string {
    return text.replace(/```(?:\w+)?\n[\s\S]*?```/g, '[see code snippet below]').trim();
}

function extractVarName(message: string): string | null {
    return message.match(/reading '([^']+)'/)?.[1]
        ?? message.match(/"([^"]+)" is not/)?.[1]
        ?? null;
}

export const aiService = new AIService();
