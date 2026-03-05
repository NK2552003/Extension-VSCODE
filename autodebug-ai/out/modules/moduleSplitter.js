"use strict";
/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  AutoDebug AI — Module Splitter  (ASTra v2)                                ║
 * ║                                                                              ║
 * ║  AST-driven intelligent module decomposition engine.                        ║
 * ║                                                                              ║
 * ║  Pipeline:                                                                   ║
 * ║    1. Parse       — TypeScript Compiler API AST walk (ts.createSourceFile)  ║
 * ║                     for .ts/.tsx/.js/.jsx; bracket-depth for other langs    ║
 * ║    2. Enrich      — compute metrics: cyclomatic complexity, maintainability ║
 * ║                     index, JSX depth, hook usage, async detection           ║
 * ║    3. Route       — detect existing workspace type/hook/util files and      ║
 * ║                     route extracted regions to the correct target           ║
 * ║    4. Link        — build a directed import graph between proposed files    ║
 * ║    5. Detect      — circular dependency risks, code smells, dead exports    ║
 * ║    6. Report      — rich 7-tab HTML webview + sidebar-ready SplitPlan      ║
 * ║                                                                              ║
 * ║  Advanced detections:                                                        ║
 * ║    ▸ Prop-drilling (>2 levels of passed props)                              ║
 * ║    ▸ Mixed-concern (API + state + UI in one component)                      ║
 * ║    ▸ God component (>4 responsibilities)                                    ║
 * ║    ▸ Inline type/interface co-location → routes to existing types file      ║
 * ║    ▸ useMemo / useCallback extraction hints                                 ║
 * ║    ▸ Dead export detection                                                  ║
 * ║    ▸ Duplicate logic fingerprinting                                         ║
 * ║    ▸ Test-file path suggestion per extracted file                           ║
 * ║    ▸ Barrel (index.ts) export generation                                    ║
 * ║    ▸ Bundle impact estimation (weighted LoC)                                ║
 * ║    ▸ Context-provider and HOC detection                                     ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.moduleSplitter = exports.ModuleSplitter = void 0;
const astParser_1 = require("../parsers/astParser");
// ─────────────────────────────────────────────────────────────────────────────
// Internal parsing helpers
// ─────────────────────────────────────────────────────────────────────────────
function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function countMatches(src, re) { return (src.match(re) ?? []).length; }
function maxNestingDepth(src) {
    let d = 0, max = 0;
    for (const ch of src) {
        if (ch === '{' || ch === '(' || ch === '[') {
            d++;
            max = Math.max(max, d);
        }
        else if (ch === '}' || ch === ')' || ch === ']') {
            d = Math.max(0, d - 1);
        }
    }
    return max;
}
function cyclomaticScore(src) {
    return 1 + countMatches(src, /\bif\b/g) + countMatches(src, /\belse\b/g)
        + countMatches(src, /\bfor\b/g) + countMatches(src, /\bwhile\b/g)
        + countMatches(src, /\bswitch\b/g) + countMatches(src, /\bcase\b/g)
        + countMatches(src, /\bcatch\b/g) + countMatches(src, /\?\?|\?\./g)
        + countMatches(src, /&&|\|\|/g);
}
function maintainabilityIndex(src, lineCount, cc) {
    const tokens = src.match(/\b[a-zA-Z_$]\w*\b/g) ?? [];
    const uq = new Set(tokens).size;
    const hv = uq > 1 ? uq * Math.log2(uq) : 1;
    const loc = Math.max(1, lineCount);
    const raw = 171 - 5.2 * Math.log(hv) - 0.23 * cc - 16.2 * Math.log(loc);
    return Math.max(0, Math.min(100, Math.round((raw * 100) / 171)));
}
function extractInlineTypeNames(src) {
    const names = [];
    for (const m of src.matchAll(/(?:type|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
        names.push(m[1]);
    }
    return [...new Set(names)];
}
const TOP_LEVEL_PATTERNS = [
    { re: /^(?:export\s+)?(?:const|function)\s+([A-Z][A-Za-z0-9_]*Provider)\b/, kind: 'context-provider' },
    { re: /^(?:export\s+)?(?:const|function)\s+(with[A-Z][A-Za-z0-9_]*)\b/, kind: 'hoc' },
    { re: /^(?:export\s+)?(?:const|function)\s+(use[A-Z][A-Za-z0-9_]*)(?:\s*[:=]|\s*\()/, kind: 'hook' },
    { re: /^(?:export\s+(?:default\s+)?)?(?:const|function)\s+([A-Z][A-Za-z0-9_]*)(?:\s*[:=]|\s*\()/, kind: 'react-component' },
    { re: /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/, kind: 'class' },
    { re: /^(?:export\s+)?(?:async\s+)?function\s+([a-z_][A-Za-z0-9_]*)\s*\(/, kind: 'utility-function' },
    { re: /^(?:export\s+)?const\s+([a-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\(/, kind: 'utility-function' },
    { re: /^(?:export\s+)?(?:type|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/, kind: 'type-block' },
    { re: /^(?:export\s+)?(?:const|enum|let)\s+([A-Z_][A-Z0-9_]{3,})\s*(?:=|:)/, kind: 'constant-block' },
];
function detectKind(line) {
    for (const { re, kind } of TOP_LEVEL_PATTERNS) {
        const m = line.match(re);
        if (m) {
            return { kind, name: m[1] };
        }
    }
    return null;
}
function parseRegions(lines) {
    const regions = [];
    let i = 0;
    while (i < lines.length) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
            i++;
            continue;
        }
        const detected = detectKind(trimmed);
        if (detected) {
            const startLine = i + 1;
            const regionLines = [lines[i]];
            let depth = (lines[i].match(/[{([]/g) ?? []).length - (lines[i].match(/[})\]]/g) ?? []).length;
            let j = i + 1;
            while (j < lines.length && (depth > 0 || j === i + 1)) {
                const l = lines[j];
                depth += (l.match(/[{([]/g) ?? []).length;
                depth -= (l.match(/[})\]]/g) ?? []).length;
                regionLines.push(l);
                j++;
                if (depth <= 0) {
                    break;
                }
            }
            regions.push({ kind: detected.kind, name: detected.name, startLine, lines: regionLines });
            i = j;
        }
        else {
            i++;
        }
    }
    return regions;
}
function findExternalDeps(regionSrc, allNames, selfName) {
    const deps = [];
    for (const name of allNames) {
        if (name === selfName) {
            continue;
        }
        const declRe = new RegExp(`(?:function|const|let|var|class|type|interface|enum)\\s+${name}\\b`);
        const useRe = new RegExp(`\\b${name}\\b`);
        if (!declRe.test(regionSrc) && useRe.test(regionSrc)) {
            deps.push(name);
        }
    }
    return deps;
}
// ─────────────────────────────────────────────────────────────────────────────
// Smell detection
// ─────────────────────────────────────────────────────────────────────────────
function detectSmells(src, kind, lineCount, cc, nesting) {
    const s = [];
    if (kind === 'react-component') {
        let concerns = 0;
        if (/useState|useReducer/.test(src)) {
            concerns++;
        }
        if (/useEffect/.test(src)) {
            concerns++;
        }
        if (/fetch|axios|useSWR|useQuery/.test(src)) {
            concerns++;
        }
        if (/\.(map|filter|reduce)\(/.test(src)) {
            concerns++;
        }
        if (/styled\.|css`|className/.test(src)) {
            concerns++;
        }
        if (concerns >= 4) {
            s.push('God Component');
        }
    }
    if ((src.match(/props\.\w+\.\w+\.\w+/g) ?? []).length >= 2) {
        s.push('Prop Drilling');
    }
    if (/fetch\(|axios\.|\.then\(/.test(src) && /<[A-Z][\w]*/.test(src)) {
        s.push('Mixed Concerns (API + Render)');
    }
    if (countMatches(src, /style\s*=\s*\{\{/g) > 3) {
        s.push('Excessive Inline Styles');
    }
    if (lineCount > 150) {
        s.push('Oversized Module');
    }
    if (nesting > 7) {
        s.push('Deep Nesting (>7)');
    }
    if (countMatches(src, /\bcase\b/g) > 8) {
        s.push('Long Switch Statement');
    }
    if (countMatches(src, /\b(?<![\w.])\d{3,}\b(?![\w.])/g) > 4) {
        s.push('Magic Numbers');
    }
    if (countMatches(src, /\/\/.*(?:TODO|FIXME|HACK|XXX)/g) > 2) {
        s.push('TODO/FIXME Debt');
    }
    if (!/useCallback|useMemo/.test(src) && /\.map\(.*=>\s*</.test(src) && lineCount > 40) {
        s.push('Missing useMemo on mapped JSX');
    }
    return s;
}
function evaluateExtraction(kind, lineCount, cc, nesting, smells) {
    const reasons = [];
    let confidence = 'low';
    if (kind === 'type-block') {
        return { shouldExtract: false, reason: '', confidence: 'low' };
    }
    if (lineCount < 15) {
        return { shouldExtract: false, reason: '', confidence: 'low' };
    }
    if (kind === 'context-provider') {
        reasons.push('Context providers are more reusable in dedicated files');
        confidence = 'high';
    }
    if (kind === 'hoc') {
        reasons.push('Higher-order components belong in a dedicated HOC file');
        confidence = 'high';
    }
    if (kind === 'react-component' && lineCount > 40) {
        reasons.push(`${lineCount}-line component violates single-responsibility`);
        confidence = lineCount > 80 ? 'high' : 'medium';
    }
    if (kind === 'hook' && lineCount > 25) {
        reasons.push(`${lineCount}-line custom hook — move to hooks/ directory`);
        confidence = 'high';
    }
    if (cc >= 10) {
        reasons.push(`Cyclomatic complexity ${cc} exceeds threshold (10)`);
        confidence = confidence === 'high' ? 'high' : 'medium';
    }
    if (nesting >= 6) {
        reasons.push(`Nesting depth ${nesting} — extractable sub-structure`);
        if (confidence === 'low') {
            confidence = 'medium';
        }
    }
    if (smells.includes('God Component')) {
        reasons.push('God Component — too many responsibilities');
        confidence = 'high';
    }
    if (smells.includes('Mixed Concerns (API + Render)')) {
        reasons.push('API calls mixed with render — extract custom hook');
        confidence = 'high';
    }
    if (lineCount >= 60 && reasons.length === 0) {
        reasons.push(`${lineCount} lines — large region reduces readability`);
        confidence = 'medium';
    }
    return { shouldExtract: reasons.length > 0, reason: reasons.join('; '), confidence };
}
// ─────────────────────────────────────────────────────────────────────────────
// File metrics
// ─────────────────────────────────────────────────────────────────────────────
function computeFileMetrics(sourceCode, regions) {
    const lines = sourceCode.split('\n');
    const blankLines = lines.filter(l => l.trim() === '').length;
    const commentLines = lines.filter(l => l.trim().startsWith('//') || l.trim().startsWith('*')).length;
    const codeLines = lines.length - blankLines - commentLines;
    const complexities = regions.map(r => r.complexity);
    const avgCC = complexities.length ? complexities.reduce((a, b) => a + b, 0) / complexities.length : 0;
    const maxCC = complexities.length ? Math.max(...complexities) : 0;
    const nestings = regions.map(r => r.nestingDepth);
    const avgND = nestings.length ? nestings.reduce((a, b) => a + b, 0) / nestings.length : 0;
    const maxND = nestings.length ? Math.max(...nestings) : 0;
    const mi = regions.length ? regions.reduce((s, r) => s + r.maintainabilityIndex, 0) / regions.length : 100;
    const tokenFreq = {};
    for (const m of (sourceCode.match(/\b[a-zA-Z_]\w{3,}\b/g) ?? [])) {
        tokenFreq[m] = (tokenFreq[m] ?? 0) + 1;
    }
    const dupRisk = Math.min(1, Object.values(tokenFreq).filter(v => v > 5).length / 30);
    const health = mi > 80 && avgCC < 5 ? 'excellent' :
        mi > 65 && avgCC < 8 ? 'good' :
            mi > 50 && avgCC < 12 ? 'fair' :
                mi > 30 ? 'poor' : 'critical';
    return {
        totalLines: lines.length, codeLines, blankLines, commentLines,
        avgCyclomaticComplexity: Math.round(avgCC * 10) / 10,
        maxCyclomaticComplexity: maxCC,
        avgNestingDepth: Math.round(avgND * 10) / 10,
        maxNestingDepth: maxND,
        maintainabilityIndex: Math.round(mi),
        bundleImpactScore: regions.reduce((s, r) => s + r.bundleWeight, 0),
        duplicateLogicRisk: Math.round(dupRisk * 100) / 100,
        overallHealth: health,
    };
}
// ─────────────────────────────────────────────────────────────────────────────
// Linkage graph
// ─────────────────────────────────────────────────────────────────────────────
function buildLinkageMap(proposedFiles, regions) {
    const linkages = [];
    const regionToFile = {};
    for (const pf of proposedFiles) {
        regionToFile[pf.sourceRegionId] = pf.fileName;
    }
    for (const pf of proposedFiles) {
        const region = regions.find(r => r.id === pf.sourceRegionId);
        if (!region) {
            continue;
        }
        for (const dep of region.externalDeps) {
            const depRegion = regions.find(r => r.name === dep);
            if (!depRegion) {
                continue;
            }
            const depFile = regionToFile[depRegion.id];
            if (!depFile || depFile === pf.fileName) {
                continue;
            }
            const existing = linkages.find(l => l.from === pf.fileName && l.to === depFile);
            if (existing) {
                if (!existing.symbols.includes(dep)) {
                    existing.symbols.push(dep);
                }
            }
            else {
                linkages.push({ from: pf.fileName, to: depFile, symbols: [dep], isCircular: false });
            }
        }
    }
    for (const link of linkages) {
        const rev = linkages.find(l => l.from === link.to && l.to === link.from);
        if (rev) {
            link.isCircular = true;
            rev.isCircular = true;
        }
    }
    return linkages;
}
// ─────────────────────────────────────────────────────────────────────────────
// Type routing
// ─────────────────────────────────────────────────────────────────────────────
function resolveTypeRouting(typeRegions, ctx) {
    if (typeRegions.length === 0) {
        return [];
    }
    const preferred = ['types.ts', 'types.tsx', 'interfaces.ts', 'index.d.ts', 'global.d.ts'];
    const sameDir = ctx.existingTypeFiles.filter(f => f.startsWith(ctx.sourceDir) && preferred.some(n => f.endsWith(n)));
    const projTypes = ctx.existingTypeFiles.filter(f => preferred.some(n => f.endsWith(n)));
    const target = sameDir[0] ?? projTypes[0] ?? ctx.existingTypeFiles[0] ?? null;
    const rel = target ? target.replace(ctx.sourceDir, '.').replace(/\\/g, '/') : './types.ts';
    const reason = target
        ? (preferred.some(n => (target ?? '').endsWith(n)) ? `Existing ${rel} detected — consolidate types there` : `Nearest type file ${rel} in workspace`)
        : 'No existing types file found — create src/types.ts to centralise type definitions';
    return [{ typeNames: typeRegions.map(r => r.name), targetFile: rel, reason }];
}
// ─────────────────────────────────────────────────────────────────────────────
// Test suggestion
// ─────────────────────────────────────────────────────────────────────────────
function buildTestSuggestion(pf, region) {
    const tests = [];
    if (region.kind === 'react-component' || region.kind === 'context-provider') {
        tests.push('renders without crashing');
        tests.push('renders correct snapshot');
        if (region.externalDeps.length > 0) {
            tests.push(`accepts and displays ${region.externalDeps[0]} prop`);
        }
    }
    else if (region.kind === 'hook') {
        tests.push('initialises with default state');
        tests.push('updates state correctly on action');
        if (region.hasAsyncOps) {
            tests.push('handles async operation and loading state');
        }
    }
    else if (region.kind === 'utility-function') {
        tests.push('returns expected output for valid input');
        tests.push('handles edge cases (null, empty, boundary)');
        if (region.hasAsyncOps) {
            tests.push('resolves promise with correct value');
        }
    }
    else if (region.kind === 'class') {
        tests.push('instantiates correctly');
        tests.push('public methods return expected values');
    }
    if (region.smells.length > 0) {
        tests.push(`does not regress: ${region.smells[0].toLowerCase()}`);
    }
    return { sourceFile: pf.fileName, testFile: pf.testFilePath, suggestedTests: tests };
}
// ─────────────────────────────────────────────────────────────────────────────
// Barrel export
// ─────────────────────────────────────────────────────────────────────────────
function buildBarrelExport(proposed) {
    const lines = [
        '/**',
        ' * Auto-generated barrel export — AutoDebug AI Module Splitter (ASTra v2).',
        ' * Place this as index.ts in the extracted files directory.',
        ' */',
        '',
    ];
    for (const pf of proposed) {
        if (pf.routedToExisting) {
            continue;
        }
        const path = './' + pf.fileName.replace(/\.[jt]sx?$/, '')
            .replace(/^(?:components|hooks|utils|services|hoc|constants)\//, '');
        lines.push(`export { ${pf.regionName} } from '${path}';`);
    }
    return lines.join('\n');
}
// ─────────────────────────────────────────────────────────────────────────────
// ModuleSplitter
// ─────────────────────────────────────────────────────────────────────────────
class ModuleSplitter {
    detectLanguage(fileName) {
        const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
        const map = {
            ts: 'TypeScript', tsx: 'TypeScript/React', js: 'JavaScript', jsx: 'JavaScript/React',
            py: 'Python', java: 'Java', cs: 'C#', go: 'Go', rs: 'Rust', php: 'PHP',
        };
        return map[ext] ?? 'Unknown';
    }
    /**
     * Primary analysis entry point.
     * @param sourceCode  Raw text of the file.
     * @param fileName    File name (for language detection + path generation).
     * @param ctx         Optional workspace context for routing decisions.
     */
    analyse(sourceCode, fileName, ctx) {
        const lines = sourceCode.split('\n');
        const language = this.detectLanguage(fileName);
        const ext = fileName.split('.').pop() ?? 'ts';
        const isReact = ['tsx', 'jsx'].includes(ext) || language.includes('React');
        // ── Real AST parse (TypeScript Compiler API for TS/JS, fallback for others) ──
        const parseResult = (0, astParser_1.parseSourceRegions)(sourceCode, fileName);
        const astRegions = parseResult.regions;
        const allNames = astRegions.map(r => r.name);
        // Enrich regions using AST-accurate field values where available
        const regions = astRegions.map((raw, idx) => {
            const src = raw.lines.join('\n');
            const lineCount = raw.lines.length;
            const nesting = maxNestingDepth(src);
            const cc = cyclomaticScore(src);
            const mi = maintainabilityIndex(src, lineCount, cc);
            const exDeps = findExternalDeps(src, allNames, raw.name);
            const smells = detectSmells(src, raw.kind, lineCount, cc, nesting);
            const inlineTypes = extractInlineTypeNames(src);
            // Use AST-derived flags when available (much more accurate than regex for JSX/hooks)
            const hasJSX = raw.hasJSX;
            const hasHooks = raw.hasHooks;
            const hasAsync = raw.hasAsyncOps;
            const hasState = /useState|useReducer|useContext|Redux|zustand|jotai/.test(src);
            const testable = ['utility-function', 'hook', 'class'].includes(raw.kind) || (raw.kind === 'react-component' && !hasState);
            const bw = lineCount * (raw.kind === 'react-component' ? 2 : raw.kind === 'class' ? 1.8 : 1);
            const isDeadExport = raw.isExported &&
                !new RegExp(`\\b${raw.name}\\b`).test(astRegions.filter((_, i2) => i2 !== idx).map(r => r.lines.join('\n')).join('\n'));
            const dec = evaluateExtraction(raw.kind, lineCount, cc, nesting, smells);
            return {
                id: `region_${idx}_${raw.name}`, kind: raw.kind, name: raw.name,
                startLine: raw.startLine, endLine: raw.endLine,
                lineCount, nestingDepth: nesting,
                externalDeps: exDeps, internalDeps: exDeps.filter(d => allNames.includes(d)),
                complexity: cc, maintainabilityIndex: mi,
                shouldExtract: dec.shouldExtract, extractionReason: dec.reason, confidence: dec.confidence,
                smells, hasJSX, hasHooks, hasAsyncOps: hasAsync, hasStateManagement: hasState,
                testable, inlineTypeNames: inlineTypes, isDeadExport, bundleWeight: bw,
            };
        });
        const extractionCandidates = regions.filter(r => r.shouldExtract);
        const retainedRegions = regions.filter(r => !r.shouldExtract);
        const typeRegions = regions.filter(r => r.kind === 'type-block');
        const effectiveCtx = ctx ?? { existingTypeFiles: [], existingHookFiles: [], existingUtilFiles: [], existingIndexFiles: [], sourceDir: '' };
        const typeRouting = resolveTypeRouting(typeRegions, effectiveCtx);
        const proposedFiles = extractionCandidates.map(r => this.buildProposedFile(r, fileName, isReact, effectiveCtx, typeRouting, lines.slice(r.startLine - 1, r.endLine)));
        const linkageMap = buildLinkageMap(proposedFiles, regions);
        const circularRisks = [...new Set(linkageMap.filter(l => l.isCircular).flatMap(l => [l.from, l.to]))];
        for (const pf of proposedFiles) {
            pf.linkedTo = linkageMap.filter(l => l.from === pf.fileName).map(l => l.to);
            pf.linkedFrom = linkageMap.filter(l => l.to === pf.fileName).map(l => l.from);
        }
        const codeSmells = this.buildFileSmells(regions);
        const metrics = computeFileMetrics(sourceCode, regions);
        const testFileSuggestions = proposedFiles.map(pf => buildTestSuggestion(pf, regions.find(r => r.id === pf.sourceRegionId)));
        const barrelExport = buildBarrelExport(proposedFiles);
        const summary = this.buildSummary(regions, extractionCandidates, proposedFiles, typeRouting, fileName, metrics);
        return {
            sourceFile: fileName, language, totalLines: lines.length,
            parseEngine: parseResult.engineUsed,
            regions, retainedRegions, extractionCandidates, proposedFiles, summary,
            linkageMap, codeSmells, typeRouting, barrelExport, testFileSuggestions, circularRisks, metrics,
        };
    }
    buildProposedFile(region, sourceFile, isReact, ctx, typeRouting, regionLines = []) {
        const ext = sourceFile.split('.').pop() ?? 'ts';
        const dirHint = (region.kind === 'hook' || region.kind === 'context-provider') ? 'hooks/' :
            region.kind === 'utility-function' ? 'utils/' :
                region.kind === 'class' ? 'services/' :
                    region.kind === 'hoc' ? 'hoc/' :
                        region.kind === 'constant-block' ? 'constants/' : 'components/';
        const fileName = `${dirHint}${region.name}.${ext}`;
        const requiredImports = [];
        if (isReact && (region.hasJSX || ['react-component', 'hoc', 'context-provider'].includes(region.kind))) {
            requiredImports.push(`import React from 'react';`);
        }
        if (region.inlineTypeNames.length > 0 && typeRouting.length > 0) {
            requiredImports.push(`import type { ${region.inlineTypeNames.slice(0, 6).join(', ')} } from '${typeRouting[0].targetFile.replace('./', '../')}';`);
        }
        if (region.externalDeps.length > 0) {
            requiredImports.push(`// TODO: import { ${region.externalDeps.slice(0, 5).join(', ')} } from '../<source>';`);
        }
        let propInterface;
        if (['react-component', 'context-provider'].includes(region.kind) && region.externalDeps.length > 0) {
            const props = region.externalDeps.slice(0, 8).map(dep => `  ${dep}: unknown; // TODO: add type`).join('\n');
            propInterface = `interface ${region.name}Props {\n${props}\n}\n`;
        }
        const estimatedLines = region.lineCount + requiredImports.length + 4 + (propInterface ? propInterface.split('\n').length : 0);
        const testFilePath = `${dirHint}${region.name}.test.${ext}`;
        const barrelEntry = `export { ${region.name} } from './${region.name}';`;
        const routedToExisting = region.kind === 'type-block' ? (typeRouting[0]?.targetFile) : undefined;
        // ── Generate full file content ───────────────────────────────────────
        const cl = [];
        cl.push(`// Auto-generated by AutoDebug AI — Module Splitter`);
        cl.push(`// Region: ${region.name} (${region.kind})`);
        cl.push(`// Source: ${sourceFile}`);
        cl.push('');
        const realImports = requiredImports.filter(i => !i.startsWith('//'));
        const todoImports = requiredImports.filter(i => i.startsWith('//'));
        for (const imp of realImports) {
            cl.push(imp);
        }
        if (realImports.length > 0) {
            cl.push('');
        }
        if (propInterface) {
            cl.push(propInterface);
        }
        if (regionLines.length > 0) {
            for (const line of regionLines) {
                cl.push(line);
            }
            const regionSrc = regionLines.join('\n');
            if (!/\bexport\b/.test(regionSrc)) {
                cl.push('');
                cl.push(`export { ${region.name} };`);
            }
        }
        else {
            cl.push(`// TODO: paste the ${region.name} code here`);
        }
        if (todoImports.length > 0) {
            cl.push('');
            for (const imp of todoImports) {
                cl.push(imp);
            }
        }
        const generatedContent = cl.join('\n');
        return { fileName, sourceRegionId: region.id, regionName: region.name, estimatedLines,
            requiredImports, propInterface, linkedTo: [], linkedFrom: [],
            routedToExisting, testFilePath, barrelEntry, generatedContent };
    }
    buildFileSmells(regions) {
        const smellMap = {};
        for (const r of regions) {
            for (const s of r.smells) {
                (smellMap[s] = smellMap[s] ?? []).push(r.id);
            }
        }
        const sev = {
            'God Component': 'critical', 'Mixed Concerns (API + Render)': 'high',
            'Prop Drilling': 'high', 'Excessive Inline Styles': 'medium',
            'Oversized Module': 'high', 'Deep Nesting (>7)': 'high',
            'Long Switch Statement': 'medium', 'Magic Numbers': 'low',
            'TODO/FIXME Debt': 'low', 'Missing useMemo on mapped JSX': 'medium',
        };
        const rec = {
            'God Component': 'Split into data, presentational, and layout components.',
            'Mixed Concerns (API + Render)': 'Extract a custom hook (useXxxData) for data-fetching.',
            'Prop Drilling': 'Use React Context, Zustand, or Redux to share state.',
            'Excessive Inline Styles': 'Move to CSS modules, styled-components, or a design-token system.',
            'Oversized Module': 'Apply Single Responsibility Principle.',
            'Deep Nesting (>7)': 'Use early returns or extract helper components.',
            'Long Switch Statement': 'Replace with a strategy/handler map: const handlers = { key: fn }.',
            'Magic Numbers': 'Replace with named constants (const MAX_ITEMS = 100).',
            'TODO/FIXME Debt': 'Create tracked issues for each TODO and remove stale comments.',
            'Missing useMemo on mapped JSX': 'Wrap mapped JSX with useMemo and key elements correctly.',
        };
        return Object.entries(smellMap).map(([name, ids]) => ({
            name, severity: sev[name] ?? 'low',
            description: rec[name] ?? '',
            affectedRegionIds: ids,
            recommendation: rec[name] ?? 'Refactor to improve code quality.',
        }));
    }
    buildSummary(regions, candidates, proposed, typeRouting, sourceFile, metrics) {
        const oc = metrics.avgCyclomaticComplexity > 15 ? 'highly-complex' :
            metrics.avgCyclomaticComplexity > 8 ? 'complex' :
                metrics.avgCyclomaticComplexity > 4 ? 'moderate' : 'simple';
        const recommendation = candidates.length === 0
            ? `File health is "${metrics.overallHealth}". No immediate splits required. Maintainability Index: ${metrics.maintainabilityIndex}/100.`
            : `${candidates.length} region${candidates.length > 1 ? 's' : ''} should be extracted. MI ${metrics.maintainabilityIndex}/100 — splitting will improve maintainability and testability.`;
        const preview = [
            `Source:  ${sourceFile}  (${metrics.totalLines} lines, MI: ${metrics.maintainabilityIndex}/100)`,
            `Health:  ${metrics.overallHealth.toUpperCase()}  |  Avg CC: ${metrics.avgCyclomaticComplexity}  |  Dup Risk: ${Math.round(metrics.duplicateLogicRisk * 100)}%`,
            '',
        ];
        for (const p of proposed) {
            if (p.routedToExisting) {
                preview.push(`  [ROUTE]  ${p.regionName} → ${p.routedToExisting}  (existing file)`);
            }
            else {
                preview.push(`  [CREATE] ${p.fileName}  (~${p.estimatedLines} lines)  ← ${p.regionName}`);
                preview.push(`           ${p.testFilePath}  (test file)`);
            }
        }
        for (const tr of typeRouting) {
            if (tr.typeNames.length > 0 && !proposed.some(p => p.routedToExisting === tr.targetFile)) {
                preview.push(`  [ROUTE]  ${tr.typeNames.join(', ')} → ${tr.targetFile}`);
            }
        }
        if (proposed.length > 0) {
            preview.push('');
            preview.push(`  [MODIFY] ${sourceFile}  — replace extracted regions with import statements`);
            preview.push(`  [CREATE] index.ts  — barrel re-export for extracted modules`);
        }
        return {
            totalRegions: regions.length, extractionCount: candidates.length,
            retainedCount: regions.length - candidates.length,
            typeRoutingCount: typeRouting.reduce((s, t) => s + t.typeNames.length, 0),
            overallComplexity: oc, recommendation, dryRunPreview: preview,
        };
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Rich HTML report — themed to match the AutoDebug AI sidebar (dashboard.html)
    // ─────────────────────────────────────────────────────────────────────────
    buildHtmlReport(plan) {
        // ── Inline SVG icons ─────────────────────────────────────────────────
        const I = {
            split: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"/><path d="m15 9 6-6"/></svg>`,
            comp: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
            hook: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
            cls: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`,
            fn: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
            type: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
            file: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
            link: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
            warn: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
            check: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
            test: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
            barrel: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>`,
            metric: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
            route: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="m4.22 4.22 2.12 2.12"/><path d="m17.66 17.66 2.12 2.12"/><path d="M2 12h3"/><path d="M19 12h3"/></svg>`,
            ast: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="3"/><line x1="12" y1="8" x2="12" y2="13"/><circle cx="5" cy="18" r="3"/><circle cx="19" cy="18" r="3"/><line x1="9.5" y1="14" x2="5.5" y2="16"/><line x1="14.5" y1="14" x2="18.5" y2="16"/></svg>`,
        };
        // ── Colour helpers ───────────────────────────────────────────────────
        const kindColor = (k) => k === 'react-component' ? 'var(--vscode-terminal-ansiCyan,#61dafb)' :
            k === 'hook' ? 'var(--vscode-terminal-ansiMagenta,#c792ea)' :
                k === 'context-provider' ? 'var(--vscode-terminal-ansiRed,#ff9cac)' :
                    k === 'hoc' ? 'var(--vscode-terminal-ansiYellow,#ffcb8b)' :
                        k === 'class' ? 'var(--vscode-terminal-ansiBlue,#82aaff)' :
                            k === 'utility-function' ? 'var(--vscode-terminal-ansiGreen,#c3e88d)' :
                                k === 'type-block' ? 'var(--vscode-editorInfo-foreground,#89ddff)' : '#ffcb6b';
        const kindIcon = (k) => ['react-component', 'context-provider', 'hoc'].includes(k) ? I.comp :
            k === 'hook' ? I.hook : k === 'class' ? I.cls :
                k === 'utility-function' ? I.fn : k === 'type-block' ? I.type : I.barrel;
        const healthColor = (h) => h === 'excellent' ? 'var(--vscode-terminal-ansiGreen,#4caf50)' :
            h === 'good' ? '#81c784' :
                h === 'fair' ? 'var(--vscode-editorWarning-foreground,#cca700)' :
                    h === 'poor' ? 'var(--vscode-terminal-ansiYellow,#ff8a65)' :
                        'var(--vscode-editorError-foreground,#f14c4c)';
        const sevColor = (s) => s === 'critical' ? 'var(--vscode-editorError-foreground,#f14c4c)' :
            s === 'high' ? 'var(--vscode-editorWarning-foreground,#cca700)' :
                s === 'medium' ? 'var(--vscode-editorInfo-foreground,#3794ff)' :
                    'var(--vscode-descriptionForeground,#888)';
        const confColor = (c) => c === 'high' ? 'var(--vscode-terminal-ansiGreen,#4caf50)' :
            c === 'medium' ? 'var(--vscode-editorWarning-foreground,#cca700)' :
                'var(--vscode-descriptionForeground,#888)';
        const m = plan.metrics;
        const shortName = esc(plan.sourceFile.split('/').pop() ?? plan.sourceFile);
        const hc = healthColor(m.overallHealth);
        const ccC = m.avgCyclomaticComplexity > 10 ? 'var(--vscode-editorError-foreground,#f14c4c)' :
            m.avgCyclomaticComplexity > 7 ? 'var(--vscode-editorWarning-foreground,#cca700)' :
                'var(--vscode-terminal-ansiGreen,#4caf50)';
        const astBadge = plan.parseEngine === 'typescript-ast'
            ? `<span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:10px;background:rgba(78,201,176,0.1);color:var(--vscode-terminal-ansiGreen,#4ec9b0);border:1px solid rgba(78,201,176,0.25)">${I.ast}&nbsp;AST</span>`
            : `<span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:10px;background:rgba(127,127,127,0.1);color:var(--vscode-descriptionForeground,#888);border:1px solid rgba(127,127,127,0.2)">${I.ast}&nbsp;Heuristic</span>`;
        // ── Reusable primitives ──────────────────────────────────────────────
        const sectionLabel = (icon, text, count) => `<div class="section-label">${icon}&nbsp;${text}${count !== undefined ? ` <span style="font-size:9px;padding:0 5px;background:var(--vscode-badge-background,rgba(127,127,127,0.2));border-radius:8px;color:var(--vscode-badge-foreground,#aaa)">${count}</span>` : ''}</div>`;
        const chip = (text, col) => `<span style="font-size:9px;font-weight:600;padding:1px 5px;border-radius:10px;background:${col}18;color:${col};border:1px solid ${col}33">${text}</span>`;
        const miBar = (mi) => {
            const col = mi > 70 ? 'var(--vscode-terminal-ansiGreen,#4caf50)' :
                mi > 50 ? 'var(--vscode-editorWarning-foreground,#cca700)' :
                    'var(--vscode-editorError-foreground,#f14c4c)';
            return `<div style="background:var(--vscode-panel-border,rgba(127,127,127,0.15));border-radius:3px;height:3px;overflow:hidden;margin-top:3px"><div style="width:${mi}%;height:100%;background:${col};border-radius:3px"></div></div>`;
        };
        const metricCard = (label, val, sub, col) => `<div style="flex:1;min-width:80px;background:var(--vscode-sideBarSectionHeader-background,rgba(127,127,127,0.05));border:1px solid var(--vscode-panel-border,rgba(127,127,127,0.18));border-radius:5px;padding:8px 10px">
               <div style="font-size:9px;color:var(--vscode-descriptionForeground,#777);font-weight:700;text-transform:uppercase;letter-spacing:0.06em">${label}</div>
               <div style="font-size:17px;font-weight:700;color:${col ?? 'var(--vscode-foreground,#d4d4d4)'};margin:3px 0 1px">${val}</div>
               <div style="font-size:9px;color:var(--vscode-descriptionForeground,#666)">${sub}</div>
             </div>`;
        const confBadge = (c) => `<span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:10px;background:${confColor(c)}18;color:${confColor(c)};border:1px solid ${confColor(c)}33">${c.toUpperCase()}</span>`;
        // ══════════════════════════════════════════════════════════════════════
        // Tab 1 — Overview
        // ══════════════════════════════════════════════════════════════════════
        const tabOverview = `
<div class="panel-inner">
  ${sectionLabel(I.metric, 'File Metrics')}
  <div style="display:flex;gap:6px;flex-wrap:wrap;padding:0 12px 10px">
    ${metricCard('Lines', m.totalLines, `${m.codeLines} code · ${m.blankLines} blank`)}
    ${metricCard('Health', m.overallHealth.toUpperCase(), `MI: ${m.maintainabilityIndex}/100`, hc)}
    ${metricCard('Avg CC', m.avgCyclomaticComplexity, `Max: ${m.maxCyclomaticComplexity}`, ccC)}
    ${metricCard('Nesting', m.avgNestingDepth, `Max: ${m.maxNestingDepth}`, m.avgNestingDepth > 5 ? 'var(--vscode-editorError-foreground,#f14c4c)' : undefined)}
    ${metricCard('Dup Risk', `${Math.round(m.duplicateLogicRisk * 100)}%`, 'logic repeats', m.duplicateLogicRisk > 0.4 ? 'var(--vscode-editorWarning-foreground,#cca700)' : undefined)}
    ${metricCard('Splits', plan.summary.extractionCount, `${plan.summary.retainedCount} retained`)}
  </div>
  ${sectionLabel(I.check, 'Recommendation')}
  <div class="rc-block" style="margin:0 12px 10px">
    <div class="rc-row"><div class="rc-val">${esc(plan.summary.recommendation)}</div></div>
    <div class="rc-row">
      <div class="rc-key">Maintainability Index — ${m.maintainabilityIndex}/100</div>
      ${miBar(m.maintainabilityIndex)}
      <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--vscode-descriptionForeground,#555);margin-top:2px"><span>0 Critical</span><span>50 Fair</span><span>100 Excellent</span></div>
    </div>
    <div class="rc-row">
      <div class="rc-key">Parse Engine</div>
      <div class="rc-val" style="display:flex;align-items:center;gap:6px">
        ${plan.parseEngine === 'typescript-ast' ? `${I.ast}&nbsp;<span style="color:var(--vscode-terminal-ansiGreen,#4ec9b0)">TypeScript Compiler API (full AST accuracy)</span>` : `${I.ast}&nbsp;<span style="color:var(--vscode-descriptionForeground,#888)">Bracket-depth heuristic (non-TS/JS file)</span>`}
      </div>
    </div>
  </div>
</div>`;
        // ══════════════════════════════════════════════════════════════════════
        // Tab 2 — Regions
        // ══════════════════════════════════════════════════════════════════════
        const regionRows = plan.regions.length > 0
            ? plan.regions.map(r => {
                const kc = kindColor(r.kind);
                const extractBgCol = r.shouldExtract
                    ? 'var(--vscode-editorWarning-foreground,#cca700)'
                    : 'var(--vscode-terminal-ansiGreen,#4caf50)';
                const feat = (lbl, col, show) => show
                    ? chip(lbl, col) : '';
                const feats = [
                    feat('JSX', 'var(--vscode-terminal-ansiCyan,#61dafb)', r.hasJSX),
                    feat('Hooks', 'var(--vscode-terminal-ansiMagenta,#c792ea)', r.hasHooks),
                    feat('Async', 'var(--vscode-terminal-ansiYellow,#ffcb6b)', r.hasAsyncOps),
                    feat('State', 'var(--vscode-terminal-ansiBlue,#82aaff)', r.hasStateManagement),
                    feat('Dead Export', 'var(--vscode-editorError-foreground,#f14c4c)', r.isDeadExport),
                ].filter(Boolean).join(' ');
                const smellSev = {
                    'God Component': 'critical',
                    'Oversized Module': 'high',
                    'Deep Nesting (>7)': 'high',
                    'Mixed Concerns (API + Render)': 'high',
                    'Prop Drilling': 'high',
                    'Missing useMemo on mapped JSX': 'medium',
                    'Excessive Inline Styles': 'medium',
                    'Long Switch Statement': 'medium',
                    'Magic Numbers': 'low',
                    'TODO/FIXME Debt': 'low',
                };
                const smellChipColor = (sev) => {
                    if (sev === 'critical')
                        return {
                            bg: 'rgba(30,10,10,0.85)',
                            border: 'rgba(220,80,80,0.55)',
                            text: '#ff8080',
                        };
                    if (sev === 'high')
                        return {
                            bg: 'rgba(30,22,8,0.85)',
                            border: 'rgba(200,150,40,0.55)',
                            text: '#ffb74d',
                        };
                    if (sev === 'medium')
                        return {
                            bg: 'rgba(8,20,36,0.85)',
                            border: 'rgba(55,148,255,0.45)',
                            text: '#64b5f6',
                        };
                    return {
                        bg: 'rgba(18,18,18,0.75)',
                        border: 'rgba(140,140,140,0.35)',
                        text: '#a8a8a8',
                    };
                };
                const smellChips = r.smells.map(s => {
                    const { bg, border, text } = smellChipColor(smellSev[s] ?? 'low');
                    return `<span style="font-size:9px;font-weight:600;padding:2px 7px;border-radius:10px;background:${bg};border:1px solid ${border};color:${text};letter-spacing:0.01em">${esc(s)}</span>`;
                }).join(' ');
                return `
<div class="err-row sev-${r.shouldExtract ? 'warn' : 'info'}" style="border-left-color:${kc}">
  <div class="err-top">
    <span class="err-sev-icon" style="color:${kc}">${kindIcon(r.kind)}</span>
    <span class="err-type">${esc(r.name)}</span>
    <span class="err-source">${r.kind}</span>
    ${confBadge(r.confidence)}
    <span style="margin-left:auto;font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;background:${extractBgCol}18;color:${extractBgCol};border:1px solid ${extractBgCol}33">
      ${r.shouldExtract ? 'Extract' : 'Retain'}
    </span>
  </div>
  <div class="err-loc">
    <span>L${r.startLine}–${r.endLine} (${r.lineCount} ln)</span>
    <span>&nbsp;·&nbsp;</span>
    <span>CC: <b style="color:${r.complexity >= 10 ? 'var(--vscode-editorError-foreground,#f14c4c)' : r.complexity >= 7 ? 'var(--vscode-editorWarning-foreground,#cca700)' : 'inherit'}">${r.complexity}</b></span>
    <span>&nbsp;·&nbsp;</span>
    <span>MI: <b>${r.maintainabilityIndex}</b></span>
    <span>&nbsp;·&nbsp;</span>
    <span>Depth: <b style="color:${r.nestingDepth >= 6 ? 'var(--vscode-editorError-foreground,#f14c4c)' : 'inherit'}">${r.nestingDepth}</b></span>
  </div>
  ${feats ? `<div style="display:flex;flex-wrap:wrap;gap:3px;margin:3px 0">${feats}</div>` : ''}
  ${smellChips ? `<div style="display:flex;flex-wrap:wrap;gap:3px;margin:3px 0">${smellChips}</div>` : ''}
  ${r.extractionReason ? `<div class="err-fix"><b>Why extract:</b> ${esc(r.extractionReason)}</div>` : ''}
</div>`;
            }).join('')
            : `<div class="state-placeholder"><p>No regions detected in this file.</p></div>`;
        // ══════════════════════════════════════════════════════════════════════
        // Tab 3 — Proposed Files
        // ══════════════════════════════════════════════════════════════════════
        const fileCards = plan.proposedFiles.length > 0
            ? plan.proposedFiles.map(pf => {
                const toChips = pf.linkedTo.map(t => chip(t.split('/').pop() ?? t, 'var(--vscode-editorInfo-foreground,#89ddff)')).join(' ');
                const fromChips = pf.linkedFrom.map(f => chip(f.split('/').pop() ?? f, 'var(--vscode-terminal-ansiMagenta,#c792ea)')).join(' ');
                const impsHtml = pf.requiredImports.map(i => `<code style="display:block;font-size:10px;color:var(--vscode-editorInfo-foreground,#9cdcfe);font-family:var(--vscode-editor-font-family,monospace)">${esc(i)}</code>`).join('');
                const propHtml = pf.propInterface
                    ? `<pre class="rc-code" style="margin-top:6px">${esc(pf.propInterface)}</pre>` : '';
                const routeNote = pf.routedToExisting
                    ? `<div class="err-fix" style="color:var(--vscode-terminal-ansiGreen,#4ec9b0)">${I.route}&nbsp;Routed to existing: <b>${esc(pf.routedToExisting)}</b></div>` : '';
                return `
<div class="rc-block">
  <div class="rc-block-title">${I.file}&nbsp;<code style="font-family:var(--vscode-editor-font-family,monospace);color:var(--vscode-terminal-ansiGreen,#4ec9b0)">${esc(pf.fileName)}</code><span style="margin-left:auto;font-size:10px;font-weight:400;color:var(--vscode-descriptionForeground,#888)">~${pf.estimatedLines} lines</span></div>
  <div class="rc-row">
    ${toChips ? `<div style="margin-bottom:4px"><span class="rc-key">Imports from</span><div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:3px">${toChips}</div></div>` : ''}
    ${fromChips ? `<div style="margin-bottom:4px"><span class="rc-key">Used by</span><div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:3px">${fromChips}</div></div>` : ''}
    <div class="rc-key">Test file</div>
    <code style="font-size:10px;color:var(--vscode-terminal-ansiGreen,#c3e88d);font-family:var(--vscode-editor-font-family,monospace)">${I.test}&nbsp;${esc(pf.testFilePath)}</code>
  </div>
  ${impsHtml ? `<div class="rc-row">${impsHtml}</div>` : ''}
  ${propHtml ? `<div class="rc-row">${propHtml}</div>` : ''}
  ${routeNote ? `<div class="rc-row">${routeNote}</div>` : ''}
</div>`;
            }).join('')
            : `<div class="state-placeholder">${I.check}<p>No extractions needed — file is healthy.</p></div>`;
        // ══════════════════════════════════════════════════════════════════════
        // Tab 4 — Linkage
        // ══════════════════════════════════════════════════════════════════════
        const linkRows = plan.linkageMap.length > 0
            ? plan.linkageMap.map(l => {
                const isCirc = l.isCircular;
                return `
<div class="err-row sev-${isCirc ? 'error' : 'info'}">
  <div class="err-top">
    <span class="err-type"><code style="font-family:var(--vscode-editor-font-family,monospace)">${esc(l.from.split('/').pop() ?? l.from)}</code></span>
    <span style="color:var(--vscode-descriptionForeground,#555)">→</span>
    <span class="err-type"><code style="font-family:var(--vscode-editor-font-family,monospace)">${esc(l.to.split('/').pop() ?? l.to)}</code></span>
    ${isCirc ? `<span class="s-badge err" style="margin-left:auto">${I.warn}&nbsp;CIRCULAR</span>` : ''}
  </div>
  <div class="err-loc">imports: <b>${esc(l.symbols.join(', '))}</b></div>
</div>`;
            }).join('')
            : `<div class="state-placeholder"><p>No inter-file dependencies between proposed files.</p></div>`;
        const typeRoutingCards = plan.typeRouting.length > 0
            ? plan.typeRouting.map(tr => `
<div class="rc-block">
  <div class="rc-block-title">${I.route}&nbsp;Type Routing</div>
  <div class="rc-row">
    <div class="rc-key">Types</div>
    <div class="rc-val">${tr.typeNames.map(n => chip(n, 'var(--vscode-editorInfo-foreground,#89ddff)')).join(' ')}</div>
  </div>
  <div class="rc-row">
    <div class="rc-key">Target file</div>
    <div class="rc-val"><code style="font-family:var(--vscode-editor-font-family,monospace);color:var(--vscode-terminal-ansiGreen,#4ec9b0)">${esc(tr.targetFile)}</code></div>
  </div>
  <div class="rc-row">
    <div class="rc-key">Reason</div>
    <div class="rc-val">${esc(tr.reason)}</div>
  </div>
</div>`).join('') : '';
        const circWarn = plan.circularRisks.length > 0
            ? `<div class="rc-block" style="border-left:3px solid var(--vscode-editorError-foreground,#f14c4c)">
                 <div class="rc-block-title" style="color:var(--vscode-editorError-foreground,#f14c4c)">${I.warn}&nbsp;Circular Import Risk</div>
                 <div class="rc-row"><div class="rc-val">${esc(plan.circularRisks.join(', '))} — resolve before refactoring.</div></div>
               </div>` : '';
        const tabLinkage = `
<div class="panel-inner">
  ${sectionLabel(I.link, 'File Dependency Graph', plan.linkageMap.length)}
  <div style="padding:0 12px 4px">
    <div class="rc-block"><div class="rc-block-title">${I.file}&nbsp;<code style="font-family:var(--vscode-editor-font-family,monospace)">${esc(plan.sourceFile.split('/').pop() ?? '')}</code><span style="margin-left:auto;font-size:10px;color:var(--vscode-descriptionForeground,#666)">(source)</span></div></div>
  </div>
  ${linkRows}
  ${circWarn ? `<div style="padding:0 12px 8px">${circWarn}</div>` : ''}
  ${plan.typeRouting.length > 0 ? `${sectionLabel(I.route, 'Type / Interface Routing', plan.typeRouting.length)}<div style="padding:0 12px 8px">${typeRoutingCards}</div>` : ''}
</div>`;
        // ══════════════════════════════════════════════════════════════════════
        // Tab 5 — Smells
        // ══════════════════════════════════════════════════════════════════════
        const smellCards = plan.codeSmells.length > 0
            ? plan.codeSmells
                .sort((a, b) => ['critical', 'high', 'medium', 'low'].indexOf(a.severity) - ['critical', 'high', 'medium', 'low'].indexOf(b.severity))
                .map(s => {
                const sc = sevColor(s.severity);
                return `
<div class="rc-block" style="border-left:3px solid ${sc}">
  <div class="rc-block-title" style="gap:8px">
    <span style="color:${sc}">${I.warn}</span>
    <span>${esc(s.name)}</span>
    <span class="s-badge ${s.severity === 'critical' ? 'err' : s.severity === 'high' ? 'warn' : 'ok'}" style="margin-left:auto">${s.severity.toUpperCase()}</span>
  </div>
  <div class="rc-row">
    <div class="rc-key">Recommendation</div>
    <div class="err-fix">${I.check}&nbsp;${esc(s.recommendation)}</div>
  </div>
</div>`;
            }).join('')
            : `<div class="state-placeholder">${I.check}<p style="color:var(--vscode-terminal-ansiGreen,#4caf50)">No code smells detected.</p></div>`;
        // ══════════════════════════════════════════════════════════════════════
        // Tab 6 — Tests + Barrel
        // ══════════════════════════════════════════════════════════════════════
        const testCards = plan.testFileSuggestions.length > 0
            ? plan.testFileSuggestions.map(ts => `
<div class="rc-block">
  <div class="rc-block-title">${I.test}&nbsp;<code style="font-family:var(--vscode-editor-font-family,monospace);color:var(--vscode-terminal-ansiGreen,#c3e88d)">${esc(ts.testFile)}</code></div>
  <div class="rc-row" style="font-family:var(--vscode-editor-font-family,monospace);font-size:11px;line-height:1.8">
    ${ts.suggestedTests.map(t => `<div style="color:var(--vscode-descriptionForeground,#888)"><span style="color:var(--vscode-terminal-ansiMagenta,#c792ea)">it</span>(<span style="color:var(--vscode-terminal-ansiYellow,#ce9178)">'${esc(t)}'</span>)</div>`).join('')}
  </div>
</div>`).join('')
            : `<div class="state-placeholder"><p>No extractions — no test suggestions.</p></div>`;
        const barrelBlock = `
<div class="rc-block">
  <div class="rc-block-title">${I.barrel}&nbsp;Barrel Export — index.ts</div>
  <div class="rc-row"><pre class="rc-code" style="color:var(--vscode-editorInfo-foreground,#9cdcfe)">${esc(plan.barrelExport)}</pre></div>
</div>`;
        // ══════════════════════════════════════════════════════════════════════
        // Tab 7 — Dry Run
        // ══════════════════════════════════════════════════════════════════════
        const dryRunLines = plan.summary.dryRunPreview.map(l => {
            const col = l.includes('[CREATE]') ? 'var(--vscode-terminal-ansiGreen,#4ec9b0)' :
                l.includes('[MODIFY]') ? 'var(--vscode-editorWarning-foreground,#cca700)' :
                    l.includes('[ROUTE]') ? 'var(--vscode-editorInfo-foreground,#89ddff)' :
                        'var(--vscode-foreground,#d4d4d4)';
            return `<div style="line-height:1.75;color:${col};font-family:var(--vscode-editor-font-family,monospace);font-size:11px">${esc(l) || '\u00a0'}</div>`;
        }).join('');
        const tabDryRun = `
<div class="panel-inner">
  ${sectionLabel(I.check, 'Dry Run Preview')}
  <div style="padding:0 12px 8px">
    <div class="rc-block"><div class="rc-row">${dryRunLines}</div></div>
  </div>
</div>`;
        // ══════════════════════════════════════════════════════════════════════
        // Tab definitions and CSS-only radio tab system
        // ══════════════════════════════════════════════════════════════════════
        const tabs = [
            { id: 'overview', label: 'Overview', icon: I.metric, count: undefined },
            { id: 'regions', label: 'Regions', icon: I.comp, count: plan.regions.length },
            { id: 'files', label: 'Files', icon: I.file, count: plan.proposedFiles.length },
            { id: 'linkage', label: 'Linkage', icon: I.link, count: plan.linkageMap.length },
            { id: 'smells', label: 'Smells', icon: I.warn, count: plan.codeSmells.length },
            { id: 'tests', label: 'Tests', icon: I.test, count: plan.testFileSuggestions.length },
            { id: 'dryrun', label: 'Dry Run', icon: I.check, count: undefined },
        ];
        const tabContents = {
            overview: tabOverview,
            regions: regionRows.startsWith('<div class="state') ? regionRows : `<div class="panel-inner">${regionRows}</div>`,
            files: fileCards.startsWith('<div class="state') ? fileCards : `<div class="panel-inner" style="padding-top:4px">${fileCards}</div>`,
            linkage: tabLinkage,
            smells: smellCards.startsWith('<div class="state') ? smellCards : `<div class="panel-inner">${smellCards}</div>`,
            tests: `<div class="panel-inner">${testCards}<div style="margin-top:8px">${barrelBlock}</div></div>`,
            dryrun: tabDryRun,
        };
        const radioInputs = tabs.map((t, i) => `<input type="radio" name="tabs" id="tab-${t.id}" class="tab-radio"${i === 0 ? ' checked' : ''}>`).join('');
        const tabLabels = tabs.map(t => `<label for="tab-${t.id}" class="tab">
               ${t.icon}
               <span>${t.label}${t.count !== undefined ? ` <span style="font-size:9px;padding:0 4px;background:var(--vscode-badge-background,rgba(127,127,127,0.18));border-radius:8px">${t.count}</span>` : ''}</span>
             </label>`).join('');
        const panels = tabs.map(t => `<div id="panel-${t.id}" class="panel">${tabContents[t.id]}</div>`).join('');
        const dynCSS = tabs.map(t => `#tab-${t.id}:checked~.tabs label[for="tab-${t.id}"]{color:var(--vscode-tab-activeForeground,#fff);border-bottom-color:var(--vscode-focusBorder,#007acc)} #tab-${t.id}:checked~.tabs label[for="tab-${t.id}"] svg{opacity:1} #tab-${t.id}:checked~.panels #panel-${t.id}{display:flex}`).join('\n');
        // ══════════════════════════════════════════════════════════════════════
        // Final HTML — inherits ALL CSS variables from dashboard.html
        // ══════════════════════════════════════════════════════════════════════
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>Module Splitter — ${shortName}</title>
<style>
/* ── Reset / Base (mirrors dashboard.html) ── */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family,'Segoe UI',system-ui,sans-serif);font-size:var(--vscode-font-size,13px);background:var(--vscode-sideBar-background,#1e1e1e);color:var(--vscode-sideBar-foreground,var(--vscode-foreground,#cccccc));line-height:1.4;overflow-x:hidden;height:100vh;display:flex;flex-direction:column}
a{color:var(--vscode-textLink-foreground,#3794ff);text-decoration:none}a:hover{text-decoration:underline}
pre,code{font-family:var(--vscode-editor-font-family,'Consolas','Courier New',monospace);font-size:calc(var(--vscode-font-size,13px) - 1px)}
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background,rgba(100,100,100,.4));border-radius:3px}::-webkit-scrollbar-thumb:hover{background:var(--vscode-scrollbarSlider-hoverBackground,rgba(100,100,100,.7))}

/* ── Top accent bar ── */
.accent-bar{height:2px;flex-shrink:0;background:linear-gradient(90deg,var(--vscode-focusBorder,#007acc) 0%,var(--vscode-terminal-ansiCyan,#29b8db) 60%,transparent 100%);opacity:.75}

/* ── Header ── */
.header{display:flex;align-items:center;justify-content:space-between;padding:0 10px 0 12px;height:38px;flex-shrink:0;background:var(--vscode-sideBarSectionHeader-background,rgba(127,127,127,.04));border-bottom:1px solid var(--vscode-panel-border,rgba(127,127,127,.18));position:sticky;top:0;z-index:20}
.header-left{display:flex;align-items:center;gap:7px;overflow:hidden}
.header-icon{color:var(--vscode-focusBorder,#007acc);flex-shrink:0;display:flex;align-items:center}
.header-title{font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--vscode-sideBarTitle-foreground,var(--vscode-foreground,#d0d0d0));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.header-right{display:flex;align-items:center;gap:4px;flex-shrink:0;flex-wrap:wrap}

/* ── Summary strip ── */
.summary-strip{display:flex;align-items:center;gap:5px;padding:5px 12px;background:var(--vscode-sideBarSectionHeader-background,rgba(127,127,127,.03));border-bottom:1px solid var(--vscode-panel-border,rgba(127,127,127,.1));flex-shrink:0;flex-wrap:wrap}
.s-badge{display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:600;padding:2px 7px;border-radius:10px;border:1px solid transparent}
.s-badge.err {background:rgba(241,76,76,.12);color:var(--vscode-editorError-foreground,#f88070);border-color:rgba(241,76,76,.2)}
.s-badge.warn{background:rgba(204,167,0,.12);color:var(--vscode-editorWarning-foreground,#cca700);border-color:rgba(204,167,0,.2)}
.s-badge.ok  {background:rgba(76,175,80,.1);color:var(--vscode-terminal-ansiGreen,#4caf50);border-color:rgba(76,175,80,.2)}

/* ── CSS-only radio tabs ── */
.tab-radio{display:none}
.tabs{display:flex;background:var(--vscode-sideBar-background,#1e1e1e);border-bottom:1px solid var(--vscode-panel-border,rgba(127,127,127,.18));flex-shrink:0;padding:0 4px;gap:1px;overflow-x:auto}
.tab{flex:1;display:flex;align-items:center;justify-content:center;gap:4px;padding:8px 4px 7px;font-size:11px;font-weight:500;color:var(--vscode-tab-inactiveForeground,#888);background:transparent;border:none;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap;min-width:0;letter-spacing:.01em}
.tab svg{flex-shrink:0;opacity:.7}.tab span{overflow:hidden;text-overflow:ellipsis}
.tab:hover{color:var(--vscode-foreground,#ccc)}.tab:hover svg{opacity:.9}
${dynCSS}

/* ── Panels ── */
.panels{flex:1;overflow:hidden;position:relative}
.panel{display:none;flex-direction:column;height:100%;overflow-y:auto}
.panel-inner{display:flex;flex-direction:column;gap:0;padding:4px 0 8px}

/* ── Section label ── */
.section-label{font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--vscode-descriptionForeground,#777);padding:10px 12px 5px;display:flex;align-items:center;gap:7px}
.section-label::after{content:'';flex:1;height:1px;background:var(--vscode-panel-border,rgba(127,127,127,.1));border-radius:1px}

/* ── Error row (reused for regions/linkage) ── */
.err-row{display:flex;flex-direction:column;padding:8px 12px 8px 14px;cursor:default;border-left:2px solid transparent;border-bottom:1px solid var(--vscode-panel-border,rgba(127,127,127,.07));transition:background .1s;position:relative}
.err-row:last-child{border-bottom:none}
.err-row:hover{background:var(--vscode-list-hoverBackground,rgba(255,255,255,.04))}
.err-row.sev-error{border-left-color:var(--vscode-editorError-foreground,#f14c4c)}
.err-row.sev-warn {border-left-color:var(--vscode-editorWarning-foreground,#cca700)}
.err-row.sev-info {border-left-color:var(--vscode-editorInfo-foreground,#3794ff)}
.err-top{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;min-width:0}
.err-sev-icon{flex-shrink:0;display:flex;align-items:center;margin-top:1px}
.err-type{font-size:11px;font-weight:600;color:var(--vscode-foreground,#d4d4d4);flex-shrink:0}
.err-source{font-size:10px;padding:0 6px;border-radius:10px;background:var(--vscode-badge-background,rgba(127,127,127,.2));color:var(--vscode-badge-foreground,#aaa);flex-shrink:0;font-weight:500}
.err-loc{display:flex;align-items:center;flex-wrap:wrap;gap:3px;font-size:10px;color:var(--vscode-descriptionForeground,#777);margin:3px 0 2px}
.err-fix{font-size:11px;color:var(--vscode-terminal-ansiGreen,#4ec9b0);background:rgba(78,201,176,.06);border:1px solid rgba(78,201,176,.2);border-left:2px solid var(--vscode-terminal-ansiGreen,#4ec9b0);border-radius:3px;padding:5px 8px;margin:5px 0 3px;line-height:1.45}

/* ── Root Cause blocks ── */
.rc-block{margin:0 12px 8px;background:var(--vscode-sideBar-background,#1e1e1e);border:1px solid var(--vscode-panel-border,rgba(127,127,127,.18));border-radius:6px;overflow:hidden}
.rc-block-title{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:700;letter-spacing:.03em;color:var(--vscode-foreground,#d4d4d4);background:var(--vscode-sideBarSectionHeader-background,rgba(127,127,127,.05));border-bottom:1px solid var(--vscode-panel-border,rgba(127,127,127,.18));padding:9px 12px}
.rc-row{padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border,rgba(127,127,127,.08));font-size:11px}
.rc-row:last-child{border-bottom:none}
.rc-key{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground,#777);margin-bottom:4px}
.rc-val{color:var(--vscode-foreground,#ccc);line-height:1.4}
.rc-code{font-family:var(--vscode-editor-font-family,'Consolas','Courier New',monospace);font-size:10px;background:var(--vscode-textCodeBlock-background,rgba(127,127,127,.08));color:var(--vscode-editor-foreground,#d4d4d4);border:1px solid var(--vscode-panel-border,rgba(127,127,127,.15));padding:8px 10px;border-radius:4px;overflow:auto;line-height:1.55;white-space:pre}

/* ── State placeholder ── */
.state-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:44px 20px;color:var(--vscode-descriptionForeground,#6e6e6e);text-align:center}
.state-placeholder svg{opacity:.35}
.state-placeholder p{font-size:12px;font-weight:500;line-height:1.5;color:var(--vscode-foreground,#ccc);opacity:.7}
</style>
</head>
<body>
${radioInputs}
<div class="accent-bar"></div>
<div class="header">
  <div class="header-left">
    <span class="header-icon">${I.split}</span>
    <span class="header-title">${shortName}</span>
    <span class="err-source">${plan.language}</span>
  </div>
  <div class="header-right">
    <span class="s-badge ${m.overallHealth === 'excellent' || m.overallHealth === 'good' ? 'ok' : m.overallHealth === 'fair' ? 'warn' : 'err'}">${m.overallHealth.toUpperCase()}</span>
    <span class="s-badge ${m.avgCyclomaticComplexity > 10 ? 'err' : m.avgCyclomaticComplexity > 7 ? 'warn' : 'ok'}">CC ${m.avgCyclomaticComplexity}</span>
    ${plan.circularRisks.length > 0 ? `<span class="s-badge err">${I.warn}&nbsp;Circular</span>` : ''}
    ${astBadge}
  </div>
</div>
<div class="summary-strip">
  <span class="s-badge ok">${I.metric}&nbsp;MI ${m.maintainabilityIndex}/100</span>
  <span class="s-badge ${plan.summary.extractionCount > 0 ? 'warn' : 'ok'}">${I.split}&nbsp;${plan.summary.extractionCount} extract</span>
  <span class="s-badge ok">${I.check}&nbsp;${plan.summary.retainedCount} retain</span>
  ${plan.codeSmells.length > 0 ? `<span class="s-badge ${plan.codeSmells.some(s => s.severity === 'critical') ? 'err' : 'warn'}">${I.warn}&nbsp;${plan.codeSmells.length} smell${plan.codeSmells.length !== 1 ? 's' : ''}</span>` : ''}
</div>
<div class="tabs">${tabLabels}</div>
<div class="panels">${panels}</div>
</body>
</html>`;
    }
}
exports.ModuleSplitter = ModuleSplitter;
exports.moduleSplitter = new ModuleSplitter();
//# sourceMappingURL=moduleSplitter.js.map