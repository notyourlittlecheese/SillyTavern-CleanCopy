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

export function normalizeTags(tags) {
    return [...new Set(tags.map(tag => String(tag).trim().toLowerCase()).filter(tag => /^[a-z][a-z0-9-]*$/.test(tag)))];
}

// Scan tag boundaries before HTML parsing: custom tag names must survive the
// browser sanitizer, and tags inside comments/code must never become sections.
export function findTagSections(source, tags) {
    const wanted = new Set(normalizeTags(tags));
    const text = String(source ?? '')
        .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
        .replace(/(^|\n) {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\2[ \t]*(?=\n|$|<)|$)/g, '\n')
        .replace(/(`+)[\s\S]*?\1/g, '')
        .replace(/<(script|style|pre|code)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
    const token = /<\/?([a-z][a-z0-9-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
    const stack = [];
    const sections = [];
    for (const match of text.matchAll(token)) {
        const tag = match[1].toLowerCase();
        if (!wanted.has(tag)) continue;
        if (match[0].startsWith('</')) {
            const index = stack.map(item => item.tag).lastIndexOf(tag);
            if (index === -1) continue;
            const [opened] = stack.splice(index);
            if (!stack.length) sections.push({ tag: opened.tag, html: text.slice(opened.start, match.index), offset: opened.start });
        } else if (!/\/\s*>$/.test(match[0])) {
            stack.push({ tag, start: match.index + match[0].length });
        }
    }
    // Streaming/incomplete messages may have no closing tag yet.
    if (stack.length) sections.push({ tag: stack[0].tag, html: text.slice(stack[0].start), offset: stack[0].start });
    return sections.sort((a, b) => a.offset - b.offset);
}

// Inert conversion for explicitly requested hidden sections. Never attach the
// generated HTML to the live document or execute scripts/style from a message.
export function sectionToText(source, makeHtml, doc, rules = DEFAULT_RULES) {
    const template = doc.createElement('template');
    template.innerHTML = makeHtml(source);
    const removed = new Set(normalizeRules(rules).filter(r => r.enabled && r.mode === 'remove').map(r => r.tag));
    const blocks = new Set([...PARAGRAPHS, 'DIV', 'LI', 'UL', 'OL', 'DETAILS', 'SUMMARY', 'TR']);
    function read(node) {
        if (node.nodeType === 3) return node.data;
        if (node.nodeType === 8) return '';
        if (node.nodeType === 1) {
            if (OMIT.has(node.tagName) || removed.has(node.localName)) return '';
            if (node.tagName === 'BR') return '\n';
        }
        const value = [...node.childNodes].map(read).join('');
        if (blocks.has(node.tagName)) return `\n${value.trim()}\n`;
        if (node.tagName === 'TD' || node.tagName === 'TH') return `${value}\t`;
        return value;
    }
    return cleanText(read(template.content), rules);
}

export function composeCopy(root, raw, selectedTags, rules, makeHtml) {
    const tags = normalizeTags(selectedTags);
    if (!tags.length) return { text: extractVisibleText(root, rules), missing: [] };
    const selected = new Set(tags);
    // Keep sections out of the body even if their short-click rule is disabled.
    const bodyRules = normalizeRules(rules).filter(rule => !selected.has(rule.tag));
    bodyRules.push(...tags.map(tag => ({ tag, enabled: true, mode: 'remove' })));
    const body = extractVisibleText(root, bodyRules);
    const sectionRules = normalizeRules(rules).filter(rule => !selected.has(rule.tag));
    sectionRules.push(...tags.map(tag => ({ tag, enabled: true, mode: 'text' })));
    const presentInRaw = new Set(tags.filter(tag => findTagSections(raw, [tag]).length));
    const sections = findTagSections(raw, tags);
    const fallbackTags = tags.filter(tag => !presentInRaw.has(tag));
    if (fallbackTags.length) {
        // Some display regexes create <details> wrappers absent from the source.
        // Read a detached serialization without opening/altering the live fold.
        root.querySelectorAll(fallbackTags.join(',')).forEach(node => {
            if (node.parentElement?.closest(tags.join(',')) && root.contains(node.parentElement.closest(tags.join(',')))) return;
            const value = node.innerHTML;
            const nestedSource = findTagSections(value, [...presentInRaw]);
            if (nestedSource.length) return; // Source-backed nested tags are already included.
            const withoutTitle = node.cloneNode(true);
            withoutTitle.querySelectorAll('summary').forEach(summary => summary.remove());
            sections.push({ tag: node.localName, html: value, dedupHtml: withoutTitle.innerHTML });
        });
    }
    const rendered = sections.map(section => ({
        tag: section.tag,
        text: sectionToText(section.html, makeHtml, root.ownerDocument, sectionRules),
        dedupText: section.dedupHtml === undefined ? undefined : sectionToText(section.dedupHtml, makeHtml, root.ownerDocument, sectionRules),
    }));
    const unique = [];
    const seen = new Set(body ? [body.replace(/\s+/g, '')] : []);
    const sourceSignature = rendered.filter(item => item.dedupText === undefined).map(item => item.text.replace(/\s+/g, '')).join('');
    for (const item of rendered) {
        const signature = item.text.replace(/\s+/g, '');
        const contentSignature = item.dedupText?.replace(/\s+/g, '');
        if (contentSignature && (seen.has(contentSignature) || contentSignature === sourceSignature)) continue;
        if (!signature || seen.has(signature)) continue;
        seen.add(signature);
        unique.push(item.text);
    }
    const missing = tags.filter(tag => !presentInRaw.has(tag) && !sections.some(section => section.tag === tag));
    return { text: [body, ...unique].filter(Boolean).join('\n\n'), missing };
}
