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
exports.llmService = exports.LLMService = void 0;
const vscode = __importStar(require("vscode"));
const logger_1 = require("../utils/logger");
// ────────────────────────────────────────────────────────────────────────────
// GitHub Models API  (OpenAI-compatible — https://models.github.ai/inference)
// ────────────────────────────────────────────────────────────────────────────
const GITHUB_MODELS_ENDPOINT = 'https://models.github.ai/inference';
// Free-tier models on GitHub Models marketplace (no paid plan required):
//   openai/gpt-4o-mini  · meta/Llama-3.3-70B-Instruct  · microsoft/Phi-4
//   mistral-ai/Mistral-Small-3.1-24B-Instruct
const GITHUB_MODELS_MODEL = 'openai/gpt-4o-mini'; // free tier, fast, reliable
const REQUEST_TIMEOUT_MS = 25000; // 15 s hard timeout for all LLM calls
const COPILOT_TIMEOUT_MS = 45000; // slightly longer for streaming
class LLMService {
    constructor() {
        this.copilotModel = null;
        this.githubToken = null;
        this.modelProbed = false;
        /** Single in-flight init promise — prevents parallel re-initialization. */
        this._initPromise = null;
    }
    // ── Probe available AI backends ───────────────────────────────────────
    async initialize() {
        if (this._initPromise) {
            return this._initPromise;
        }
        this._initPromise = Promise.all([
            this.probeCopilot(),
            this.probeGithubToken()
        ]).then(() => {
            this.modelProbed = true;
        }).catch(() => {
            this.modelProbed = true; // mark probed even on error so we don't retry forever
        });
        return this._initPromise;
    }
    async probeCopilot() {
        try {
            const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
            if (models.length > 0) {
                this.copilotModel = models[0];
                logger_1.logger.info(`LLMService: Copilot model acquired — ${models[0].name}`);
                return;
            }
            // Try any available copilot model
            const any = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            if (any.length > 0) {
                this.copilotModel = any[0];
                logger_1.logger.info(`LLMService: Copilot fallback model — ${any[0].name}`);
            }
        }
        catch (err) {
            logger_1.logger.warn('LLMService: Copilot unavailable', err);
        }
    }
    async probeGithubToken() {
        try {
            const session = await vscode.authentication.getSession('github', ['read:user'], { silent: true });
            if (session) {
                this.githubToken = session.accessToken;
                logger_1.logger.info('LLMService: GitHub session token acquired');
            }
        }
        catch (err) {
            logger_1.logger.warn('LLMService: GitHub auth unavailable', err);
        }
    }
    // ── Primary send method — tries Copilot → GitHub Models → Fallback ───
    async send(messages, token, maxTokens) {
        if (!this.modelProbed) {
            await this.initialize();
        }
        // 1️⃣ VS Code Copilot Language Model API
        if (this.copilotModel) {
            try {
                return await this.sendViaCopilot(messages, token);
            }
            catch (err) {
                logger_1.logger.warn('LLMService: Copilot send failed, trying GitHub Models', err);
                this.copilotModel = null;
            }
        }
        // 2️⃣ GitHub Models REST API
        if (this.githubToken) {
            try {
                return await this.sendViaGithubModels(messages, maxTokens);
            }
            catch (err) {
                logger_1.logger.warn('LLMService: GitHub Models failed', err);
            }
        }
        // 3️⃣ No backend available
        return { text: '', model: 'none', source: 'fallback' };
    }
    // ── VS Code Copilot (vscode.lm) ──────────────────────────────────────
    async sendViaCopilot(messages, token) {
        const model = this.copilotModel;
        const vsMessages = messages.map(m => m.role === 'user'
            ? vscode.LanguageModelChatMessage.User(m.content)
            : vscode.LanguageModelChatMessage.Assistant(m.content));
        const cts = new vscode.CancellationTokenSource();
        // Respect external cancellation
        if (token) {
            token.onCancellationRequested(() => cts.cancel());
        }
        // Hard timeout — cancel the request if it takes too long
        const timeoutHandle = setTimeout(() => {
            logger_1.logger.warn(`LLMService: Copilot request timed out after ${COPILOT_TIMEOUT_MS}ms`);
            cts.cancel();
        }, COPILOT_TIMEOUT_MS);
        try {
            const response = await model.sendRequest(vsMessages, {}, cts.token);
            let text = '';
            for await (const chunk of response.text) {
                text += chunk;
            }
            return { text: text.trim(), model: model.name, source: 'copilot' };
        }
        finally {
            clearTimeout(timeoutHandle);
            cts.dispose();
        }
    }
    // ── GitHub Models REST API (OpenAI-compatible) ────────────────────────
    async sendViaGithubModels(messages, maxTokens = 512) {
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => {
            logger_1.logger.warn(`LLMService: GitHub Models request timed out after ${REQUEST_TIMEOUT_MS}ms`);
            controller.abort();
        }, REQUEST_TIMEOUT_MS);
        try {
            const body = JSON.stringify({
                model: GITHUB_MODELS_MODEL,
                messages: messages.map(m => ({ role: m.role, content: m.content })),
                temperature: 0.1,
                max_tokens: maxTokens
            });
            const resp = await fetch(`${GITHUB_MODELS_ENDPOINT}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.githubToken}`,
                    'X-GitHub-Api-Version': '2022-11-28'
                },
                body,
                signal: controller.signal
            });
            if (!resp.ok) {
                throw new Error(`GitHub Models API HTTP ${resp.status}: ${await resp.text()}`);
            }
            const json = await resp.json();
            const text = json.choices?.[0]?.message?.content ?? '';
            return { text: text.trim(), model: json.model ?? GITHUB_MODELS_MODEL, source: 'github-models' };
        }
        finally {
            clearTimeout(timeoutHandle);
        }
    }
    getStatus() {
        return {
            copilot: this.copilotModel !== null,
            githubModels: this.githubToken !== null,
            probed: this.modelProbed
        };
    }
    async refreshAuth() {
        this.copilotModel = null;
        this.githubToken = null;
        this.modelProbed = false;
        this._initPromise = null;
        await this.initialize();
    }
    dispose() {
        this.copilotModel = null;
        this.githubToken = null;
        this._initPromise = null;
    }
}
exports.LLMService = LLMService;
exports.llmService = new LLMService();
//# sourceMappingURL=llmService.js.map