"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.performanceAnalyzer = exports.PerformanceAnalyzer = void 0;
const PERF_PATTERNS = [
    {
        pattern: /useEffect\s*\(\s*(?:async\s*)?\(\s*\)\s*=>/,
        name: 'useEffect with no dependency array',
        severity: 'high',
        description: 'useEffect without a dependency array runs on every render, causing unnecessary re-execution.',
        fix: 'Add a dependency array as the second argument to useEffect.',
        example: 'useEffect(() => {\n  fetchData();\n}, []); // ← empty array = run once',
        category: 'rendering'
    },
    {
        pattern: /\.forEach\(.*=>\s*\{[\s\S]{0,200}\.push\(/,
        name: 'forEach with push (use map instead)',
        severity: 'medium',
        description: 'Using .forEach() to push into an array is less efficient and idiomatic than .map().',
        fix: 'Replace forEach+push with .map() for transformations.',
        example: 'const result = items.map(item => transform(item));',
        category: 'algorithm'
    },
    {
        pattern: /new\s+Array\s*\(\s*\d{4,}\s*\)\.fill/,
        name: 'Large array pre-allocation',
        severity: 'medium',
        description: 'Pre-allocating very large arrays blocks the main thread during creation.',
        fix: 'Use lazy generation or limit array size. Consider streaming or pagination.',
        example: '// Lazy: yield items instead of pre-allocating\nfunction* generateItems(n) { for (let i=0;i<n;i++) yield i; }',
        category: 'memory'
    },
    {
        pattern: /setInterval\s*\([\s\S]{0,100}(\d+)\s*\)/,
        name: 'setInterval usage',
        severity: 'low',
        description: 'setInterval can accumulate if not cleared, causing memory leaks and unexpected behaviour.',
        fix: 'Always store the interval ID and clear it in useEffect cleanup or componentWillUnmount.',
        example: 'const id = setInterval(fn, 1000);\nreturn () => clearInterval(id); // cleanup',
        category: 'memory'
    },
    {
        pattern: /addEventListener\s*\([^)]+\)(?![\s\S]{0,500}removeEventListener)/,
        name: 'Event listener without cleanup',
        severity: 'high',
        description: 'Adding event listeners without removing them causes memory leaks, especially in React components.',
        fix: 'Return a cleanup function from useEffect that calls removeEventListener.',
        example: 'useEffect(() => {\n  window.addEventListener("resize", handler);\n  return () => window.removeEventListener("resize", handler);\n}, []);',
        category: 'memory'
    },
    {
        pattern: /JSON\.parse\s*\(\s*JSON\.stringify/,
        name: 'JSON deep clone (slow)',
        severity: 'medium',
        description: 'JSON.parse(JSON.stringify(obj)) is a slow deep clone that fails on non-serializable values (Date, undefined, functions).',
        fix: 'Use structuredClone() (Node 17+) or a library like lodash.cloneDeep.',
        example: '// Modern:\nconst clone = structuredClone(obj);\n// Or: import { cloneDeep } from "lodash";',
        category: 'algorithm'
    },
    {
        pattern: /await\s+Promise\.all\s*\(\s*\[[\s\S]{0,50}\.map\(/,
        name: 'Promise.all with unbounded map',
        severity: 'medium',
        description: 'Firing unlimited concurrent Promises can overwhelm APIs and exhaust memory.',
        fix: 'Use a concurrency limiter (p-limit) or process in batches.',
        example: 'import pLimit from "p-limit";\nconst limit = pLimit(5);\nawait Promise.all(items.map(i => limit(() => fetch(i))));',
        category: 'async'
    },
    {
        pattern: /document\.querySelector|document\.getElementById/,
        name: 'Direct DOM manipulation',
        severity: 'low',
        description: 'Direct DOM queries in React/framework components bypass the virtual DOM and can cause inconsistencies.',
        fix: 'Use useRef() hook to access DOM elements safely within React.',
        example: 'const ref = useRef(null);\n// Access: ref.current',
        category: 'rendering'
    },
    {
        pattern: /require\s*\(\s*['"][^'"]+['"]\s*\)\s*(?![\s\S]{0,20}\.(default|[a-z]+))/,
        name: 'Full module require (prefer named imports)',
        severity: 'low',
        description: 'Requiring full modules prevents tree-shaking and increases bundle size.',
        fix: 'Use named ES imports so bundlers can eliminate unused code.',
        example: "import { debounce } from 'lodash-es'; // tree-shakeable",
        category: 'bundle'
    },
    {
        pattern: /while\s*\(true\)|for\s*\(\s*;;\s*\)/,
        name: 'Infinite loop risk',
        severity: 'critical',
        description: 'An unconditional infinite loop will permanently block the event loop / UI thread.',
        fix: 'Ensure every infinite loop has a proper break condition or use recursive setTimeout.',
        example: '// Safe iteration with break:\nwhile (condition) {\n  if (done) break;\n}',
        category: 'algorithm'
    }
];
class PerformanceAnalyzer {
    analyze(content) {
        const issues = [];
        const lines = content.split('\n');
        for (const pattern of PERF_PATTERNS) {
            // Test whole file first for quick rejection
            if (!pattern.pattern.test(content)) {
                continue;
            }
            // Find exact line
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const match = line.match(pattern.pattern);
                if (match) {
                    issues.push({
                        name: pattern.name,
                        severity: pattern.severity,
                        description: pattern.description,
                        line: i + 1,
                        column: match.index ?? 0,
                        fix: pattern.fix,
                        codeExample: pattern.example,
                        category: pattern.category
                    });
                    break; // one finding per pattern per file
                }
            }
        }
        return issues.sort((a, b) => {
            const order = { critical: 0, high: 1, medium: 2, low: 3 };
            return order[a.severity] - order[b.severity];
        });
    }
    analyzeComplexity(content) {
        // Approximate cyclomatic complexity by counting branch points
        const branchPatterns = [
            /\bif\s*\(/g, /\belse\s+if\s*\(/g, /\bfor\s*\(/g,
            /\bwhile\s*\(/g, /\bcase\s+/g, /\?\s*[^:]/g, /&&|\|\|/g, /\bcatch\s*\(/g
        ];
        let count = 1;
        for (const p of branchPatterns) {
            count += (content.match(p) ?? []).length;
        }
        const rating = count > 30 ? 'Very High' : count > 20 ? 'High' : count > 10 ? 'Moderate' : 'Low';
        const recommendation = count > 20
            ? 'Consider splitting this file into smaller modules with single responsibilities.'
            : count > 10
                ? 'Some functions may benefit from extraction or simplification.'
                : 'Complexity is within acceptable range.';
        return { cyclomaticComplexity: count, rating, recommendation };
    }
}
exports.PerformanceAnalyzer = PerformanceAnalyzer;
exports.performanceAnalyzer = new PerformanceAnalyzer();
//# sourceMappingURL=performanceAnalyzer.js.map