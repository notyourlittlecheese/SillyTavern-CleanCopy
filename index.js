import { DEFAULT_RULES, normalizeRules, extractVisibleText } from './core.js';

const KEY = 'cleancopy';
const BUTTON = 'mes_cleancopy';
const context = () => SillyTavern.getContext();

function settings() {
    const store = context().extensionSettings;
    store[KEY] ??= { rules: structuredClone(DEFAULT_RULES) };
    store[KEY].rules = normalizeRules(store[KEY].rules);
    return store[KEY];
}

export async function writeClipboard(text) {
    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch { /* HTTP/mobile browsers may need the selection fallback. */ }
    }
    const focused = document.activeElement;
    const selection = window.getSelection();
    const ranges = Array.from({ length: selection?.rangeCount ?? 0 }, (_, i) => selection.getRangeAt(i).cloneRange());
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    (document.querySelector('dialog[open]') ?? document.body).append(area);
    try {
        area.focus({ preventScroll: true });
        area.select();
        if (!document.execCommand('copy')) throw new Error('浏览器拒绝了剪贴板写入');
    } finally {
        area.remove();
        focused?.focus({ preventScroll: true });
        selection?.removeAllRanges();
        ranges.forEach(range => selection?.addRange(range));
    }
}

async function copyMessage(event) {
    event.preventDefault();
    event.stopPropagation();
    const button = event.currentTarget;
    if (button.dataset.busy) return;
    button.dataset.busy = 'true';
    try {
        const message = button.closest('.mes');
        const root = message?.querySelector('.mes_text');
        if (!root || root.querySelector('textarea')) throw new Error('请先完成消息编辑，再复制正文');
        const text = extractVisibleText(root, settings().rules);
        if (!text) {
            toastr.info('这一楼没有可复制的净文');
            return;
        }
        await writeClipboard(text);
        toastr.success('净文已复制', '', { timeOut: 1500 });
    } catch (error) {
        console.error('[CleanCopy]', error);
        toastr.error(error.message || '复制失败，请检查浏览器剪贴板权限');
    } finally {
        delete button.dataset.busy;
    }
}

export function installButtons(scope = document) {
    scope.querySelectorAll('#chat .mes .mes_buttons').forEach(toolbar => {
        if (toolbar.querySelector(`.${BUTTON}`)) return;
        const button = document.createElement('div');
        button.className = `mes_button ${BUTTON} fa-solid fa-broom`;
        button.title = '净文复制';
        button.setAttribute('aria-label', '净文复制');
        button.setAttribute('role', 'button');
        button.tabIndex = 0;
        button.addEventListener('click', copyMessage);
        button.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                button.click();
            }
        });
        // Same row and native class as Edit; stays available when extra buttons collapse.
        const edit = toolbar.querySelector(':scope > .mes_edit');
        toolbar.insertBefore(button, edit ?? null);
    });
}

function mountSettings() {
    const host = document.querySelector('#extensions_settings');
    if (!host || document.querySelector('#cleancopy_settings')) return;
    const panel = document.createElement('div');
    panel.id = 'cleancopy_settings';
    panel.className = 'extension_container';
    panel.innerHTML = `<div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header"><b>净文复制 · CleanCopy</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
        <div class="inline-drawer-content">
            <p>点击消息编辑旁的扫帚，复制当前显示的正文。自动排除代码块、行内代码、HTML 注释和不可见内容。</p>
            <p>标签规则只影响复制。取消勾选即停用该规则；输出始终是纯文本。</p>
            <div class="cleancopy_rules"></div>
            <div class="cleancopy_add"><input class="text_pole" placeholder="自定义标签，如 status" aria-label="自定义标签名"><button type="button" class="menu_button">添加</button></div>
            <small>content 默认保留正文；thinking、details 默认整段排除。关闭 details 排除后，展开时复制内容，折叠时只复制标题。</small>
        </div></div>`;
    host.append(panel);
    const list = panel.querySelector('.cleancopy_rules');
    const save = () => context().saveSettingsDebounced();
    function render() {
        list.replaceChildren();
        settings().rules.forEach((rule, index) => {
            const row = document.createElement('div');
            row.className = 'cleancopy_rule';
            const label = document.createElement('label');
            label.className = 'checkbox_label';
            const enabled = document.createElement('input');
            enabled.type = 'checkbox';
            enabled.checked = rule.enabled;
            label.append(enabled, document.createTextNode(rule.tag));
            const mode = document.createElement('select');
            mode.className = 'text_pole';
            mode.setAttribute('aria-label', `${rule.tag} 处理方式`);
            mode.add(new Option('去标签，保留文字', 'text'));
            mode.add(new Option('标签和内容整段排除', 'remove'));
            mode.value = rule.mode;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'menu_button fa-solid fa-trash-can';
            remove.title = `删除 ${rule.tag} 规则`;
            remove.setAttribute('aria-label', remove.title);
            enabled.addEventListener('change', () => { settings().rules[index].enabled = enabled.checked; save(); });
            mode.addEventListener('change', () => { settings().rules[index].mode = mode.value; save(); });
            remove.addEventListener('click', () => { settings().rules.splice(index, 1); save(); render(); });
            row.append(label, mode, remove);
            list.append(row);
        });
    }
    const input = panel.querySelector('.cleancopy_add input');
    const add = () => {
        const tag = input.value.trim().toLowerCase().replace(/^<\s*|\s*>$/g, '');
        if (!/^[a-z][a-z0-9-]*$/.test(tag)) return toastr.warning('请输入标签名，例如 status，不要填写属性或选择器');
        if (settings().rules.some(rule => rule.tag === tag)) return toastr.info('这个标签已在列表中');
        settings().rules.push({ tag, mode: 'remove', enabled: true });
        save();
        input.value = '';
        render();
    };
    panel.querySelector('.cleancopy_add button').addEventListener('click', add);
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); add(); } });
    render();
}

function initialize() {
    settings();
    mountSettings();
    installButtons();
    // Observe insertions only, never each text token. Recheck on the next frame.
    let pending = false;
    const observer = new MutationObserver(records => {
        if (pending || !records.some(r => [...r.addedNodes].some(n => n.nodeType === 1 &&
            (n.matches('.mes, .mes_buttons, #chat, #extensions_settings') || n.querySelector('.mes_buttons, #extensions_settings'))))) return;
        pending = true;
        requestAnimationFrame(() => { pending = false; mountSettings(); installButtons(); });
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
