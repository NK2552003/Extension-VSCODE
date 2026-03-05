import * as vscode from 'vscode';

export enum LogLevel {
    DEBUG = 'DEBUG',
    INFO = 'INFO',
    WARN = 'WARN',
    ERROR = 'ERROR'
}

class Logger {
    private outputChannel: vscode.OutputChannel;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('AutoDebug AI');
    }

    private log(level: LogLevel, message: string, ...args: unknown[]): void {
        const timestamp = new Date().toISOString();
        const formatted = args.length > 0
            ? `[${timestamp}] [${level}] ${message} ${args.map(a => JSON.stringify(a)).join(' ')}`
            : `[${timestamp}] [${level}] ${message}`;
        this.outputChannel.appendLine(formatted);
    }

    debug(message: string, ...args: unknown[]): void { this.log(LogLevel.DEBUG, message, ...args); }
    info(message: string, ...args: unknown[]): void { this.log(LogLevel.INFO, message, ...args); }
    warn(message: string, ...args: unknown[]): void { this.log(LogLevel.WARN, message, ...args); }
    error(message: string, ...args: unknown[]): void { this.log(LogLevel.ERROR, message, ...args); }

    show(): void { this.outputChannel.show(); }
    dispose(): void { this.outputChannel.dispose(); }
}

export const logger = new Logger();
