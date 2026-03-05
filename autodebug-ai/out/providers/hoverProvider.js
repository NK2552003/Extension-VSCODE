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
exports.hoverProvider = exports.AutoDebugHoverProvider = void 0;
const vscode = __importStar(require("vscode"));
const errorSummarizer_1 = require("../modules/errorSummarizer");
const logger_1 = require("../utils/logger");
class AutoDebugHoverProvider {
    constructor() {
        this.errorMap = new Map();
    }
    updateErrors(uri, errors) {
        this.errorMap.set(uri.toString(), errors);
    }
    async provideHover(document, position, _token) {
        const key = document.uri.toString();
        const errors = this.errorMap.get(key);
        if (!errors || errors.length === 0) {
            return null;
        }
        // Find an error at the hovered line
        const error = errors.find(e => e.line - 1 === position.line);
        if (!error) {
            return null;
        }
        try {
            const result = await errorSummarizer_1.errorSummarizer.summarize(error);
            const md = errorSummarizer_1.errorSummarizer.formatForHover(result);
            const range = new vscode.Range(position.line, 0, position.line, document.lineAt(position.line).text.length);
            return new vscode.Hover(md, range);
        }
        catch (err) {
            logger_1.logger.error('HoverProvider: failed', err);
            return null;
        }
    }
}
exports.AutoDebugHoverProvider = AutoDebugHoverProvider;
exports.hoverProvider = new AutoDebugHoverProvider();
//# sourceMappingURL=hoverProvider.js.map