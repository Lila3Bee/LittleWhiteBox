import { extension_settings, getContext, writeExtensionField } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, characters, this_chid, updateMessageBlock } from "../../../../script.js";
import { callGenericPopup, POPUP_TYPE } from "../../../popup.js";
import { selected_group } from "../../../group-chats.js";
import { findChar, download } from "../../../utils.js";
import { executeSlashCommand } from "./index.js";

const EXT_ID = "LittleWhiteBox";
const TEMPLATE_MODULE_NAME = "xiaobaix-template";
const extensionFolderPath = `scripts/extensions/third-party/${EXT_ID}`;

async function STscript(command) {
    if (!command) return { error: "命令为空" };
    if (!command.startsWith('/')) command = '/' + command;
    return await executeSlashCommand(command);
}

const DEFAULT_CHAR_SETTINGS = {
    enabled: false,
    template: "",
    customRegex: "\\[([^\\]]+)\\]([\\s\\S]*?)\\[\\/\\1\\]",
    limitToRecentMessages: false,
    recentMessageCount: 5,
    skipFirstMessage: false
};

const state = {
    isStreamingCheckActive: false,
    messageVariables: new Map(),
    caches: { template: new Map(), regex: new Map(), dom: new Map() },
    variableHistory: new Map(),
    observers: { message: null, streaming: null },
    pendingUpdates: new Map(),
    isGenerating: false,

    clear() {
        this.messageVariables.clear();
        this.caches.template.clear();
        this.caches.dom.clear();
    },

    getElement(selector, parent = document) {
        const key = `${parent === document ? 'doc' : 'el'}-${selector}`;
        const cached = this.caches.dom.get(key);
        if (cached?.isConnected) return cached;
        const element = parent.querySelector(selector);
        if (element) this.caches.dom.set(key, element);
        return element;
    }
};

const utils = {
    getCharAvatar: msg => msg?.original_avatar ||
        (msg?.name && findChar({ name: msg.name, allowAvatar: true })?.avatar) ||
        (!selected_group && this_chid !== undefined && Number(this_chid) >= 0 && characters[Number(this_chid)]?.avatar) || null,

    isEnabled: () => (window['isXiaobaixEnabled'] ?? true) && TemplateSettings.get().enabled,

    isCustomTemplate: content => ['<html', '<!DOCTYPE', '<script'].some(tag => content?.includes(tag)),

    escapeHtml: html => html.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
};

class TemplateSettings {
    static get() {
        const settings = extension_settings[EXT_ID] = extension_settings[EXT_ID] || {};
        settings.templateEditor = settings.templateEditor || { enabled: false, characterBindings: {} };
        return settings.templateEditor;
    }

    static getCurrentChar() {
        if (this_chid === undefined || !characters[this_chid]) return DEFAULT_CHAR_SETTINGS;
        const character = characters[this_chid];
        const embeddedSettings = character.data?.extensions?.[TEMPLATE_MODULE_NAME];
        return embeddedSettings || { ...DEFAULT_CHAR_SETTINGS, ...(this.get().characterBindings[character.avatar] || {}) };
    }

    static async saveCurrentChar(charSettings) {
        if (this_chid === undefined || !characters[this_chid]) return;
        const avatar = characters[this_chid].avatar;
        state.caches.template.clear();
        await writeExtensionField(Number(this_chid), TEMPLATE_MODULE_NAME, charSettings);
        const globalSettings = this.get();
        globalSettings.characterBindings[avatar] = { ...globalSettings.characterBindings[avatar], ...charSettings };
        saveSettingsDebounced();
    }

    static getCharTemplate(avatar) {
        if (!avatar || !utils.isEnabled()) return null;
        if (state.caches.template.has(avatar)) return state.caches.template.get(avatar);

        let result = null;
        if (this_chid !== undefined && characters[this_chid]?.avatar === avatar) {
            const embeddedSettings = characters[this_chid].data?.extensions?.[TEMPLATE_MODULE_NAME];
            if (embeddedSettings?.enabled) result = embeddedSettings;
        }

        result = result || (this.get().characterBindings[avatar]?.enabled ? this.get().characterBindings[avatar] : null);
        state.caches.template.set(avatar, result);
        return result;
    }
}

class TemplateProcessor {
    static getRegex(pattern = DEFAULT_CHAR_SETTINGS.customRegex) {
        if (state.caches.regex.has(pattern)) return state.caches.regex.get(pattern);
        const regex = (() => {
            try { return new RegExp(pattern, 'g'); }
            catch { return /\[([^\]]+)\]([\s\S]*?)\[\/\1\]/g; }
        })();
        state.caches.regex.set(pattern, regex);
        return regex;
    }

    static extractVars(content, customRegex = null) {
        if (!content || typeof content !== 'string') return {};

        const extractors = [
            () => this.extractRegex(content, customRegex),
            () => this.extractFromCodeBlocks(content, 'json', this.parseJsonDirect),
            () => this.extractJsonFromIncompleteXml(content),
            () => this.isJsonFormat(content) ? this.parseJsonDirect(content) : null,
            () => this.extractFromCodeBlocks(content, 'ya?ml', this.parseYamlDirect),
            () => this.isYamlFormat(content) ? this.parseYamlDirect(content) : null,
            () => this.extractJsonFromXmlWrapper(content)
        ];

        for (const extractor of extractors) {
            const vars = extractor();
            if (vars && Object.keys(vars).length) return vars;
        }
        return {};
    }

    static extractJsonFromIncompleteXml(content) {
        const vars = {};

        const incompleteXmlPattern = /<[^>]+>([^<]*(?:\{[\s\S]*|\w+\s*:[\s\S]*))/g;
        let match;

        while ((match = incompleteXmlPattern.exec(content))) {
            const innerContent = match[1]?.trim();
            if (!innerContent) continue;

            if (innerContent.startsWith('{')) {
                try {
                    const jsonVars = this.parseJsonDirect(innerContent);
                    if (jsonVars && Object.keys(jsonVars).length) {
                        Object.assign(vars, jsonVars);
                        continue;
                    }
                } catch (e) {}
            }

            if (this.isYamlFormat(innerContent)) {
                try {
                    const yamlVars = this.parseYamlDirect(innerContent);
                    if (yamlVars && Object.keys(yamlVars).length) {
                        Object.assign(vars, yamlVars);
                    }
                } catch (e) {}
            }
        }

        return Object.keys(vars).length ? vars : null;
    }

    static extractJsonFromXmlWrapper(content) {
        const vars = {};
        const xmlPattern = /<[^>]+>([\s\S]*?)<\/[^>]+>/g;
        let match;

        while ((match = xmlPattern.exec(content))) {
            const innerContent = match[1]?.trim();
            if (!innerContent) continue;

            if (innerContent.startsWith('{') && innerContent.includes('}')) {
                try {
                    const jsonVars = this.parseJsonDirect(innerContent);
                    if (jsonVars && Object.keys(jsonVars).length) {
                        Object.assign(vars, jsonVars);
                        continue;
                    }
                } catch (e) {}
            }

            if (this.isYamlFormat(innerContent)) {
                try {
                    const yamlVars = this.parseYamlDirect(innerContent);
                    if (yamlVars && Object.keys(yamlVars).length) {
                        Object.assign(vars, yamlVars);
                    }
                } catch (e) {}
            }
        }

        return Object.keys(vars).length ? vars : null;
    }

    static extractRegex(content, customRegex) {
        const vars = {};
        const regex = this.getRegex(customRegex);
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(content))) {
            vars[match[1].trim()] = match[2].trim();
        }
        return Object.keys(vars).length ? vars : null;
    }

    static extractFromCodeBlocks(content, language, parser) {
        const vars = {};
        const regex = new RegExp(`\`\`\`${language}\\s*\\n([\\s\\S]*?)(?:\\n\`\`\`|$)`, 'gi');
        let match;
        while ((match = regex.exec(content))) {
            try {
                const parsed = parser.call(this, match[1].trim());
                if (parsed) Object.assign(vars, parsed);
            } catch (e) {}
        }
        return Object.keys(vars).length ? vars : null;
    }

    static parseJsonDirect(jsonContent) {
        try {
            return JSON.parse(jsonContent.trim());
        } catch {
            return this.parsePartialJsonDirect(jsonContent.trim());
        }
    }

    static parsePartialJsonDirect(jsonContent) {
        const vars = {};
        if (!jsonContent.startsWith('{')) return vars;

        try {
            const parsed = JSON.parse(jsonContent);
            return parsed;
        } catch {}

        const lines = jsonContent.split('\n');
        let currentKey = null;
        let currentValue = '';
        let braceLevel = 0;
        let bracketLevel = 0;
        let inString = false;
        let inObject = false;
        let inArray = false;
        let objectContent = '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === '{' || trimmed === '}') continue;

            const stringMatch = trimmed.match(/^"([^"]+)"\s*:\s*"([^"]*)"[,]?$/);
            if (stringMatch && !inObject && !inArray) {
                vars[stringMatch[1]] = stringMatch[2];
                continue;
            }

            const numMatch = trimmed.match(/^"([^"]+)"\s*:\s*(\d+)[,]?$/);
            if (numMatch && !inObject && !inArray) {
                vars[numMatch[1]] = parseInt(numMatch[2]);
                continue;
            }

            const arrayStartMatch = trimmed.match(/^"([^"]+)"\s*:\s*\[(.*)$/);
            if (arrayStartMatch && !inObject && !inArray) {
                currentKey = arrayStartMatch[1];
                objectContent = '[' + arrayStartMatch[2];
                inArray = true;
                bracketLevel = 1;

                const openBrackets = (arrayStartMatch[2].match(/\[/g) || []).length;
                const closeBrackets = (arrayStartMatch[2].match(/\]/g) || []).length;
                bracketLevel += openBrackets - closeBrackets;

                if (bracketLevel === 0) {
                    try {
                        vars[currentKey] = JSON.parse(objectContent);
                    } catch {}
                    inArray = false;
                    currentKey = null;
                    objectContent = '';
                }
                continue;
            }

            const objStartMatch = trimmed.match(/^"([^"]+)"\s*:\s*\{(.*)$/);
            if (objStartMatch && !inObject && !inArray) {
                currentKey = objStartMatch[1];
                objectContent = '{' + objStartMatch[2];
                inObject = true;
                braceLevel = 1;

                const openBraces = (objStartMatch[2].match(/\{/g) || []).length;
                const closeBraces = (objStartMatch[2].match(/\}/g) || []).length;
                braceLevel += openBraces - closeBraces;

                if (braceLevel === 0) {
                    try {
                        vars[currentKey] = JSON.parse(objectContent);
                    } catch {}
                    inObject = false;
                    currentKey = null;
                    objectContent = '';
                }
                continue;
            }

            if (inArray) {
                objectContent += '\n' + line;
                const openBrackets = (trimmed.match(/\[/g) || []).length;
                const closeBrackets = (trimmed.match(/\]/g) || []).length;
                bracketLevel += openBrackets - closeBrackets;

                if (bracketLevel <= 0) {
                    try {
                        vars[currentKey] = JSON.parse(objectContent);
                    } catch {
                        const cleaned = objectContent.replace(/,\s*$/, '');
                        try {
                            vars[currentKey] = JSON.parse(cleaned);
                        } catch {
                            const attempts = [
                                cleaned + '"]',
                                cleaned + ']'
                            ];
                            for (const attempt of attempts) {
                                try {
                                    vars[currentKey] = JSON.parse(attempt);
                                    break;
                                } catch {}
                            }
                        }
                    }
                    inArray = false;
                    currentKey = null;
                    objectContent = '';
                    bracketLevel = 0;
                }
            }

            if (inObject) {
                objectContent += '\n' + line;
                const openBraces = (trimmed.match(/\{/g) || []).length;
                const closeBraces = (trimmed.match(/\}/g) || []).length;
                braceLevel += openBraces - closeBraces;

                if (braceLevel <= 0) {
                    try {
                        vars[currentKey] = JSON.parse(objectContent);
                    } catch {
                        const cleaned = objectContent.replace(/,\s*$/, '');
                        try {
                            vars[currentKey] = JSON.parse(cleaned);
                        } catch {
                            vars[currentKey] = objectContent;
                        }
                    }
                    inObject = false;
                    currentKey = null;
                    objectContent = '';
                    braceLevel = 0;
                }
            }
        }

        if (inArray && currentKey && objectContent) {
            try {
                const attempts = [
                    objectContent + ']',
                    objectContent.replace(/,\s*$/, '') + ']',
                    objectContent + '"]'
                ];

                for (const attempt of attempts) {
                    try {
                        vars[currentKey] = JSON.parse(attempt);
                        break;
                    } catch {}
                }
            } catch {}
        }

        if (inObject && currentKey && objectContent) {
            try {
                const attempts = [
                    objectContent + '}',
                    objectContent.replace(/,\s*$/, '') + '}'
                ];

                for (const attempt of attempts) {
                    try {
                        vars[currentKey] = JSON.parse(attempt);
                        break;
                    } catch {}
                }
            } catch {}
        }

        return vars;
    }

    static parseYamlDirect(yamlContent) {
        const vars = {};
        const lines = yamlContent.split('\n');
        let i = 0;

        while (i < lines.length) {
            const line = lines[i];
            const trimmed = line.trim();

            if (!trimmed || trimmed.startsWith('#')) {
                i++;
                continue;
            }

            const colonIndex = trimmed.indexOf(':');
            if (colonIndex <= 0) {
                i++;
                continue;
            }

            const key = trimmed.substring(0, colonIndex).trim();
            const afterColon = trimmed.substring(colonIndex + 1).trim();
            const currentIndent = line.length - line.trimStart().length;

            if (afterColon === '|' || afterColon === '>') {
                const result = this.parseMultilineString(lines, i, currentIndent, afterColon === '|');
                vars[key] = result.value;
                i = result.nextIndex;
            } else if (afterColon === '' || afterColon === '{}') {
                const result = this.parseNestedObject(lines, i, currentIndent);
                if (result.value && Object.keys(result.value).length > 0) {
                    vars[key] = result.value;
                } else {
                    vars[key] = '';
                }
                i = result.nextIndex;
            } else if (afterColon.startsWith('-') || (afterColon === '' && i + 1 < lines.length && lines[i + 1].trim().startsWith('-'))) {
                const result = this.parseArray(lines, i, currentIndent, afterColon.startsWith('-') ? afterColon : '');
                vars[key] = result.value;
                i = result.nextIndex;
            } else {
                let value = afterColon.replace(/^["']|["']$/g, '');
                if (/^\d+$/.test(value)) {
                    vars[key] = parseInt(value);
                } else if (/^\d+\.\d+$/.test(value)) {
                    vars[key] = parseFloat(value);
                } else {
                    vars[key] = value;
                }
                i++;
            }
        }

        return Object.keys(vars).length ? vars : null;
    }

    static parsePartialYamlDirect(yamlContent) {
        const vars = {};
        const lines = yamlContent.split('\n');
        let i = 0;

        while (i < lines.length) {
            const line = lines[i];
            const trimmed = line.trim();

            if (!trimmed || trimmed.startsWith('#')) {
                i++;
                continue;
            }

            const colonIndex = trimmed.indexOf(':');
            if (colonIndex <= 0) {
                i++;
                continue;
            }

            const key = trimmed.substring(0, colonIndex).trim();
            const afterColon = trimmed.substring(colonIndex + 1).trim();
            const currentIndent = line.length - line.trimStart().length;

            if (afterColon === '|' || afterColon === '>') {
                const result = this.parsePartialMultilineString(lines, i, currentIndent, afterColon === '|');
                vars[key] = result.value;
                i = result.nextIndex;
            } else if (afterColon === '' || afterColon === '{}') {
                const result = this.parsePartialNestedObject(lines, i, currentIndent);
                if (result.value && Object.keys(result.value).length > 0) {
                    vars[key] = result.value;
                } else {
                    vars[key] = '';
                }
                i = result.nextIndex;
            } else if (afterColon.startsWith('-') || (afterColon === '' && i + 1 < lines.length && lines[i + 1].trim().startsWith('-'))) {
                const result = this.parsePartialArray(lines, i, currentIndent, afterColon.startsWith('-') ? afterColon : '');
                vars[key] = result.value;
                i = result.nextIndex;
            } else {
                let value = afterColon.replace(/^["']|["']$/g, '');
                if (/^\d+$/.test(value)) {
                    vars[key] = parseInt(value);
                } else if (/^\d+\.\d+$/.test(value)) {
                    vars[key] = parseFloat(value);
                } else {
                    vars[key] = value;
                }
                i++;
            }
        }

        return vars;
    }

    static parseMultilineString(lines, startIndex, baseIndent, preserveNewlines) {
        const contentLines = [];
        let i = startIndex + 1;

        while (i < lines.length) {
            const line = lines[i];
            const lineIndent = line.length - line.trimStart().length;

            if (line.trim() === '') {
                contentLines.push('');
                i++;
                continue;
            }

            if (lineIndent <= baseIndent && line.trim() !== '') {
                break;
            }

            contentLines.push(line.substring(baseIndent + 2));
            i++;
        }

        const value = preserveNewlines ? contentLines.join('\n') : contentLines.join(' ').replace(/\s+/g, ' ');
        return { value: value.trim(), nextIndex: i };
    }

    static parsePartialMultilineString(lines, startIndex, baseIndent, preserveNewlines) {
        const contentLines = [];
        let i = startIndex + 1;

        while (i < lines.length) {
            const line = lines[i];
            const lineIndent = line.length - line.trimStart().length;

            if (line.trim() === '') {
                contentLines.push('');
                i++;
                continue;
            }

            if (lineIndent <= baseIndent && line.trim() !== '') {
                break;
            }

            contentLines.push(line.substring(Math.min(baseIndent + 2, line.length)));
            i++;
        }

        const value = preserveNewlines ? contentLines.join('\n') : contentLines.join(' ').replace(/\s+/g, ' ');
        return { value: value.trim(), nextIndex: i };
    }

    static parseNestedObject(lines, startIndex, baseIndent) {
        const obj = {};
        let i = startIndex + 1;

        while (i < lines.length) {
            const line = lines[i];
            const trimmed = line.trim();
            const lineIndent = line.length - line.trimStart().length;

            if (!trimmed || trimmed.startsWith('#')) {
                i++;
                continue;
            }

            if (lineIndent <= baseIndent) {
                break;
            }

            const colonIndex = trimmed.indexOf(':');
            if (colonIndex > 0) {
                const key = trimmed.substring(0, colonIndex).trim();
                const value = trimmed.substring(colonIndex + 1).trim();

                if (value === '|' || value === '>') {
                    const result = this.parseMultilineString(lines, i, lineIndent, value === '|');
                    obj[key] = result.value;
                    i = result.nextIndex;
                } else if (value === '' || value === '{}') {
                    const result = this.parseNestedObject(lines, i, lineIndent);
                    obj[key] = result.value;
                    i = result.nextIndex;
                } else if (value.startsWith('-') || (value === '' && i + 1 < lines.length && lines[i + 1].trim().startsWith('-'))) {
                    const result = this.parseArray(lines, i, lineIndent, value.startsWith('-') ? value : '');
                    obj[key] = result.value;
                    i = result.nextIndex;
                } else {
                    let cleanValue = value.replace(/^["']|["']$/g, '');
                    if (/^\d+$/.test(cleanValue)) {
                        obj[key] = parseInt(cleanValue);
                    } else if (/^\d+\.\d+$/.test(cleanValue)) {
                        obj[key] = parseFloat(cleanValue);
                    } else {
                        obj[key] = cleanValue;
                    }
                    i++;
                }
            } else {
                i++;
            }
        }

        return { value: obj, nextIndex: i };
    }

    static parsePartialNestedObject(lines, startIndex, baseIndent) {
        const obj = {};
        let i = startIndex + 1;

        while (i < lines.length) {
            const line = lines[i];
            const trimmed = line.trim();
            const lineIndent = line.length - line.trimStart().length;

            if (!trimmed || trimmed.startsWith('#')) {
                i++;
                continue;
            }

            if (lineIndent <= baseIndent) {
                break;
            }

            const colonIndex = trimmed.indexOf(':');
            if (colonIndex > 0) {
                const key = trimmed.substring(0, colonIndex).trim();
                const value = trimmed.substring(colonIndex + 1).trim();

                if (value === '|' || value === '>') {
                    const result = this.parsePartialMultilineString(lines, i, lineIndent, value === '|');
                    obj[key] = result.value;
                    i = result.nextIndex;
                } else if (value === '' || value === '{}') {
                    const result = this.parsePartialNestedObject(lines, i, lineIndent);
                    obj[key] = result.value;
                    i = result.nextIndex;
                } else if (value.startsWith('-') || (value === '' && i + 1 < lines.length && lines[i + 1].trim().startsWith('-'))) {
                    const result = this.parsePartialArray(lines, i, lineIndent, value.startsWith('-') ? value : '');
                    obj[key] = result.value;
                    i = result.nextIndex;
                } else {
                    let cleanValue = value.replace(/^["']|["']$/g, '');
                    if (/^\d+$/.test(cleanValue)) {
                        obj[key] = parseInt(cleanValue);
                    } else if (/^\d+\.\d+$/.test(cleanValue)) {
                        obj[key] = parseFloat(cleanValue);
                    } else {
                        obj[key] = cleanValue;
                    }
                    i++;
                }
            } else {
                i++;
            }
        }

        return { value: obj, nextIndex: i };
    }

    static parseArray(lines, startIndex, baseIndent, firstItem) {
        const arr = [];
        let i = startIndex;

        if (firstItem.startsWith('-')) {
            const value = firstItem.substring(1).trim();
            if (value) {
                let cleanValue = value.replace(/^["']|["']$/g, '');
                if (/^\d+$/.test(cleanValue)) {
                    arr.push(parseInt(cleanValue));
                } else if (/^\d+\.\d+$/.test(cleanValue)) {
                    arr.push(parseFloat(cleanValue));
                } else {
                    arr.push(cleanValue);
                }
            }
            i++;
        }

        while (i < lines.length) {
            const line = lines[i];
            const trimmed = line.trim();
            const lineIndent = line.length - line.trimStart().length;

            if (!trimmed || trimmed.startsWith('#')) {
                i++;
                continue;
            }

            if (lineIndent <= baseIndent && !trimmed.startsWith('-')) {
                break;
            }

            if (trimmed.startsWith('-')) {
                const value = trimmed.substring(1).trim();
                if (value) {
                    let cleanValue = value.replace(/^["']|["']$/g, '');
                    if (/^\d+$/.test(cleanValue)) {
                        arr.push(parseInt(cleanValue));
                    } else if (/^\d+\.\d+$/.test(cleanValue)) {
                        arr.push(parseFloat(cleanValue));
                    } else {
                        arr.push(cleanValue);
                    }
                }
            }
            i++;
        }

        return { value: arr, nextIndex: i };
    }

    static parsePartialArray(lines, startIndex, baseIndent, firstItem) {
        const arr = [];
        let i = startIndex;

        if (firstItem.startsWith('-')) {
            const value = firstItem.substring(1).trim();
            if (value) {
                let cleanValue = value.replace(/^["']|["']$/g, '');
                if (/^\d+$/.test(cleanValue)) {
                    arr.push(parseInt(cleanValue));
                } else if (/^\d+\.\d+$/.test(cleanValue)) {
                    arr.push(parseFloat(cleanValue));
                } else {
                    arr.push(cleanValue);
                }
            }
            i++;
        }

        while (i < lines.length) {
            const line = lines[i];
            const trimmed = line.trim();
            const lineIndent = line.length - line.trimStart().length;

            if (!trimmed || trimmed.startsWith('#')) {
                i++;
                continue;
            }

            if (lineIndent <= baseIndent && !trimmed.startsWith('-')) {
                break;
            }

            if (trimmed.startsWith('-')) {
                const value = trimmed.substring(1).trim();
                if (value) {
                    let cleanValue = value.replace(/^["']|["']$/g, '');
                    if (/^\d+$/.test(cleanValue)) {
                        arr.push(parseInt(cleanValue));
                    } else if (/^\d+\.\d+$/.test(cleanValue)) {
                        arr.push(parseFloat(cleanValue));
                    } else {
                        arr.push(cleanValue);
                    }
                }
            }
            i++;
        }

        return { value: arr, nextIndex: i };
    }

    static isYamlFormat(content) {
        const trimmed = content.trim();
        return !trimmed.startsWith('{') && !trimmed.startsWith('[') &&
            trimmed.split('\n').some(line => {
                const t = line.trim();
                if (!t || t.startsWith('#')) return false;
                const colonIndex = t.indexOf(':');
                return colonIndex > 0 && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t.substring(0, colonIndex).trim());
            });
    }

    static isJsonFormat(content) {
        const trimmed = content.trim();
        return (trimmed.startsWith('{') || trimmed.startsWith('['));
    }

	static replaceVars(tmpl, vars) {
	    return tmpl?.replace(/\[\[([^\]]+)\]\]/g, (match, varName) => {
	        const cleanVarName = varName.trim();
	        let value = vars[cleanVarName];
	        
	        if (value === null || value === undefined) {
	            value = '';
	        } else if (Array.isArray(value)) {
	            value = value.join(', ');
	        } else if (typeof value === 'object') {
	            value = JSON.stringify(value);
	        } else {
	            value = String(value);
	        }
	        
	        return `<bdi data-xiaobaix-var="${cleanVarName}">${value}</bdi>`;
	    }) || '';
	}
}

class IframeManager {

static createWrapper(content) {
    let processed = content;
    try {
        const { substituteParams } = getContext() || {};
        if (typeof substituteParams === 'function') {
            processed = substituteParams(content);
        }
    } catch (e) {
        console.warn('[LittleWhiteBox] substituteParams 無法使用：', e);
    }

    const iframeId = `xiaobaix-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const wrapperHtml = `
        <div class="xiaobaix-iframe-wrapper" style="margin: 10px 0;">
            <iframe id="${iframeId}" class="xiaobaix-iframe"
                style="width:100%;border:none;background:transparent;overflow:hidden;margin:0;padding:0;display:block"
                frameborder="0" scrolling="no"></iframe>
        </div>
    `;

    setTimeout(() => {
        const iframe = document.getElementById(iframeId);
        if (iframe) this.writeContentToIframe(iframe, processed);
    }, 0);

    return wrapperHtml;
}

   static writeContentToIframe(iframe, content) {
       try {
           const script = `<script type="text/javascript">${this.getInlineScript()}</script>`;

           let wrapped = content;
           const insertPoints = [['</body>', script + '</body>'], ['</html>', script + '</html>']];

           for (const [point, replacement] of insertPoints) {
               if (content.includes(point)) {
                   wrapped = content.replace(point, replacement);
                   break;
               }
           }

           if (wrapped === content) {
               wrapped = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${content}${script}</body></html>`;
           }

           const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
           iframeDoc.open();
           iframeDoc.write(wrapped);
           iframeDoc.close();
       } catch (err) {
           console.error('[Template Editor] 寫入 iframe 內容失敗:', err);
       }
   }

    static getInlineScript() {
        return `
        window.STBridge = {
            sendMessageToST: (type, data = {}) => {
                try { window.parent.postMessage({ source: 'xiaobaix-iframe', type, ...data }, '*'); } catch(e) {}
            },
            updateHeight: function() {
                const height = document.body.scrollHeight;
                if (height > 0) this.sendMessageToST('resize', { height });
            }
        };

		window.updateTemplateVariables = function(variables) {
		    Object.entries(variables).forEach(([varName, value]) => {
		        const elements = document.querySelectorAll(\`[data-xiaobaix-var="\${varName}"]\`);
		        elements.forEach(el => {
		            if (value === null || value === undefined) {
		                el.textContent = '';
		            } else if (Array.isArray(value)) {
		                el.textContent = value.join(', ');
		            } else if (typeof value === 'object') {
		                el.textContent = JSON.stringify(value);
		            } else {
		                el.textContent = String(value);
		            }
		            el.style.display = '';
		        });
		    });
		
		    if (typeof window.updateAllData === 'function') {
		        window.updateAllData();
		    }
		
		    window.dispatchEvent(new Event('contentUpdated'));
		    window.STBridge.updateHeight();
		};

        window.STscript = async function(command) {
            return new Promise((resolve, reject) => {
                const id = Date.now() + Math.random().toString(36).substring(2);
                window.STBridge.sendMessageToST('runCommand', { command, id });

                const listener = e => {
                    if (e.data?.id === id && e.data?.source === 'xiaobaix-host') {
                        window.removeEventListener('message', listener);
                        e.data.type === 'commandResult' ? resolve(e.data.result) : reject(new Error(e.data.error));
                    }
                };

                window.addEventListener('message', listener);
                setTimeout(() => {
                    window.removeEventListener('message', listener);
                    reject(new Error('timeout'));
                }, 180000);
            });
        };

        function setup() {
            window.STBridge.updateHeight();
            new MutationObserver(() => window.STBridge.updateHeight())
                .observe(document.body, { attributes: true, childList: true, subtree: true });
        }

        document.readyState === 'loading' ?
            document.addEventListener('DOMContentLoaded', setup) : setup();`;
    }

   static async sendUpdate(messageId, vars) {
       const iframe = await this.waitForIframe(messageId);
       if (!iframe?.contentWindow) return;

       try {
           iframe.contentWindow.postMessage({
               type: 'VARIABLE_UPDATE',
               messageId,
               timestamp: Date.now(),
               variables: vars,
               source: 'xiaobaix-host'
           }, '*');
       } catch (error) {
           console.error(`[LittleWhiteBox] Failed to send iframe message:`, error);
       }
   }

   static async waitForIframe(messageId, maxAttempts = 20, delay = 50) {
       const selector = `#chat .mes[mesid="${messageId}"] iframe.xiaobaix-iframe`;
       const cachedIframe = state.getElement(selector);
       if (cachedIframe?.contentWindow && cachedIframe.contentDocument?.readyState === 'complete') {
           return cachedIframe;
       }

       return new Promise((resolve) => {
           const checkIframe = () => {
               const iframe = document.querySelector(selector);
               if (iframe?.contentWindow && iframe instanceof HTMLIFrameElement) {
                   var doc = iframe.contentDocument;
                   if (doc && doc.readyState === 'complete') {
                       resolve(iframe);
                   } else {
                       iframe.addEventListener('load', () => resolve(iframe), { once: true });
                   }
                   return true;
               }
               return false;
           };

           if (checkIframe()) return;

           const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
           if (!messageElement) {
               resolve(null);
               return;
           }

           const observer = new MutationObserver(() => {
               if (checkIframe()) observer.disconnect();
           });

           observer.observe(messageElement, { childList: true, subtree: true });
           setTimeout(() => { observer.disconnect(); resolve(null); }, maxAttempts * delay);
       });
   }

   static updateVariables(messageId, vars) {
       const selector = `#chat .mes[mesid="${messageId}"] iframe.xiaobaix-iframe`;
       const iframe = state.getElement(selector) || document.querySelector(selector);
       if (!iframe?.contentWindow) return;

       const update = () => {
           try {
               if (iframe.contentWindow.updateTemplateVariables) {
                   iframe.contentWindow.updateTemplateVariables(vars);
               }
           } catch (error) {
               console.error(`[LittleWhiteBox] Failed to update iframe variables:`, error);
           }
       };

       if (iframe.contentDocument?.readyState === 'complete') {
           update();
       } else {
           iframe.addEventListener('load', update, { once: true });
       }
   }
}

class MessageHandler {
    static async process(messageId) {
        if (!TemplateSettings.get().enabled) return;

        const ctx = getContext();
        const msg = ctx.chat?.[messageId];
        if (!msg || msg.force_avatar || msg.is_user || msg.is_system) return;

        const avatar = utils.getCharAvatar(msg);
        const tmplSettings = TemplateSettings.getCharTemplate(avatar);
        if (!tmplSettings) return;

        if (tmplSettings.skipFirstMessage && messageId === 0) return;

        if (tmplSettings.limitToRecentMessages) {
            const recentCount = tmplSettings.recentMessageCount || 5;
            const minMessageId = Math.max(0, ctx.chat.length - recentCount);
            if (messageId < minMessageId) {
                this.clearTemplate(messageId, msg);
                return;
            }
        }

        const vars = TemplateProcessor.extractVars(msg.mes, tmplSettings.customRegex);
        state.messageVariables.set(messageId, vars);
        this.updateHistory(messageId, vars);

        let displayText = TemplateProcessor.replaceVars(tmplSettings.template, vars);

        if (utils.isCustomTemplate(displayText)) {
            displayText = IframeManager.createWrapper(displayText);

            if (tmplSettings.limitToRecentMessages) {
                this.clearPreviousIframes(messageId, avatar);
            }

            setTimeout(() => IframeManager.updateVariables(messageId, vars), 300);
        }

        if (displayText) {
            msg.extra = msg.extra || {};
            msg.extra.display_text = displayText;
            updateMessageBlock(messageId, msg, { rerenderMessage: true });
        }

        setTimeout(async () => {
            await IframeManager.sendUpdate(messageId, vars);
        }, 300);
    }

    static clearPreviousIframes(currentMessageId, currentAvatar) {
        const ctx = getContext();
        if (!ctx.chat?.length) return;

        for (let i = currentMessageId - 1; i >= 0; i--) {
            const msg = ctx.chat[i];
            if (!msg || msg.is_system || msg.is_user) continue;

            const msgAvatar = utils.getCharAvatar(msg);
            if (msgAvatar !== currentAvatar) continue;

            const messageElement = document.querySelector(`#chat .mes[mesid="${i}"]`);
            const iframe = messageElement?.querySelector('iframe.xiaobaix-iframe');

            if (iframe) {
                console.log(`[LittleWhiteBox] Clearing previous iframe from message ${i}`);
                if (msg.extra?.display_text) {
                    delete msg.extra.display_text;
                    updateMessageBlock(i, msg, { rerenderMessage: true });
                }
                state.messageVariables.delete(i);
                state.variableHistory.delete(i);
                break;
            }
        }
    }

    static clearTemplate(messageId, msg) {
        if (msg.extra?.display_text) {
            delete msg.extra.display_text;
            updateMessageBlock(messageId, msg, { rerenderMessage: true });
        }
        state.messageVariables.delete(messageId);
        state.variableHistory.delete(messageId);
    }

    static updateHistory(messageId, variables) {
        const history = state.variableHistory.get(messageId) || new Map();
        Object.entries(variables).forEach(([varName, value]) => {
            const varHistory = history.get(varName) || [];
            if (!varHistory.length || varHistory[varHistory.length - 1] !== value) {
                varHistory.push(value);
                if (varHistory.length > 5) varHistory.shift();
            }
            history.set(varName, varHistory);
        });
        state.variableHistory.set(messageId, history);
    }

    static reapplyAll() {
        if (!TemplateSettings.get().enabled) return;

        const ctx = getContext();
        if (!ctx.chat?.length) return;

        this.clearAll();

        const messagesToProcess = ctx.chat.reduce((acc, msg, id) => {
            if (msg.is_system || msg.is_user) return acc;

            const avatar = utils.getCharAvatar(msg);
            const tmplSettings = TemplateSettings.getCharTemplate(avatar);
            if (!tmplSettings?.enabled || !tmplSettings?.template) return acc;

            if (tmplSettings.limitToRecentMessages) {
                const recentCount = tmplSettings.recentMessageCount || 5;
                const minMessageId = Math.max(0, ctx.chat.length - recentCount);
                if (id < minMessageId) return acc;
            }

            return [...acc, id];
        }, []);

        this.processBatch(messagesToProcess);
    }

    static processBatch(messageIds) {
        const processNextBatch = (deadline) => {
            while (messageIds.length > 0 && deadline.timeRemaining() > 0) {
                this.process(messageIds.shift());
            }
            if (messageIds.length > 0) {
                requestIdleCallback(processNextBatch);
            }
        };

        if ('requestIdleCallback' in window) {
            requestIdleCallback(processNextBatch);
        } else {
            const batchSize = 10;
            const processBatch = () => {
                messageIds.splice(0, batchSize).forEach(id => this.process(id));
                if (messageIds.length > 0) setTimeout(processBatch, 16);
            };
            processBatch();
        }
    }

    static clearAll() {
        const ctx = getContext();
        if (!ctx.chat?.length) return;

        ctx.chat.forEach((msg, id) => {
            if (msg.extra?.display_text) {
                delete msg.extra.display_text;
                state.pendingUpdates.set(id, () => updateMessageBlock(id, msg, { rerenderMessage: true }));
            }
        });

        if (state.pendingUpdates.size > 0) {
            requestAnimationFrame(() => {
                state.pendingUpdates.forEach((fn) => fn());
                state.pendingUpdates.clear();
            });
        }

        state.messageVariables.clear();
        state.variableHistory.clear();
    }

    static startStreamingCheck() {
        if (state.observers.streaming) return;

        state.observers.streaming = setInterval(() => {
            if (!state.isGenerating) return;

            const ctx = getContext();
            const lastId = ctx.chat?.length - 1;

            if (lastId < 0) return;

            const lastMsg = ctx.chat[lastId];

            if (lastMsg && !lastMsg.is_system && !lastMsg.is_user) {
                const avatar = utils.getCharAvatar(lastMsg);
                const tmplSettings = TemplateSettings.getCharTemplate(avatar);

                if (tmplSettings) {
                    this.process(lastId);
                }
            }
        }, 2000);
    }

    static stopStreamingCheck() {
        if (state.observers.streaming) {
            clearInterval(state.observers.streaming);
            state.observers.streaming = null;
            state.isGenerating = false;
        }
    }
}

const interceptor = {
    originalSetter: null,

    setup() {
        if (this.originalSetter) return;

        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
        if (!descriptor?.set) return;

        this.originalSetter = descriptor.set;

        Object.defineProperty(Element.prototype, 'innerHTML', {
            set(value) {
                if (TemplateSettings.get().enabled && this.classList?.contains('mes_text')) {
                    const mesElement = this.closest('.mes');
                    if (mesElement) {
                        const id = parseInt(mesElement.getAttribute('mesid'));
                        if (!isNaN(id)) {
                            const ctx = getContext();
                            const msg = ctx.chat?.[id];

                            if (msg && !msg.is_system && !msg.is_user) {
                                const avatar = utils.getCharAvatar(msg);
                                const tmplSettings = TemplateSettings.getCharTemplate(avatar);

                                if (tmplSettings && tmplSettings.skipFirstMessage && id === 0) {
                                    return;
                                }

                                if (tmplSettings) {
                                    if (tmplSettings.limitToRecentMessages) {
                                        const recentCount = tmplSettings.recentMessageCount || 5;
                                        const minMessageId = Math.max(0, ctx.chat.length - recentCount);

                                        if (id < minMessageId) {
                                            if (msg.extra?.display_text) delete msg.extra.display_text;
                                            interceptor.originalSetter.call(this, msg.mes || '');
                                            return;
                                        }
                                    }

                                    if (this.querySelector('.xiaobaix-iframe-wrapper')) return;

                                    const vars = TemplateProcessor.extractVars(msg.mes, tmplSettings.customRegex);
                                    state.messageVariables.set(id, vars);
                                    MessageHandler.updateHistory(id, vars);

                                    let displayText = TemplateProcessor.replaceVars(tmplSettings.template, vars);

                                    if (displayText?.trim()) {
                                        if (utils.isCustomTemplate(displayText)) {
                                            displayText = IframeManager.createWrapper(displayText);
                                            interceptor.originalSetter.call(this, displayText);
                                            setTimeout(() => IframeManager.updateVariables(id, vars), 150);
                                            return;
                                        } else {
                                            msg.extra = msg.extra || {};
                                            msg.extra.display_text = displayText;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                interceptor.originalSetter.call(this, value);
            },
            get: descriptor.get,
            enumerable: descriptor.enumerable,
            configurable: descriptor.configurable
        });
    }
};

const eventHandlers = {
    MESSAGE_UPDATED: id => setTimeout(() => MessageHandler.process(id), 150),
    MESSAGE_SWIPED: id => {
        MessageHandler.stopStreamingCheck();
        state.isStreamingCheckActive = false;
        setTimeout(() => {
            MessageHandler.process(id);
            const ctx = getContext();
            const msg = ctx.chat?.[id];
            if (msg && !msg.is_system && !msg.is_user) {
                const avatar = utils.getCharAvatar(msg);
                const tmplSettings = TemplateSettings.getCharTemplate(avatar);
                if (tmplSettings) {
                    const vars = TemplateProcessor.extractVars(msg.mes, tmplSettings.customRegex);
                    setTimeout(() => IframeManager.updateVariables(id, vars), 300);
                }
            }
        }, 150);
    },
    STREAM_TOKEN_RECEIVED: (id) => {
        if (!state.isStreamingCheckActive) {
            state.isStreamingCheckActive = true;
            state.isGenerating = true;
            MessageHandler.startStreamingCheck();
        }
    },
    GENERATION_ENDED: () => {
        MessageHandler.stopStreamingCheck();
        state.isStreamingCheckActive = false;
        const ctx = getContext();
        const lastId = ctx.chat?.length - 1;
        if (lastId >= 0) setTimeout(() => MessageHandler.process(lastId), 150);
    },
    CHAT_CHANGED: () => {
        state.clear();
        setTimeout(() => {
            updateStatus();
            MessageHandler.reapplyAll();
        }, 300);
    },
    CHARACTER_SELECTED: () => {
        state.clear();
        setTimeout(() => {
            updateStatus();
            MessageHandler.reapplyAll();
            checkEmbeddedTemplate();
        }, 300);
    }
};

function updateStatus() {
    const $status = $('#template_character_status');
    if (!$status.length) return;

    if (this_chid === undefined || !characters[this_chid]) {
        $status.removeClass('has-settings').addClass('no-character').text('请选择一个角色');
        return;
    }

    const name = characters[this_chid].name;
    const charSettings = TemplateSettings.getCurrentChar();

    if (charSettings.enabled && charSettings.template) {
        $status.removeClass('no-character').addClass('has-settings')
            .text(`${name} - 已启用模板功能`);
    } else {
        $status.removeClass('has-settings').addClass('no-character')
            .text(`${name} - 未设置模板`);
    }
}

async function openEditor() {
    if (this_chid === undefined || !characters[this_chid]) {
        toastr.error('请先选择一个角色');
        return;
    }

    const name = characters[this_chid].name;
    const response = await fetch(`${extensionFolderPath}/template-editor.html`);
    const $html = $(await response.text());

    const charSettings = TemplateSettings.getCurrentChar();

    $html.find('h3 strong').text(`模板编辑器 - ${name}`);
    $html.find('#fixed_text_template').val(charSettings.template);
    $html.find('#fixed_text_custom_regex').val(charSettings.customRegex || DEFAULT_CHAR_SETTINGS.customRegex);
    $html.find('#limit_to_recent_messages').prop('checked', charSettings.limitToRecentMessages || false);
    $html.find('#recent_message_count').val(charSettings.recentMessageCount || 5);
    $html.find('#skip_first_message').prop('checked', charSettings.skipFirstMessage || false);

    $html.find('#export_character_settings').on('click', () => {
        const data = {
            template: $html.find('#fixed_text_template').val() || '',
            customRegex: $html.find('#fixed_text_custom_regex').val() || DEFAULT_CHAR_SETTINGS.customRegex,
            limitToRecentMessages: $html.find('#limit_to_recent_messages').prop('checked'),
            recentMessageCount: parseInt(String($html.find('#recent_message_count').val())) || 5,
            skipFirstMessage: $html.find('#skip_first_message').prop('checked')
        };

        download(`xiaobai-template-${characters[this_chid].name}.json`, JSON.stringify(data, null, 2), 'text/plain');
        toastr.success('模板设置已导出');
    });

    $html.find('#import_character_settings').on('change', function(e) {
        var file = null;
        if (e.target && e.target instanceof HTMLInputElement && e.target.files) {
            file = e.target.files[0];
        }
        if (!file) return;

        var reader = new FileReader();
        reader.onload = function(e) {
            try {
                var result = e.target.result;
                var data = JSON.parse(typeof result === 'string' ? result : '');
                $html.find('#fixed_text_template').val(data.template || '');
                $html.find('#fixed_text_custom_regex').val(data.customRegex || DEFAULT_CHAR_SETTINGS.customRegex);
                $html.find('#limit_to_recent_messages').prop('checked', data.limitToRecentMessages || false);
                $html.find('#recent_message_count').val(data.recentMessageCount || 5);
                $html.find('#skip_first_message').prop('checked', data.skipFirstMessage || false);
                toastr.success('模板设置已导入');
            } catch {
                toastr.error('文件格式错误');
            }
        };
        reader.readAsText(file);
        if (e.target && e.target instanceof HTMLInputElement) e.target.value = '';
    });

    const result = await callGenericPopup($html, POPUP_TYPE.CONFIRM, '', { okButton: '保存', cancelButton: '取消' });

    if (result) {
        await TemplateSettings.saveCurrentChar({
            enabled: true,
            template: $html.find('#fixed_text_template').val() || '',
            customRegex: $html.find('#fixed_text_custom_regex').val() || DEFAULT_CHAR_SETTINGS.customRegex,
            limitToRecentMessages: $html.find('#limit_to_recent_messages').prop('checked'),
            recentMessageCount: parseInt(String($html.find('#recent_message_count').val())) || 5,
            skipFirstMessage: $html.find('#skip_first_message').prop('checked')
        });

        updateStatus();
        setTimeout(() => MessageHandler.reapplyAll(), 150);
        toastr.success(`已保存 ${name} 的模板设置`);
    }
}

function exportGlobal() {
    download('xiaobai-template-global-settings.json', JSON.stringify(TemplateSettings.get(), null, 2), 'text/plain');
    toastr.success('全局模板设置已导出');
}

function importGlobal(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = e => {
        try {
            const data = JSON.parse(typeof e.target.result === 'string' ? e.target.result : '');
            Object.assign(TemplateSettings.get(), data);
            saveSettingsDebounced();
            $("#xiaobaix_template_enabled").prop("checked", data.enabled);
            updateStatus();
            setTimeout(() => MessageHandler.reapplyAll(), 150);
            toastr.success('全局模板设置已导入');
        } catch {
            toastr.error('文件格式错误');
        }
    };
    reader.readAsText(file);
    event.target.value = '';
}

async function checkEmbeddedTemplate() {
    if (!this_chid || !characters[this_chid]) return;

    const character = characters[this_chid];
    const embeddedSettings = character.data?.extensions?.[TEMPLATE_MODULE_NAME];

    if (embeddedSettings?.enabled && embeddedSettings?.template) {
        setTimeout(() => {
            updateStatus();
            if (utils.isEnabled()) MessageHandler.reapplyAll();
        }, 150);
    }
}

function cleanup() {
    console.log(`[LittleWhiteBox] Cleaning up resources`);

    MessageHandler.stopStreamingCheck();

    state.observers.message?.disconnect();
    state.observers.message = null;

    if (interceptor.originalSetter) {
        Object.defineProperty(Element.prototype, 'innerHTML', {
            ...Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML'),
            set: interceptor.originalSetter
        });
        interceptor.originalSetter = null;
    }

    state.clear();
    state.variableHistory.clear();
}

function initTemplateEditor() {
    console.log(`[LittleWhiteBox] Initializing template editor`);

    const setupObserver = () => {
        if (state.observers.message) state.observers.message.disconnect();

        const chatElement = document.querySelector('#chat');
        if (!chatElement) return;

        state.observers.message = new MutationObserver(mutations => {
            if (!TemplateSettings.get().enabled) return;

            const newMessages = mutations.flatMap(function(mutation) {
                return Array.from(mutation.addedNodes)
                    .filter(function(node) { return node.nodeType === Node.ELEMENT_NODE && node instanceof Element && node.classList && node.classList.contains('mes'); })
                    .map(function(node) { return node instanceof Element && node.getAttribute && node.getAttribute('mesid') ? parseInt(node.getAttribute('mesid')) : NaN; })
                    .filter(function(id) { return !isNaN(id); });
            });

            if (newMessages.length > 0) {
                MessageHandler.processBatch(newMessages);
            }
        });

        state.observers.message.observe(chatElement, { childList: true, subtree: false });
    };

    Object.entries(eventHandlers).forEach(([event, handler]) => {
        if (event_types[event]) {
            eventSource.on(event_types[event], handler);
        }
    });

    document.addEventListener('xiaobaixEnabledChanged', function(event) {
        var enabled = (event && event['detail']) ? event['detail'].enabled : undefined;
        console.log(`[LittleWhiteBox] State changed: ${enabled}`);

        if (!enabled) {
            cleanup();
        } else {
            setTimeout(function() {
                if (TemplateSettings.get().enabled) {
                    interceptor.setup();
                    setupObserver();
                    MessageHandler.reapplyAll();
                }
            }, 150);
        }
    });

    $("#xiaobaix_template_enabled").on("input", e => {
        const enabled = $(e.target).prop('checked');
        TemplateSettings.get().enabled = enabled;
        saveSettingsDebounced();
        updateStatus();

        if (enabled) {
            interceptor.setup();
            setupObserver();
            setTimeout(() => MessageHandler.reapplyAll(), 150);
        } else {
            cleanup();
        }
    });

    $("#open_template_editor").on("click", openEditor);
    $("#export_template_settings").on("click", exportGlobal);
    $("#import_template_settings").on("click", () => $("#import_template_file").click());
    $("#import_template_file").on("change", importGlobal);

    $("#xiaobaix_template_enabled").prop("checked", TemplateSettings.get().enabled);
    updateStatus();

    if (typeof window['registerModuleCleanup'] === 'function') {
        window['registerModuleCleanup']('templateEditor', cleanup);
    }

    if (utils.isEnabled()) {
        setTimeout(() => {
            interceptor.setup();
            setupObserver();
            MessageHandler.reapplyAll();
        }, 600);
    }

    setTimeout(checkEmbeddedTemplate, 1200);
}

export {
    initTemplateEditor,
    TemplateSettings as templateSettings,
    updateStatus,
    openEditor,
    cleanup,
    checkEmbeddedTemplate,
    STscript
};