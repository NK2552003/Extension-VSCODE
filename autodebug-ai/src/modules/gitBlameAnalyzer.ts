import * as vscode from 'vscode';
import * as path from 'path';
import { execSync } from 'child_process';
import { getWorkspaceRoot, isWorkspaceFile } from '../utils/fileUtils';
import { logger } from '../utils/logger';

export interface GitBlameInfo {
    file: string;
    line: number;
    commit: string;
    author: string;
    date: string;
    message: string;
    email: string;
}

export interface GitDiffSummary {
    changedFiles: string[];
    additions: number;
    deletions: number;
    recentCommits: Array<{ hash: string; message: string; author: string; date: string }>;
}

export class GitBlameAnalyzer {
    private cache: Map<string, GitBlameInfo[]> = new Map();
    private repoRoot: string | null = null;

    private getRepoRoot(): string | null {
        if (this.repoRoot) { return this.repoRoot; }
        const wsRoot = getWorkspaceRoot();
        if (!wsRoot) { return null; }
        try {
            const root = execSync('git rev-parse --show-toplevel', {
                cwd: wsRoot,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe']
            }).trim();
            this.repoRoot = root;
            return root;
        } catch {
            return null;
        }
    }

    blameLine(filePath: string, line: number): GitBlameInfo | null {
        const root = this.getRepoRoot();
        if (!root) { return null; }
        if (!isWorkspaceFile(filePath)) { return null; }

        try {
            const output = execSync(
                `git blame -L ${line},${line} --porcelain "${filePath}"`,
                { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            return this.parsePorcelain(output, filePath, line);
        } catch {
            return null;
        }
    }

    blameFile(filePath: string): GitBlameInfo[] {
        const cached = this.cache.get(filePath);
        if (cached) { return cached; }

        const root = this.getRepoRoot();
        if (!root || !isWorkspaceFile(filePath)) { return []; }

        try {
            const output = execSync(
                `git blame --porcelain "${filePath}"`,
                { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 5 * 1024 * 1024 }
            );
            const result = this.parseFullPorcelain(output, filePath);
            this.cache.set(filePath, result);
            return result;
        } catch {
            return [];
        }
    }

    getRecentDiff(): GitDiffSummary | null {
        const root = this.getRepoRoot();
        if (!root) { return null; }
        try {
            const statOutput = execSync('git diff --stat HEAD~1 HEAD 2>/dev/null || git diff --stat', {
                cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']
            });
            const logOutput = execSync('git log --oneline -10 --format="%H|%s|%an|%ar"', {
                cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']
            });

            const changedFiles: string[] = [];
            let additions = 0, deletions = 0;

            for (const line of statOutput.split('\n')) {
                const m = line.match(/^\s+(.+?)\s+\|\s+\d+\s+(\++)?(-+)?/);
                if (m?.[1]) { changedFiles.push(m[1].trim()); }
                const nums = line.match(/(\d+) insertions?.*?(\d+) deletions?/);
                if (nums) { additions += parseInt(nums[1]); deletions += parseInt(nums[2]); }
            }

            const recentCommits = logOutput.trim().split('\n').filter(Boolean).map(l => {
                const [hash, message, author, date] = l.split('|');
                return { hash: hash ?? '', message: message ?? '', author: author ?? '', date: date ?? '' };
            });

            return { changedFiles, additions, deletions, recentCommits };
        } catch {
            return null;
        }
    }

    private parsePorcelain(output: string, filePath: string, line: number): GitBlameInfo | null {
        const lines = output.split('\n');
        const commit = lines[0]?.split(' ')[0] ?? 'unknown';
        const author = lines.find(l => l.startsWith('author '))?.slice(7) ?? 'unknown';
        const email = lines.find(l => l.startsWith('author-mail '))?.slice(12).replace(/[<>]/g, '') ?? '';
        const date = lines.find(l => l.startsWith('author-time '))
            ? new Date(parseInt(lines.find(l => l.startsWith('author-time '))!.slice(12)) * 1000).toLocaleDateString()
            : 'unknown';
        const message = lines.find(l => l.startsWith('summary '))?.slice(8) ?? '';
        return { file: filePath, line, commit: commit.slice(0, 8), author, date, message, email };
    }

    private parseFullPorcelain(output: string, filePath: string): GitBlameInfo[] {
        const result: GitBlameInfo[] = [];
        const lines = output.split('\n');
        let currentCommit = '';
        let currentAuthor = '';
        let currentEmail = '';
        let currentDate = '';
        let currentMessage = '';
        let currentLine = 0;

        for (const line of lines) {
            const headerMatch = line.match(/^([0-9a-f]{40}) \d+ (\d+)/);
            if (headerMatch) {
                currentCommit = headerMatch[1].slice(0, 8);
                currentLine = parseInt(headerMatch[2]);
            } else if (line.startsWith('author ')) { currentAuthor = line.slice(7); }
            else if (line.startsWith('author-mail ')) { currentEmail = line.slice(12).replace(/[<>]/g, ''); }
            else if (line.startsWith('author-time ')) { currentDate = new Date(parseInt(line.slice(12)) * 1000).toLocaleDateString(); }
            else if (line.startsWith('summary ')) { currentMessage = line.slice(8); }
            else if (line.startsWith('\t')) {
                result.push({
                    file: filePath, line: currentLine,
                    commit: currentCommit, author: currentAuthor,
                    date: currentDate, message: currentMessage, email: currentEmail
                });
            }
        }
        return result;
    }

    clearCache(): void {
        this.cache.clear();
        this.repoRoot = null;
    }
}

export const gitBlameAnalyzer = new GitBlameAnalyzer();
