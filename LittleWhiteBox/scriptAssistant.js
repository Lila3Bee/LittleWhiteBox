import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { setExtensionPrompt, extension_prompt_types } from "../../../../script.js";
import { eventSource, event_types } from "../../../../script.js";

const EXT_ID = "LittleWhiteBox";
const SCRIPT_MODULE_NAME = "xiaobaix-script";
const extensionFolderPath = `scripts/extensions/third-party/${EXT_ID}`;

function initScriptAssistant() {
    if (!extension_settings[EXT_ID].scriptAssistant) {
        extension_settings[EXT_ID].scriptAssistant = { enabled: false };
    }

    if (window['registerModuleCleanup']) {
        window['registerModuleCleanup']('scriptAssistant', cleanup);
    }

    $('#xiaobaix_script_assistant').on('change', function() {
        let globalEnabled = true;
        try { if ('isXiaobaixEnabled' in window) globalEnabled = Boolean(window['isXiaobaixEnabled']); } catch {}
        if (!globalEnabled) return;

        const enabled = $(this).prop('checked');
        extension_settings[EXT_ID].scriptAssistant.enabled = enabled;
        saveSettingsDebounced();

        if (enabled) {
            if (typeof window['injectScriptDocs'] === 'function') window['injectScriptDocs']();
        } else {
            if (typeof window['removeScriptDocs'] === 'function') window['removeScriptDocs']();
            cleanup();
        }
    });

    $('#xiaobaix_script_assistant').prop('checked', extension_settings[EXT_ID].scriptAssistant.enabled);

    setupEventListeners();

    if (extension_settings[EXT_ID].scriptAssistant.enabled) {
        setTimeout(() => { if (typeof window['injectScriptDocs'] === 'function') window['injectScriptDocs'](); }, 1000);
    }
}

let eventHandlers = {};

function setupEventListeners() {
    eventHandlers.chatChanged = () => {
        setTimeout(() => checkAndInjectDocs(), 500);
    };
    eventHandlers.messageReceived = () => {
        checkAndInjectDocs();
    };
    eventHandlers.userMessageRendered = () => {
        checkAndInjectDocs();
    };
    eventHandlers.settingsLoadedAfter = () => {
        setTimeout(() => checkAndInjectDocs(), 1000);
    };
    eventHandlers.appReady = () => {
        setTimeout(() => checkAndInjectDocs(), 1500);
    };

    eventSource.on(event_types.CHAT_CHANGED, eventHandlers.chatChanged);
    eventSource.on(event_types.MESSAGE_RECEIVED, eventHandlers.messageReceived);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, eventHandlers.userMessageRendered);
    eventSource.on(event_types.SETTINGS_LOADED_AFTER, eventHandlers.settingsLoadedAfter);
    eventSource.on(event_types.APP_READY, eventHandlers.appReady);
}

function cleanup() {
    if (eventHandlers.chatChanged) {
        eventSource.removeListener(event_types.CHAT_CHANGED, eventHandlers.chatChanged);
    }
    if (eventHandlers.messageReceived) {
        eventSource.removeListener(event_types.MESSAGE_RECEIVED, eventHandlers.messageReceived);
    }
    if (eventHandlers.userMessageRendered) {
        eventSource.removeListener(event_types.USER_MESSAGE_RENDERED, eventHandlers.userMessageRendered);
    }
    if (eventHandlers.settingsLoadedAfter) {
        eventSource.removeListener(event_types.SETTINGS_LOADED_AFTER, eventHandlers.settingsLoadedAfter);
    }
    if (eventHandlers.appReady) {
        eventSource.removeListener(event_types.APP_READY, eventHandlers.appReady);
    }

    if (typeof window['removeScriptDocs'] === 'function') window['removeScriptDocs']();

    eventHandlers = {};
}

function checkAndInjectDocs() {
    const globalEnabled = window.isXiaobaixEnabled !== undefined ? window.isXiaobaixEnabled : extension_settings[EXT_ID].enabled;
    if (globalEnabled && extension_settings[EXT_ID].scriptAssistant?.enabled) {
        injectScriptDocs();
    } else {
        removeScriptDocs();
    }
}

async function injectScriptDocs() {
    try {
        let docsContent = '';

        try {
            const response = await fetch(`${extensionFolderPath}/scriptDocs.md`);
            if (response.ok) {
                docsContent = await response.text();
            }
        } catch (error) {
            docsContent = "无法加载scriptDocs.md文件";
        }

        const formattedPrompt = `
【小白X插件 - 写卡助手】
你是小白X插件的内置助手，专门帮助用户创建STscript脚本和交互式界面的角色卡。
以下是小白x功能和SillyTavern的官方STscript脚本文档，可结合小白X功能创作与SillyTavern深度交互的角色卡：
${docsContent}
`;

        setExtensionPrompt(
            SCRIPT_MODULE_NAME,
            formattedPrompt,
            extension_prompt_types.IN_PROMPT,
            2,
            false,
            0
        );
    } catch (error) {}
}

function removeScriptDocs() {
    setExtensionPrompt(SCRIPT_MODULE_NAME, '', extension_prompt_types.IN_PROMPT, 2, false, 0);
}

window.injectScriptDocs = injectScriptDocs;
window.removeScriptDocs = removeScriptDocs;

export { initScriptAssistant };
