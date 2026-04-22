import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    updateMessageBlock,
} from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';

const EXTENSION_KEY = 'jp_dialogue_append';

/**
 * @typedef {{ source: string, target: string }} NameMapping
 * @typedef {{
 *   enabled: boolean,
 *   auto_mode: string,
 *   profile_id: string,
 *   target_language: string,
 *   max_tokens: number,
 *   temperature: number,
 *   process_swipes: boolean,
 *   reprocess_on_edit: boolean,
 *   detect_double_quotes: boolean,
 *   max_segments_per_message: number,
 *   prompt_template: string,
 *   content_tags: string,
 *   render_mode: string,
 *   custom_regex: string,
 *   name_mappings: NameMapping[],
 *   batch_mode_enabled: boolean,
 *   batch_size: number,
 *   batch_char_limit: number,
 * }} JpdaSettings
 */

const defaultPromptTemplate = [
    '你是一个对白翻译引擎。',
    '你的任务是把提供的对白逐条翻译成指定的目标语种。',
    '只翻译对白内容，不要解释，不要扩写。',
    '尽量保持语气、敬语、停顿、省略号、情绪与角色风格。',
    '如果给出了名称翻译映射，请严格优先使用映射中的译法，保持前后一致。',
    '必须覆盖输入中的全部对白，不能漏条。',
    '你会在输入中收到 target_language 字段，必须严格按该目标语种翻译。只返回严格 JSON，格式必须是：',
    '{"translations":["..."]}',
].join('\n');

/** @type {JpdaSettings} */
const defaultSettings = {
    enabled: true,
    auto_mode: 'responses',
    profile_id: '',
    target_language: 'ja',
    max_tokens: 4000,
    temperature: 0.2,
    process_swipes: true,
    reprocess_on_edit: true,
    detect_double_quotes: true,
    max_segments_per_message: 100,
    prompt_template: defaultPromptTemplate,
    content_tags: 'content',
    render_mode: 'display_text',
    custom_regex: '',
    name_mappings: [],
    batch_mode_enabled: true,
    batch_size: 12,
    batch_char_limit: 700,
};

const processingMessages = new Set();

/**
 * @returns {Record<string, any>}
 */
function getExtensionSettingsRoot() {
    return /** @type {Record<string, any>} */ (extension_settings);
}

/**
 * @returns {JpdaSettings}
 */
function ensureSettings() {
    const root = getExtensionSettingsRoot();
    root[EXTENSION_KEY] ??= {};

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (root[EXTENSION_KEY][key] === undefined) {
            root[EXTENSION_KEY][key] = Array.isArray(value)
                ? structuredClone(value)
                : value;
        }
    }

    if (!Array.isArray(root[EXTENSION_KEY].name_mappings)) {
        root[EXTENSION_KEY].name_mappings = [];
    }

    // Migration: older versions stored a very low segment cap (20),
    // which causes long dialogue messages to be truncated before translation.
    if (Number(root[EXTENSION_KEY].max_segments_per_message) === 20) {
        root[EXTENSION_KEY].max_segments_per_message = 100;
    }

    return /** @type {JpdaSettings} */ (root[EXTENSION_KEY]);
}

/**
 * @returns {JpdaSettings}
 */
function getSettings() {
    return ensureSettings();
}

function saveSettings() {
    saveSettingsDebounced();
}

function getContainer() {
    return document.querySelector('#extensions_settings2')
        || document.querySelector('#extensions_settings')
        || document.querySelector('#translation_container')
        || document.querySelector('#extensionsMenu')
        || document.body;
}

function buildSettingsHtml() {
    return `
<div class="jpda-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>对白追加翻译</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label" for="jpda_enabled">启用插件</label>
            <input id="jpda_enabled" type="checkbox" />

            <label for="jpda_auto_mode">自动模式</label>
            <select id="jpda_auto_mode">
                <option value="none">关闭</option>
                <option value="responses">处理角色回复</option>
            </select>

            <label for="jpda_profile_id">翻译用连接配置</label>
            <div class="jpda-row">
                <select id="jpda_profile_id"></select>
                <div id="jpda_refresh_profiles" class="menu_button menu_button_icon" title="刷新配置列表">
                    <i class="fa-solid fa-rotate"></i>
                </div>
            </div>

            <div class="jpda-hint">
                推荐专门建立一个用于翻译的 Connection Profile。<br>
                显示效果：<code>"……我知道了。"「……わかった。」</code>
            </div>

            <label for="jpda_target_language">翻译目标语种</label>
            <input id="jpda_target_language" type="text" class="text_pole" placeholder="例如：ja、日语、en、英语、ko、韩语" />
            <div class="jpda-note">可填写语言代码或自然语言名称，具体以所选模型的理解能力为准。</div>

            <label for="jpda_temperature">温度</label>
            <input id="jpda_temperature" type="number" min="0" max="2" step="0.1" />

            <label for="jpda_max_tokens">最大输出 Token</label>
            <input id="jpda_max_tokens" type="number" min="100" max="16000" step="100" />
            <div class="jpda-note">已提高上限；如果仍然容易截断，建议启用下方分批翻译。</div>

            <label class="checkbox_label" for="jpda_batch_mode_enabled">启用分批翻译</label>
            <input id="jpda_batch_mode_enabled" type="checkbox" />

            <label for="jpda_batch_size">每批最大对白条数</label>
            <input id="jpda_batch_size" type="number" min="1" max="50" step="1" />

            <label for="jpda_batch_char_limit">每批最大字符数</label>
            <input id="jpda_batch_char_limit" type="number" min="100" max="4000" step="50" />

            <label class="checkbox_label" for="jpda_process_swipes">处理 Swipe</label>
            <input id="jpda_process_swipes" type="checkbox" />

            <label class="checkbox_label" for="jpda_reprocess_on_edit">编辑后重新处理</label>
            <input id="jpda_reprocess_on_edit" type="checkbox" />

            <label class="checkbox_label" for="jpda_detect_double_quotes">识别英文双引号 \"...\"</label>
            <input id="jpda_detect_double_quotes" type="checkbox" />

            <label for="jpda_max_segments_per_message">单条消息最大处理对白数</label>
            <input id="jpda_max_segments_per_message" type="number" min="1" max="300" step="1" />

            <label for="jpda_content_tags">正文 XML 标签（每行或用逗号分隔）</label>
            <textarea id="jpda_content_tags" class="text_pole" placeholder="例如：content\nmessage\nmain"></textarea>
            <div class="jpda-note">只会在这些 XML 标签包裹的正文范围内提取对白。支持多个标签名；匹配形如 <code>&lt;content&gt;...&lt;/content&gt;</code> 或带属性的开始标签。</div>

            <label for="jpda_render_mode">渲染模式</label>
            <select id="jpda_render_mode">
                <option value="display_text">覆盖显示（默认）</option>
                <option value="dom_compatible">状态栏兼容模式</option>
            </select>
            <div class="jpda-note">“覆盖显示”会改写 <code>display_text</code>，兼容性较低；“状态栏兼容模式”会尽量保留原消息渲染结果，仅修改正文标签内的内容。</div>

            <label for="jpda_custom_regex">自定义对白匹配正则（每行一条）</label>
            <textarea id="jpda_custom_regex" class="text_pole" placeholder="可选。每行一条正则，例如：\n“([\\s\\S]+?)”\n‘([\\s\\S]+?)’\n([^：\\n]{1,20})：([^\\n]+)\n\n当前默认使用第 1 个捕获组作为要翻译的对白内容。"></textarea>
            <div class="jpda-note">说明：支持多条规则；空行会被忽略。若你的规则是“角色：台词”并希望取第 2 个捕获组，我可以继续帮你扩展。</div>

            <div class="jpda-subtitle">名称翻译映射</div>
            <div class="jpda-hint">用于统一角色名、地点名、专有名词的译法，减少同名多翻的情况。</div>
            <div id="jpda_name_mappings" class="jpda-map-list"></div>
            <div class="jpda-actions">
                <div id="jpda_add_name_mapping" class="menu_button">
                    <i class="fa-solid fa-plus"></i>
                    <span>添加映射</span>
                </div>
            </div>

            <label for="jpda_prompt_template">翻译任务提示词</label>
            <textarea id="jpda_prompt_template" class="text_pole"></textarea>

            <div class="jpda-actions">
                <div id="jpda_process_chat" class="menu_button">
                    <i class="fa-solid fa-language"></i>
                    <span>处理当前聊天</span>
                </div>
                <div id="jpda_clear_chat" class="menu_button">
                    <i class="fa-solid fa-trash-can"></i>
                    <span>清除当前缓存</span>
                </div>
            </div>
        </div>
    </div>
</div>`;
}

/**
 * @param {NameMapping} [mapping]
 * @param {number} [index]
 */
function createNameMappingItem(mapping = { source: '', target: '' }, index = -1) {
    const row = document.createElement('div');
    row.className = 'jpda-map-item';
    row.dataset.index = String(index);

    const source = document.createElement('input');
    source.type = 'text';
    source.className = 'text_pole';
    source.placeholder = '原名称 / 原文';
    source.value = String(mapping.source ?? '');

    const target = document.createElement('input');
    target.type = 'text';
    target.className = 'text_pole';
    target.placeholder = '目标译法';
    target.value = String(mapping.target ?? '');

    const removeButton = document.createElement('div');
    removeButton.className = 'menu_button menu_button_icon';
    removeButton.title = '删除';
    removeButton.innerHTML = '<i class="fa-solid fa-trash"></i>';

    source.addEventListener('input', () => {
        const settings = getSettings();
        const item = settings.name_mappings[index];
        if (!item) return;
        item.source = source.value;
        saveSettings();
    });

    target.addEventListener('input', () => {
        const settings = getSettings();
        const item = settings.name_mappings[index];
        if (!item) return;
        item.target = target.value;
        saveSettings();
    });

    removeButton.addEventListener('click', () => {
        const settings = getSettings();
        settings.name_mappings.splice(index, 1);
        renderNameMappings();
        saveSettings();
    });

    row.append(source, target, removeButton);
    return row;
}

function renderNameMappings() {
    const container = document.getElementById('jpda_name_mappings');
    if (!container) return;

    container.innerHTML = '';
    const settings = getSettings();

    settings.name_mappings.forEach((mapping, index) => {
        container.appendChild(createNameMappingItem(mapping, index));
    });
}

function populateProfileOptions() {
    const select = document.getElementById('jpda_profile_id');
    if (!(select instanceof HTMLSelectElement)) {
        return;
    }

    const settings = getSettings();
    const context = getContext();

    select.innerHTML = '';

    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = '请选择一个连接配置';
    select.appendChild(emptyOption);

    /** @type {any[]} */
    let profiles = [];

    try {
        profiles = context.ConnectionManagerRequestService.getSupportedProfiles();
    } catch (error) {
        console.warn('[JPDA] 读取连接配置失败', error);
    }

    profiles.sort((a, b) => String(a.name).localeCompare(String(b.name)));

    for (const profile of profiles) {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.name;
        select.appendChild(option);
    }

    select.value = settings.profile_id || '';
}

function loadSettingsToUi() {
    const settings = getSettings();

    const enabled = document.getElementById('jpda_enabled');
    const autoMode = document.getElementById('jpda_auto_mode');
    const temperature = document.getElementById('jpda_temperature');
    const targetLanguage = document.getElementById('jpda_target_language');
    const maxTokens = document.getElementById('jpda_max_tokens');
    const batchModeEnabled = document.getElementById('jpda_batch_mode_enabled');
    const batchSize = document.getElementById('jpda_batch_size');
    const batchCharLimit = document.getElementById('jpda_batch_char_limit');
    const processSwipes = document.getElementById('jpda_process_swipes');
    const reprocessOnEdit = document.getElementById('jpda_reprocess_on_edit');
    const detectDoubleQuotes = document.getElementById('jpda_detect_double_quotes');
    const maxSegments = document.getElementById('jpda_max_segments_per_message');
    const customRegex = document.getElementById('jpda_custom_regex');
    const contentTags = document.getElementById('jpda_content_tags');
    const promptTemplate = document.getElementById('jpda_prompt_template');
    const renderMode = document.getElementById('jpda_render_mode');

    if (enabled instanceof HTMLInputElement) enabled.checked = !!settings.enabled;
    if (autoMode instanceof HTMLSelectElement) autoMode.value = settings.auto_mode;
    if (temperature instanceof HTMLInputElement) temperature.value = String(settings.temperature);
    if (targetLanguage instanceof HTMLInputElement) targetLanguage.value = String(settings.target_language ?? defaultSettings.target_language);
    if (maxTokens instanceof HTMLInputElement) maxTokens.value = String(settings.max_tokens);
    if (batchModeEnabled instanceof HTMLInputElement) batchModeEnabled.checked = !!settings.batch_mode_enabled;
    if (batchSize instanceof HTMLInputElement) batchSize.value = String(settings.batch_size);
    if (batchCharLimit instanceof HTMLInputElement) batchCharLimit.value = String(settings.batch_char_limit);
    if (processSwipes instanceof HTMLInputElement) processSwipes.checked = !!settings.process_swipes;
    if (reprocessOnEdit instanceof HTMLInputElement) reprocessOnEdit.checked = !!settings.reprocess_on_edit;
    if (detectDoubleQuotes instanceof HTMLInputElement) detectDoubleQuotes.checked = !!settings.detect_double_quotes;
    if (maxSegments instanceof HTMLInputElement) maxSegments.value = String(settings.max_segments_per_message);
    if (customRegex instanceof HTMLTextAreaElement) customRegex.value = String(settings.custom_regex ?? '');
    if (contentTags instanceof HTMLTextAreaElement) contentTags.value = String(settings.content_tags ?? defaultSettings.content_tags);
    if (renderMode instanceof HTMLSelectElement) renderMode.value = String(settings.render_mode ?? defaultSettings.render_mode);
    if (promptTemplate instanceof HTMLTextAreaElement) promptTemplate.value = String(settings.prompt_template ?? defaultPromptTemplate);

    populateProfileOptions();
    renderNameMappings();
}

function hashString(input) {
    let hash = 0;
    const text = String(input);

    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash) + text.charCodeAt(i);
        hash |= 0;
    }

    return String(hash);
}

/**
 * @param {string} text
 * @param {RegExp} pattern
 * @param {string} sourceName
 * @param {number} [captureGroup=1]
 * @param {number} [baseOffset=0]
 */
function collectPatternMatches(text, pattern, sourceName, captureGroup = 1, baseOffset = 0) {
    const matches = [];

    for (const match of text.matchAll(pattern)) {
        const full = match[0];
        const inner = match[captureGroup]?.trim();
        const index = match.index ?? -1;

        if (!full || !inner || index < 0) {
            continue;
        }

        matches.push({
            index: index + baseOffset,
            full,
            inner,
            source: sourceName,
        });
    }

    return matches;
}

/**
 * @param {string} label
 * @returns {boolean}
 */
function isLikelyMetadataLabel(label) {
    const normalized = String(label ?? '').trim();
    const blocked = [
        '时间', '地点', '场景', '背景', '旁白', '注释', '系统', '状态', '说明',
        'Time', 'Location', 'Scene', 'Background', 'Narration', 'System', 'Status', 'Note',
    ];

    return blocked.includes(normalized);
}

function escapeRegex(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getContentTagNames() {
    const settings = getSettings();
    return String(settings.content_tags ?? '')
        .split(/[\r\n,]+/)
        .map(x => x.trim())
        .filter(Boolean);
}

/**
 * @param {string} text
 * @returns {{ tag: string, fullStart: number, fullEnd: number, innerStart: number, innerEnd: number, innerText: string }[]}
 */
function getContentRanges(text) {
    const tagNames = getContentTagNames();

    if (!tagNames.length) {
        return [{
            tag: '(entire-message)',
            fullStart: 0,
            fullEnd: text.length,
            innerStart: 0,
            innerEnd: text.length,
            innerText: text,
        }];
    }

    const ranges = [];

    for (const tagName of tagNames) {
        const escapedTag = escapeRegex(tagName);
        const pattern = new RegExp(`<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}>`, 'gi');

        for (const match of text.matchAll(pattern)) {
            const full = match[0] ?? '';
            const inner = match[1] ?? '';
            const fullStart = match.index ?? -1;
            if (fullStart < 0) continue;

            const openTagEndOffset = full.indexOf('>');
            if (openTagEndOffset < 0) continue;

            const innerStart = fullStart + openTagEndOffset + 1;
            const innerEnd = innerStart + inner.length;

            ranges.push({ tag: tagName, fullStart, fullEnd: fullStart + full.length, innerStart, innerEnd, innerText: inner });
        }
    }

    ranges.sort((a, b) => a.innerStart - b.innerStart || a.innerEnd - b.innerEnd);
    return ranges;
}

function getCustomRegexLines() {
    const settings = getSettings();
    return String(settings.custom_regex ?? '')
        .split(/\r?\n/)
        .map(x => x.trim())
        .filter(Boolean);
}

function getQuoteMatches(text) {
    const settings = getSettings();
    const contentRanges = getContentRanges(text);
    const matches = [];
    const patterns = [
        { regex: /「([\s\S]+?)」/g, source: 'corner-brackets', captureGroup: 1 },
        { regex: /『([\s\S]+?)』/g, source: 'double-corner-brackets', captureGroup: 1 },
        { regex: /“([\s\S]+?)”/g, source: 'cn-double-quotes', captureGroup: 1 },
        { regex: /‘([\s\S]+?)’/g, source: 'cn-single-quotes', captureGroup: 1 },
        { regex: /〝([\s\S]+?)〞/g, source: 'corner-quote-variant', captureGroup: 1 },
        { regex: /﹁([\s\S]+?)﹂/g, source: 'corner-quote-variant-2', captureGroup: 1 },
        { regex: /^([^：:\n]{1,20})[：:]\s*([^\n]+)$/gm, source: 'name-colon-line', captureGroup: 2 },
    ];

    if (settings.detect_double_quotes) {
        patterns.push({ regex: /"([\s\S]+?)"/g, source: 'double-quotes', captureGroup: 1 });
    }

    for (const range of contentRanges) {
        for (const { regex, source, captureGroup } of patterns) {
            matches.push(...collectPatternMatches(range.innerText, regex, source, captureGroup, range.innerStart));
        }
    }

    for (const range of contentRanges) {
        for (const customRegexLine of getCustomRegexLines()) {
            try {
                const customPattern = new RegExp(customRegexLine, 'g');
                matches.push(...collectPatternMatches(range.innerText, customPattern, `custom-regex:${customRegexLine}`, 1, range.innerStart));
            } catch (error) {
                console.warn('[JPDA] 自定义正则无效', customRegexLine, error);
            }
        }
    }

    matches.sort((a, b) => a.index - b.index || b.full.length - a.full.length);

    const deduped = [];
    for (const item of matches) {
        if (item.source === 'name-colon-line') {
            const labelMatch = item.full.match(/^([^：:\n]{1,20})[：:]/);
            const label = labelMatch?.[1] ?? '';
            if (isLikelyMetadataLabel(label)) {
                continue;
            }
        }

        const overlap = deduped.some(existing => {
            const a1 = existing.index;
            const a2 = existing.index + existing.full.length;
            const b1 = item.index;
            const b2 = item.index + item.full.length;
            return Math.max(a1, b1) < Math.min(a2, b2);
        });

        if (!overlap) {
            deduped.push(item);
        }
    }

    const finalMatches = deduped.slice(0, settings.max_segments_per_message);

    console.log('[JPDA] 对白抓取统计', {
        contentTags: getContentTagNames(),
        contentRanges: contentRanges.map(x => ({ tag: x.tag, innerStart: x.innerStart, innerEnd: x.innerEnd, preview: x.innerText.slice(0, 100) })),
        totalRawMatches: matches.length,
        dedupedMatches: deduped.length,
        finalMatches: finalMatches.length,
        maxSegmentsPerMessage: settings.max_segments_per_message,
        samples: finalMatches.slice(0, 10).map(x => ({
            source: x.source,
            index: x.index,
            full: x.full,
            inner: x.inner,
        })),
    });

    return finalMatches;
}

function buildRenderedInnerText(sourceText, matches, translations, startOffset = 0) {
    let cursor = 0;
    let output = '';

    for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const translation = String(translations[i] ?? '').trim();
        const start = match.index - startOffset;
        const end = start + match.full.length;

        output += sourceText.slice(cursor, start);
        output += translation ? `"${match.inner}"「${translation}」` : match.full;
        cursor = end;
    }

    output += sourceText.slice(cursor);
    return output;
}

function buildRenderedText(sourceText, matches, translations) {
    const contentRanges = getContentRanges(sourceText);

    if (!contentRanges.length) {
        return sourceText;
    }

    let cursor = 0;
    let output = '';
    let translationIndex = 0;

    for (const range of contentRanges) {
        output += sourceText.slice(cursor, range.innerStart);

        const rangeMatches = [];
        const rangeTranslations = [];
        while (translationIndex < matches.length) {
            const match = matches[translationIndex];
            const matchEnd = match.index + match.full.length;

            if (match.index >= range.innerStart && matchEnd <= range.innerEnd) {
                rangeMatches.push(match);
                rangeTranslations.push(translations[translationIndex]);
                translationIndex++;
                continue;
            }

            break;
        }

        output += buildRenderedInnerText(range.innerText, rangeMatches, rangeTranslations, range.innerStart);
        cursor = range.innerEnd;
    }

    output += sourceText.slice(cursor);
    return output;
}

function getMessageTextElement(messageId) {
    return document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
}

function applyCompatibleRender(messageId, sourceText, matches, translations) {
    const mesText = getMessageTextElement(messageId);
    if (!(mesText instanceof HTMLElement)) {
        return false;
    }

    const tagNames = getContentTagNames();
    if (!tagNames.length) {
        return false;
    }

    const contentRanges = getContentRanges(sourceText);
    if (!contentRanges.length) {
        return false;
    }

    const selector = tagNames.join(',');
    const contentElements = Array.from(mesText.querySelectorAll(selector));
    if (!contentElements.length) {
        console.warn('[JPDA] 兼容模式未在已渲染消息中找到正文标签元素', { messageId, selector });
        return false;
    }

    let translationIndex = 0;
    const pairCount = Math.min(contentRanges.length, contentElements.length);

    for (let i = 0; i < pairCount; i++) {
        const range = contentRanges[i];
        const element = contentElements[i];
        const localMatches = [];
        const localTranslations = [];

        while (translationIndex < matches.length) {
            const match = matches[translationIndex];
            const start = match.index;
            const end = start + match.full.length;

            if (start >= range.innerStart && end <= range.innerEnd) {
                localMatches.push({
                    ...match,
                    index: start - range.innerStart,
                });
                localTranslations.push(translations[translationIndex]);
                translationIndex++;
                continue;
            }

            break;
        }

        const transformed = buildRenderedText(range.innerText, localMatches, localTranslations);
        element.textContent = transformed;
    }

    return true;
}

function extractJsonPayload(raw) {
    if (raw && typeof raw === 'object') {
        return raw;
    }

    const text = String(raw ?? '').trim();

    if (!text) {
        throw new Error('翻译器返回为空');
    }

    try {
        return JSON.parse(text);
    } catch {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start >= 0 && end > start) {
            return JSON.parse(text.slice(start, end + 1));
        }
    }

    throw new Error('翻译器返回的不是有效 JSON');
}

function getNormalizedMappings() {
    const settings = getSettings();
    return (settings.name_mappings || [])
        .map(item => ({
            source: String(item?.source ?? '').trim(),
            target: String(item?.target ?? '').trim(),
        }))
        .filter(item => item.source && item.target);
}

function buildChatMessages(dialogues, language) {
    const settings = getSettings();
    const mappings = getNormalizedMappings();
    const systemPrompt = String(settings.prompt_template || defaultPromptTemplate).trim();

    return [
        {
            role: 'system',
            content: systemPrompt,
        },
        {
            role: 'user',
            content: JSON.stringify({
                target_language: language,
                name_mappings: mappings,
                dialogues,
            }),
        },
    ];
}

function buildTextPrompt(dialogues, language) {
    const settings = getSettings();
    const mappings = getNormalizedMappings();
    return [
        String(settings.prompt_template || defaultPromptTemplate).trim(),
        JSON.stringify({
            target_language: language,
            name_mappings: mappings,
            dialogues,
        }),
    ].join('\n\n');
}

/**
 * @param {string[]} dialogues
 */
async function requestTranslations(dialogues) {
    const settings = getSettings();
    const context = getContext();

    if (!settings.profile_id) {
        throw new Error('尚未选择翻译连接配置');
    }

    const profile = context.extensionSettings.connectionManager.profiles.find(p => p.id === settings.profile_id);
    if (!profile) {
        throw new Error('找不到已选择的翻译连接配置');
    }

    const apiMap = context.CONNECT_API_MAP[profile.api];
    if (!apiMap) {
        throw new Error('该连接配置的 API 类型暂不支持');
    }

    const overridePayload = {
        temperature: Number(settings.temperature),
    };

    let result;

    if (apiMap.selected === 'openai') {
        const jsonSchema = {
            name: 'dialogue_translations',
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    translations: {
                        type: 'array',
                        items: { type: 'string' },
                    },
                },
                required: ['translations'],
            },
        };

        result = await context.ConnectionManagerRequestService.sendRequest(
            settings.profile_id,
            buildChatMessages(dialogues, settings.target_language),
            Number(settings.max_tokens),
            { stream: false, extractData: true, includePreset: true },
            { ...overridePayload, json_schema: jsonSchema },
        );
    } else {
        result = await context.ConnectionManagerRequestService.sendRequest(
            settings.profile_id,
            buildTextPrompt(dialogues, settings.target_language),
            Number(settings.max_tokens),
            { stream: false, extractData: true, includePreset: true, includeInstruct: true },
            overridePayload,
        );
    }

    const payload = extractJsonPayload(result?.content ?? result);
    const translations = Array.isArray(payload?.translations)
        ? payload.translations.map(x => String(x ?? '').trim())
        : null;

    if (!translations) {
        throw new Error('翻译器返回中缺少 translations 数组');
    }

    if (translations.length < dialogues.length) {
        throw new Error(`翻译器返回的条目数量不足：需要 ${dialogues.length} 条，实际 ${translations.length} 条`);
    }

    return translations.slice(0, dialogues.length);
}

/**
 * @param {string[]} dialogues
 */
function splitDialoguesIntoBatches(dialogues) {
    const settings = getSettings();

    if (!settings.batch_mode_enabled) {
        return [dialogues];
    }

    const batches = [];
    let current = [];
    let currentChars = 0;

    for (const dialogue of dialogues) {
        const len = String(dialogue).length;
        const wouldOverflowCount = current.length >= settings.batch_size;
        const wouldOverflowChars = current.length > 0 && (currentChars + len > settings.batch_char_limit);

        if (wouldOverflowCount || wouldOverflowChars) {
            batches.push(current);
            current = [];
            currentChars = 0;
        }

        current.push(dialogue);
        currentChars += len;
    }

    if (current.length > 0) {
        batches.push(current);
    }

    return batches;
}

/**
 * @param {string[]} dialogues
 */
async function requestTranslationsBatched(dialogues) {
    const batches = splitDialoguesIntoBatches(dialogues);

    if (batches.length <= 1) {
        return await requestTranslations(dialogues);
    }

    const allTranslations = [];
    for (const batch of batches) {
        const partial = await requestTranslations(batch);
        allTranslations.push(...partial);
    }

    if (allTranslations.length < dialogues.length) {
        throw new Error(`分批翻译后条目仍然不足：需要 ${dialogues.length} 条，实际 ${allTranslations.length} 条`);
    }

    return allTranslations.slice(0, dialogues.length);
}

async function processMessage(messageId, { force = false } = {}) {
    const settings = getSettings();
    const context = getContext();
    const message = context.chat?.[messageId];

    if (!settings.enabled || settings.auto_mode === 'none') {
        return;
    }

    if (!message || message.is_system || message.is_user) {
        return;
    }

    if (processingMessages.has(messageId)) {
        return;
    }

    const sourceText = String(message.mes ?? '');
    if (!sourceText.trim()) {
        return;
    }

    const matches = getQuoteMatches(sourceText);
    if (!matches.length) {
        console.log('[JPDA] 未识别到任何对白', {
            messageId,
            preview: sourceText.slice(0, 1000),
        });
        return;
    }

    const sourceHash = hashString(JSON.stringify({
        text: sourceText,
        regex: settings.custom_regex,
        detectDoubleQuotes: settings.detect_double_quotes,
        contentTags: settings.content_tags,
        mappings: getNormalizedMappings(),
        renderMode: settings.render_mode,
        prompt: settings.prompt_template,
        maxTokens: settings.max_tokens,
        targetLanguage: settings.target_language,
        batchModeEnabled: settings.batch_mode_enabled,
        batchSize: settings.batch_size,
        batchCharLimit: settings.batch_char_limit,
    }));

    const cache = message.extra?.jp_dialogue_append;
    if (!force && cache?.source_hash === sourceHash && cache?.rendered_text) {
        if (settings.render_mode === 'dom_compatible') {
            const applied = applyCompatibleRender(Number(messageId), sourceText, matches, cache.translations ?? []);
            if (!applied) {
                if (message.extra?.display_text !== cache.rendered_text) {
                    message.extra.display_text = cache.rendered_text;
                    updateMessageBlock(Number(messageId), message);
                }
            }
        } else {
            if (message.extra?.display_text !== cache.rendered_text) {
                message.extra.display_text = cache.rendered_text;
                updateMessageBlock(Number(messageId), message);
            }
        }
        return;
    }

    processingMessages.add(messageId);

    try {
        message.extra ??= {};

        const dialogues = matches.map(x => x.inner);
        console.log('[JPDA] 即将送翻译的对白', {
            messageId,
            count: dialogues.length,
            dialoguesPreview: dialogues.slice(0, 20),
        });
        const translations = await requestTranslationsBatched(dialogues);
        const renderedText = buildRenderedText(sourceText, matches, translations);

        message.extra.jp_dialogue_append = {
            source_hash: sourceHash,
            dialogues,
            translations,
            rendered_text: renderedText,
            updated_at: Date.now(),
        };

        if (settings.render_mode === 'dom_compatible') {
            delete message.extra.display_text;
            updateMessageBlock(Number(messageId), message);
            const applied = applyCompatibleRender(Number(messageId), sourceText, matches, translations);

            if (!applied) {
                message.extra.display_text = renderedText;
                updateMessageBlock(Number(messageId), message);
            }
        } else {
            message.extra.display_text = renderedText;
            updateMessageBlock(Number(messageId), message);
        }
    } catch (error) {
        console.error('[JPDA] 处理消息失败', messageId, error);
        toastr.error(String(error?.message ?? error), '对白追加翻译');
    } finally {
        processingMessages.delete(messageId);
    }
}

async function processCurrentChat() {
    const context = getContext();
    const chat = context.chat ?? [];

    for (let i = 0; i < chat.length; i++) {
        await processMessage(i, { force: true });
    }

    await context.saveChat();
    toastr.success('当前聊天处理完成', '对白追加翻译');
}

async function clearCurrentChatCache() {
    const context = getContext();
    const chat = context.chat ?? [];

    for (const message of chat) {
        if (!message?.extra) {
            continue;
        }

        if (message.extra.jp_dialogue_append?.rendered_text && message.extra.display_text === message.extra.jp_dialogue_append.rendered_text) {
            delete message.extra.display_text;
        }

        delete message.extra.jp_dialogue_append;
    }

    await context.saveChat();

    for (let i = 0; i < chat.length; i++) {
        updateMessageBlock(i, chat[i]);
    }

    toastr.success('已清除当前聊天缓存', '对白追加翻译');
}

function bindSettingsEvents() {
    document.getElementById('jpda_enabled')?.addEventListener('change', (event) => {
        const settings = getSettings();
        settings.enabled = Boolean(event.target.checked);
        saveSettings();
    });

    document.getElementById('jpda_auto_mode')?.addEventListener('change', (event) => {
        const settings = getSettings();
        settings.auto_mode = String(event.target.value);
        saveSettings();
    });

    document.getElementById('jpda_profile_id')?.addEventListener('change', (event) => {
        const settings = getSettings();
        settings.profile_id = String(event.target.value);
        saveSettings();
    });

    document.getElementById('jpda_temperature')?.addEventListener('input', (event) => {
        const settings = getSettings();
        settings.temperature = Number(event.target.value) || defaultSettings.temperature;
        saveSettings();
    });

    document.getElementById('jpda_target_language')?.addEventListener('input', (event) => {
        const settings = getSettings();
        settings.target_language = String(event.target.value ?? '').trim() || defaultSettings.target_language;
        saveSettings();
    });

    document.getElementById('jpda_max_tokens')?.addEventListener('input', (event) => {
        const settings = getSettings();
        settings.max_tokens = Math.max(100, Number(event.target.value) || defaultSettings.max_tokens);
        saveSettings();
    });

    document.getElementById('jpda_batch_mode_enabled')?.addEventListener('change', (event) => {
        const settings = getSettings();
        settings.batch_mode_enabled = Boolean(event.target.checked);
        saveSettings();
    });

    document.getElementById('jpda_batch_size')?.addEventListener('input', (event) => {
        const settings = getSettings();
        settings.batch_size = Math.max(1, Number(event.target.value) || defaultSettings.batch_size);
        saveSettings();
    });

    document.getElementById('jpda_batch_char_limit')?.addEventListener('input', (event) => {
        const settings = getSettings();
        settings.batch_char_limit = Math.max(100, Number(event.target.value) || defaultSettings.batch_char_limit);
        saveSettings();
    });

    document.getElementById('jpda_process_swipes')?.addEventListener('change', (event) => {
        const settings = getSettings();
        settings.process_swipes = Boolean(event.target.checked);
        saveSettings();
    });

    document.getElementById('jpda_reprocess_on_edit')?.addEventListener('change', (event) => {
        const settings = getSettings();
        settings.reprocess_on_edit = Boolean(event.target.checked);
        saveSettings();
    });

    document.getElementById('jpda_detect_double_quotes')?.addEventListener('change', (event) => {
        const settings = getSettings();
        settings.detect_double_quotes = Boolean(event.target.checked);
        saveSettings();
    });

    document.getElementById('jpda_max_segments_per_message')?.addEventListener('input', (event) => {
        const settings = getSettings();
        settings.max_segments_per_message = Math.max(1, Number(event.target.value) || defaultSettings.max_segments_per_message);
        saveSettings();
    });

    document.getElementById('jpda_custom_regex')?.addEventListener('input', (event) => {
        const settings = getSettings();
        settings.custom_regex = String(event.target.value ?? '');
        saveSettings();
    });

    document.getElementById('jpda_content_tags')?.addEventListener('input', (event) => {
        const settings = getSettings();
        settings.content_tags = String(event.target.value ?? '');
        saveSettings();
    });

    document.getElementById('jpda_render_mode')?.addEventListener('change', (event) => {
        const settings = getSettings();
        settings.render_mode = String(event.target.value ?? '') || defaultSettings.render_mode;
        saveSettings();
    });

    document.getElementById('jpda_prompt_template')?.addEventListener('input', (event) => {
        const settings = getSettings();
        settings.prompt_template = String(event.target.value ?? '');
        saveSettings();
    });

    document.getElementById('jpda_add_name_mapping')?.addEventListener('click', () => {
        const settings = getSettings();
        settings.name_mappings.push({ source: '', target: '' });
        renderNameMappings();
        saveSettings();
    });

    document.getElementById('jpda_refresh_profiles')?.addEventListener('click', () => {
        populateProfileOptions();
        toastr.info('已刷新连接配置列表', '对白追加翻译');
    });

    document.getElementById('jpda_process_chat')?.addEventListener('click', async () => {
        await processCurrentChat();
    });

    document.getElementById('jpda_clear_chat')?.addEventListener('click', async () => {
        await clearCurrentChatCache();
    });
}

async function handleCharacterMessage(messageId) {
    const settings = getSettings();
    if (!settings.enabled || settings.auto_mode !== 'responses') {
        return;
    }

    await processMessage(messageId);
}

async function handleSwipe(messageId) {
    const settings = getSettings();
    if (!settings.enabled || !settings.process_swipes) {
        return;
    }

    await processMessage(messageId, { force: true });
}

async function handleMessageUpdated(messageId) {
    const settings = getSettings();
    if (!settings.enabled || !settings.reprocess_on_edit) {
        return;
    }

    const context = getContext();
    const message = context.chat?.[messageId];
    if (message?.extra?.jp_dialogue_append?.rendered_text && message.extra.display_text === message.extra.jp_dialogue_append.rendered_text) {
        delete message.extra.display_text;
    }
    delete message?.extra?.jp_dialogue_append;

    await processMessage(messageId, { force: true });
}

function handleChatChanged() {
    processingMessages.clear();
    populateProfileOptions();
}

function initUi() {
    const old = document.getElementById('jpda_root');
    old?.remove();

    const root = document.createElement('div');
    root.id = 'jpda_root';
    root.innerHTML = buildSettingsHtml();
    getContainer().append(root);
    loadSettingsToUi();
    bindSettingsEvents();
}

jQuery(async () => {
    ensureSettings();
    initUi();

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, handleCharacterMessage);
    eventSource.on(event_types.MESSAGE_SWIPED, handleSwipe);
    eventSource.on(event_types.MESSAGE_UPDATED, handleMessageUpdated);
    eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);
});
