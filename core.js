export const DEFAULT_RULES = [
    { tag: 'content', mode: 'text', enabled: true },
    { tag: 'thinking', mode: 'remove', enabled: true },
    { tag: 'details', mode: 'remove', enabled: true },
];

export function normalizeRules(rules) {
    const seen = new Set();
    return (Array.isArray(rules) ? rules : DEFAULT_RULES).flatMap(rule => {
        const tag = String(rule?.tag ?? '').trim().toLowerCase();
        if (!/^[a-z][a-z0-9-]*$/.test(tag) || seen.has(tag)) return [];
        seen.add(tag);
        return [{ tag, mode: rule.mode === 'remove' ? 'remove' : 'text', enabled: rule.enabled !== false }];
    });
}

// Also handle tags/comments that the renderer escaped into visible text.
// This never parses or executes message HTML and never reads the raw chat history.
export function cleanText(text, rules) {
    const active = new Map(normalizeRules(rules).filter(r => r.enabled).map(r => [r.tag, r.mode]));
    const stack = [];
    let output = '';
    let cursor = 0;
    const tokens = /<!--[\s\S]*?(?:-->|$)|<\/?([a-z][a-z0-9-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
    for (const match of text.matchAll(tokens)) {
        if (!stack.length) output += text.slice(cursor, match.index);
        cursor = match.index + match[0].length;
        if (match[0].startsWith('<!--')) continue;
        const tag = match[1].toLowerCase();
        if (!active.has(tag)) {
            if (!stack.length) output += match[0];
            continue;
        }
        if (active.get(tag) !== 'remove') continue;
        if (match[0].startsWith('</')) {
            const index = stack.lastIndexOf(tag);
            if (index !== -1) stack.splice(index);
        } else if (!/\/\s*>$/.test(match[0])) {
            stack.push(tag);
        }
    }
    if (!stack.length) output += text.slice(cursor);
    return output.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const OMIT = new Set(['SCRIPT', 'STYLE', 'PRE', 'CODE', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'CANVAS', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT']);
const PARAGRAPHS = new Set(['P', 'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

export function extractVisibleText(root, rules = DEFAULT_RULES) {
    if (!root) return '';
    const win = root.ownerDocument.defaultView;
    const removed = new Set(normalizeRules(rules).filter(r => r.enabled && r.mode === 'remove').map(r => r.tag));
    function visit(node) {
        if (node.nodeType === 3) {
            const style = win.getComputedStyle(node.parentElement);
            if (style.visibility === 'hidden' || style.visibility === 'collapse') return '';
            return /^(pre|pre-wrap|break-spaces)$/.test(style.whiteSpace) ? node.data :
                style.whiteSpace === 'pre-line' ? node.data.replace(/[\t ]+/g, ' ') : node.data.replace(/\s+/g, ' ');
        }
        if (node.nodeType !== 1) return ''; // Includes HTML comments.
        if (OMIT.has(node.tagName) || removed.has(node.localName) || node.matches('[hidden], .mes_reasoning, .mes_reasoning_details, .code-copy, .code-copy-button')) return '';
        const style = win.getComputedStyle(node);
        if (style.display === 'none' || style.contentVisibility === 'hidden' || Number(style.opacity) === 0) return '';
        if (node.tagName === 'BR') return '\n';
        if (node.tagName === 'DETAILS' && !node.open) {
            const summary = [...node.children].find(child => child.tagName === 'SUMMARY');
            return summary ? visit(summary) : '';
        }
        const text = [...node.childNodes].map(visit).join('');
        if (!text.trim()) return text;
        if (PARAGRAPHS.has(node.tagName)) return `\n\n${text.trim()}\n\n`;
        if (['block', 'list-item', 'flex', 'grid', 'table-row'].includes(style.display)) return `\n${text.trim()}\n`;
        if (style.display === 'table-cell') return `${text}\t`;
        return text;
    }
    return cleanText(visit(root), rules);
}
