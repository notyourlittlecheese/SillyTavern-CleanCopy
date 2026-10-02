import { DEFAULT_RULES, normalizeRules, normalizeTags, composeCopy } from './core.js';

const KEY = 'cleancopy';
const BUTTON = 'mes_cleancopy';
const context = () => SillyTavern.getContext();
let converter;
async function loadConverter() {
    if (!converter) {
        const { showdown } = await import('../../../../lib.js');
        converter = new showdown.Converter({ tables: true, strikethrough: true, simpleLineBreaks: true });
    }
    return text => converter.makeHtml(text);
}

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

async function copyMessage(button, selectedTags = []) {
    if (button.dataset.busy) return;
    button.dataset.busy = 'true';
    try {
        const message = button.closest('.mes');
        const root = message?.querySelector('.mes_text');
        if (!root || root.querySelector('textarea')) throw new Error('请先完成消息编辑，再复制正文');
        if (!message?.isConnected) throw new Error('这一楼已不在当前聊天中，请重新选择');
        let raw = '';
        let makeHtml;
        if (selectedTags.length) {
            const id = message.getAttribute('mesid');
            if (!/^\d+$/.test(id ?? '')) throw new Error('无法识别这一楼，请刷新聊天后重试');
            raw = context().chat?.[Number(id)]?.mes ?? '';
            makeHtml = await loadConverter();
            if (!message.isConnected) throw new Error('聊天已切换，请重新选择消息');
        }
        const { text, missing } = composeCopy(root, raw, selectedTags, settings().rules, makeHtml);
        if (!text) {
            toastr.info('这一楼没有可复制的净文');
            return;
        }
        await writeClipboard(text);
        toastr.success('净文已复制', '', { timeOut: 1500 });
        if (missing.length) toastr.info(`这一楼未找到标签：${missing.join('、')}`);
    } catch (error) {
        console.error('[CleanCopy]', error);
        toastr.error(error.message || '复制失败，请检查浏览器剪贴板权限');
    } finally {
        delete button.dataset.busy;
    }
}

function openCopyMenu(button) {
    if (document.querySelector('#cleancopy_menu')) return;
    // Preload while the user chooses, leaving clipboard write in the next gesture.
    void loadConverter().catch(error => console.warn('[CleanCopy]', error));
    const dialog = document.createElement('dialog');
    dialog.id = 'cleancopy_menu';
    dialog.setAttribute('aria-labelledby', 'cleancopy_menu_title');
    dialog.innerHTML = `<h3 id="cleancopy_menu_title">选择复制内容</h3>
        <p>保留当前正文，并补入所选标签内的文字。</p>
        <div class="cleancopy_presets">
            <button type="button" class="menu_button" data-tags="thinking">正文 + thinking</button>
            <button type="button" class="menu_button" data-tags="details">正文 + details</button>
            <button type="button" class="menu_button" data-tags="thinking,details">正文 + thinking + details</button>
        </div>
        <div class="cleancopy_choices"></div>
        <label for="cleancopy_extra_tags">其他标签（用逗号或空格分隔）</label>
        <input id="cleancopy_extra_tags" class="text_pole" placeholder="例如 status、memory">
        <div class="cleancopy_actions">
            <button type="button" class="menu_button cleancopy_confirm">复制所选组合</button>
            <button type="button" class="menu_button cleancopy_body">只复制正文</button>
            <button type="button" class="menu_button cleancopy_cancel">取消</button>
        </div>`;
    const choices = dialog.querySelector('.cleancopy_choices');
    normalizeTags(['thinking', 'details', ...settings().rules.map(r => r.tag)]).filter(tag => tag !== 'content').forEach(tag => {
        const label = document.createElement('label');
        label.className = 'checkbox_label';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.value = tag;
        label.append(check, document.createTextNode(tag));
        choices.append(label);
    });
    const close = () => dialog.close();
    const copy = tags => { close(); void copyMessage(button, tags); };
    dialog.querySelectorAll('[data-tags]').forEach(preset => preset.addEventListener('click', () => copy(preset.dataset.tags.split(','))));
    dialog.querySelector('.cleancopy_body').addEventListener('click', () => copy([]));
    dialog.querySelector('.cleancopy_cancel').addEventListener('click', close);
    dialog.querySelector('.cleancopy_confirm').addEventListener('click', () => {
        const extra = dialog.querySelector('#cleancopy_extra_tags').value.split(/[\s,，、]+/).filter(Boolean);
        if (extra.some(tag => !/^[a-z][a-z0-9-]*$/i.test(tag))) return toastr.warning('请输入标签名，例如 status；多个标签用逗号分隔');
        copy(normalizeTags([...choices.querySelectorAll('input:checked')].map(check => check.value).concat(extra)));
    });
    dialog.addEventListener('close', () => { dialog.remove(); if (button.isConnected) button.focus({ preventScroll: true }); }, { once: true });
    dialog.addEventListener('click', event => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    });
    document.body.append(dialog);
    dialog.showModal();
}

function bindButton(button) {
    let timer;
    let start;
    let suppressClick = false;
    const cancelTimer = () => { clearTimeout(timer); timer = undefined; };
    button.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !event.isPrimary) return;
        cancelTimer();
        suppressClick = false;
        start = { x: event.clientX, y: event.clientY, id: event.pointerId };
        button.setPointerCapture(event.pointerId);
        timer = setTimeout(() => {
            suppressClick = true;
            if (button.isConnected) openCopyMenu(button);
        }, 500);
    });
    button.addEventListener('pointermove', event => {
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) {
            cancelTimer();
            suppressClick = true;
        }
    });
    button.addEventListener('pointerup', event => {
        cancelTimer();
        start = undefined;
        if (suppressClick) { event.preventDefault(); event.stopPropagation(); }
    });
    for (const name of ['pointercancel', 'lostpointercapture']) button.addEventListener(name, () => { cancelTimer(); start = undefined; });
    button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (suppressClick) { suppressClick = false; return; }
        void copyMessage(button);
    });
    button.addEventListener('contextmenu', event => {
        event.preventDefault();
        event.stopPropagation();
        cancelTimer();
        suppressClick = true;
        openCopyMenu(button);
    });
    button.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'ContextMenu') {
            event.preventDefault();
            suppressClick = false;
            if (!event.repeat) {
                if (event.shiftKey || event.key === 'ContextMenu') openCopyMenu(button);
                else void copyMessage(button);
            }
        }
    });
}

export function installButtons(scope = document) {
    scope.querySelectorAll('#chat .mes .mes_buttons').forEach(toolbar => {
        if (toolbar.querySelector(`.${BUTTON}`)) return;
        const button = document.createElement('div');
        button.className = `mes_button ${BUTTON} fa-solid`;
        // Lucide Feather (ISC), matching the preview chosen by the user.
        button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12.67 19a2 2 0 0 0 1.416-.588l6.154-6.172a6 6 0 0 0-8.49-8.49L5.586 9.914A2 2 0 0 0 5 11.328V18a1 1 0 0 0 1 1z"/><path d="M16 8 2 22"/><path d="M17.5 15H9"/></svg>';
        button.title = '净文复制 · 长按或右键选择内容';
        button.setAttribute('aria-label', '净文复制，长按或 Shift+Enter 选择内容');
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('role', 'button');
        button.tabIndex = 0;
        bindButton(button);
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
            <p>短按复制当前净文；长按或右键选择正文加 thinking、details 或自定义标签。自动排除代码和 HTML 注释。</p>
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
