import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, getRequestHeaders } from "../../../../script.js";
import { statsTracker } from "./relationship-metrics.js";
import { initTasks } from "./scheduledTasks.js";
import { initScriptAssistant } from "./scriptAssistant.js";
import { initMessagePreview, addHistoryButtonsDebounced } from "./message-preview.js";
import { initImmersiveMode } from "./immersive-mode.js";
import { initTemplateEditor, templateSettings } from "./template-editor.js";
import { initWallhavenBackground } from "./wallhaven-background.js";
import { initCharacterUpdater } from "./character-updater.js";

const EXT_ID = "LittleWhiteBox";
const EXT_NAME = "小白X";
const MODULE_NAME = "xiaobaix-memory";
const extensionFolderPath = `scripts/extensions/third-party/${EXT_ID}`;

extension_settings[EXT_ID] = extension_settings[EXT_ID] || {
    enabled: true,
    sandboxMode: false,
    memoryEnabled: true,
    memoryInjectEnabled: false,
    memoryInjectDepth: 4,
    recorded: { enabled: true },
    templateEditor: { enabled: true, characterBindings: {} },
    tasks: { enabled: true, globalTasks: [], processedMessages: [], character_allowed_tasks: [] },
    scriptAssistant: { enabled: false },
    preview: { enabled: false },
    wallhaven: { enabled: false },
    immersive: { enabled: false },
    characterUpdater: { enabled: true, showNotifications: true, serverUrl: "https://db.littlewhitebox.qzz.io" }
};

const settings = extension_settings[EXT_ID];
let isXiaobaixEnabled = settings.enabled;
let moduleInstances = { statsTracker: null };
let savedSettings = {};
let globalEventListeners = [];
let globalTimers = [];
let moduleCleanupFunctions = new Map();

window.isXiaobaixEnabled = isXiaobaixEnabled;

// 扩展更新检查相关变量
let updateCheckPerformed = false;

// 导出测试函数到全局作用域，方便调试
window.testLittleWhiteBoxUpdate = async function() {
    console.log('[小白X] 手动触发更新检查测试');
    updateCheckPerformed = false; // 重置标志
    await performExtensionUpdateCheck();
};

window.testUpdateUI = function() {
    console.log('[小白X] 手动触发UI更新测试');
    updateExtensionHeaderWithUpdateNotice();
};

/**
 * 获取扩展类型
 * @param {string} extensionName 扩展名称
 * @returns {string} 扩展类型
 */
function getExtensionType(extensionName) {
    // 检查扩展类型，第三方扩展通常是 'local' 类型
    // 但我们需要检查实际的扩展类型映射
    try {
        const context = getContext();
        console.log('[小白X] 获取上下文:', !!context);

        if (context && context.extensionTypes) {
            const extensionTypes = context.extensionTypes;
            console.log('[小白X] 可用扩展类型:', Object.keys(extensionTypes));

            const id = Object.keys(extensionTypes).find(id =>
                id === extensionName ||
                (id.startsWith('third-party') && id.endsWith(extensionName)) ||
                id === `third-party${extensionName}`
            );

            console.log('[小白X] 找到的扩展ID:', id);
            const type = id ? extensionTypes[id] : 'local';
            console.log('[小白X] 扩展类型:', type);
            return type;
        }
    } catch (error) {
        console.warn('[小白X] 无法获取扩展类型:', error);
    }
    console.log('[小白X] 使用默认类型: local');
    return 'local';
}

/**
 * 检查LittleWhiteBox扩展是否有可用更新
 * @returns {Promise<Object|null>} 版本信息或null
 */
async function checkLittleWhiteBoxUpdate() {
    try {
        // 根据SillyTavern的扩展发现机制，第三方扩展在全局目录中
        // 扩展名称应该是 'LittleWhiteBox'，类型是 'global'
        const requestBody = {
            extensionName: 'LittleWhiteBox',
            global: true, // 第三方扩展通常在全局目录中
        };

        console.log('[小白X] 发送版本检查请求:', requestBody);

        const response = await fetch('/api/extensions/version', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(requestBody),
        });

        console.log('[小白X] 响应状态:', response.status, response.statusText);

        if (!response.ok) {
            const errorText = await response.text();
            console.warn('[小白X] 版本检查失败:', response.statusText, '详细错误:', errorText);
            return null;
        }

        const data = await response.json();
        console.log('[小白X] 版本检查结果:', data);
        return data;
    } catch (error) {
        console.warn('[小白X] 更新检查失败:', error);
        return null;
    }
}

/**
 * 更新LittleWhiteBox扩展
 * @returns {Promise<boolean>} 更新是否成功
 */
async function updateLittleWhiteBoxExtension() {
    try {
        const requestBody = {
            extensionName: 'LittleWhiteBox',
            global: true, // 第三方扩展通常在全局目录中
        };

        console.log('[小白X] 发送更新请求:', requestBody);

        const response = await fetch('/api/extensions/update', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            const text = await response.text();
            console.error('[小白X] 更新失败:', response.status, response.statusText, text);
            toastr.error(text || response.statusText, '小白X更新失败', { timeOut: 5000 });
            return false;
        }

        const data = await response.json();

        if (data.isUpToDate) {
            toastr.success('小白X已是最新版本');
        } else {
            toastr.success(`小白X已更新到 ${data.shortCommitHash}`, '请刷新页面以应用更新');
        }

        return true;
    } catch (error) {
        console.error('[小白X] 更新错误:', error);
        toastr.error('更新过程中发生错误', '小白X更新失败');
        return false;
    }
}

/**
 * 更新扩展标题显示更新提示
 */
function updateExtensionHeaderWithUpdateNotice() {
    // 尝试多种选择器来找到小白X的标题元素
    const selectors = [
        '.inline-drawer-toggle.inline-drawer-header b',
        '.inline-drawer-header b',
        '.littlewhitebox .inline-drawer-header b',
        'div[class*="inline-drawer"] b'
    ];

    let headerElement = null;

    for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        for (const element of elements) {
            if (element.textContent && element.textContent.includes('小白X')) {
                headerElement = element;
                console.log('[小白X] 找到标题元素:', selector, element);
                break;
            }
        }
        if (headerElement) break;
    }

    if (!headerElement) {
        console.warn('[小白X] 未找到扩展标题元素');
        // 尝试延迟查找，可能DOM还没完全加载
        setTimeout(() => {
            console.log('[小白X] 延迟重试查找标题元素');
            updateExtensionHeaderWithUpdateNotice();
        }, 1000);
        return;
    }

    // 检查是否已经添加了更新提示
    if (headerElement.querySelector('#littlewhitebox-update-extension')) {
        console.log('[小白X] 更新提示已存在');
        return;
    }

    const updateSpan = document.createElement('span');
    updateSpan.id = 'littlewhitebox-update-extension';
    updateSpan.style.cssText = 'color: orange; cursor: pointer; margin-left: 5px;';
    updateSpan.textContent = '(有可用更新)';
    updateSpan.title = '点击更新小白X扩展';

    // 添加点击事件
    updateSpan.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        console.log('[小白X] 用户点击更新按钮');

        // 显示更新进度
        updateSpan.textContent = '(更新中...)';
        updateSpan.style.color = 'blue';
        updateSpan.style.cursor = 'wait';

        const success = await updateLittleWhiteBoxExtension();

        if (success) {
            // 更新成功，移除更新提示
            console.log('[小白X] 更新成功，移除更新提示');
            updateSpan.remove();
        } else {
            // 更新失败，恢复原状
            console.log('[小白X] 更新失败，恢复更新提示');
            updateSpan.textContent = '(有可用更新)';
            updateSpan.style.color = 'orange';
            updateSpan.style.cursor = 'pointer';
        }
    });

    headerElement.appendChild(updateSpan);
    console.log('[小白X] 已添加更新提示到标题');
}

/**
 * 执行扩展更新检查
 */
async function performExtensionUpdateCheck() {
    if (updateCheckPerformed) {
        console.log('[小白X] 更新检查已执行过，跳过');
        return; // 避免重复检查
    }

    updateCheckPerformed = true;

    try {
        console.log('[小白X] 开始检查扩展更新...');
        const versionData = await checkLittleWhiteBoxUpdate();

        if (versionData && versionData.isUpToDate === false) {
            console.log('[小白X] 发现可用更新，准备更新UI');
            updateExtensionHeaderWithUpdateNotice();
        } else if (versionData && versionData.isUpToDate === true) {
            console.log('[小白X] 扩展已是最新版本');
        } else {
            console.log('[小白X] 版本检查返回空结果');
        }
    } catch (error) {
        console.warn('[小白X] 更新检查过程中出现错误:', error);
    }
}

function registerModuleCleanup(moduleName, cleanupFunction) {
    moduleCleanupFunctions.set(moduleName, cleanupFunction);
}

function addGlobalEventListener(target, event, handler, options) {
    target.addEventListener(event, handler, options);
    globalEventListeners.push({ target, event, handler, options });
}

function addGlobalTimer(timerId) {
    globalTimers.push(timerId);
}

function cleanupAllResources() {
    globalEventListeners.forEach(({ target, event, handler, options, isEventSource }) => {
        try {
            if (isEventSource) {
                if (target.removeListener) {
                    target.removeListener(event, handler);
                }
            } else {
                target.removeEventListener(event, handler, options);
            }
        } catch (e) {
            console.warn('[小白X] 清理事件監聽器失敗:', e);
        }
    });
    globalEventListeners.length = 0;

    globalTimers.forEach(timerId => {
        try {
            clearTimeout(timerId);
            clearInterval(timerId);
        } catch (e) {
            console.warn('[小白X] 清理計時器失敗:', e);
        }
    });
    globalTimers.length = 0;

    moduleCleanupFunctions.forEach((cleanupFn, moduleName) => {
        try {
            cleanupFn();
        } catch (e) {
            console.warn(`[小白X] 清理模塊 ${moduleName} 失敗:`, e);
        }
    });
    moduleCleanupFunctions.clear();

    document.querySelectorAll('iframe.xiaobaix-iframe').forEach(iframe => iframe.remove());
    document.querySelectorAll('.xiaobaix-iframe-wrapper').forEach(wrapper => wrapper.remove());

    document.querySelectorAll('.memory-button, .mes_history_preview').forEach(btn => btn.remove());
    document.querySelectorAll('#message_preview_btn').forEach(btn => {
        if (btn instanceof HTMLElement) {
            btn.style.display = 'none';
        }
    });
}

async function waitForElement(selector, root = document, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const element = root.querySelector(selector);
        if (element) return element;
        await new Promise(r => setTimeout(r, 100));
    }
    return null;
}

function generateUniqueId() {
    return `xiaobaix-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function shouldRenderContent(content) {
    if (!content || typeof content !== 'string') return false;
    const htmlTags = ['<html', '<!DOCTYPE', '<script'];
    return htmlTags.some(tag => content.includes(tag));
}

function createIframeApi() {
    return `
    const originalGetElementById = document.getElementById;
    document.getElementById = function(id) {
        try {
            return originalGetElementById.call(document, id);
        } catch(e) {
            console.warn('Element not found:', id);
            return null;
        }
    };

    window.STBridge = {
        sendMessageToST: function(type, data = {}) {
            try {
                window.parent.postMessage({
                    source: 'xiaobaix-iframe',
                    type: type,
                    ...data
                }, '*');
            } catch(e) {}
        },

        updateHeight: function() {
            try {
                const height = document.body.scrollHeight;
                if (height > 0) {
                    this.sendMessageToST('resize', { height });
                }
            } catch(e) {}
        }
    };

    window.STscript = async function(command) {
        return new Promise((resolve, reject) => {
            try {
                const id = Date.now().toString() + Math.random().toString(36).substring(2);

                window.STBridge.sendMessageToST('runCommand', { command, id });

                const listener = function(event) {
                    if (!event.data || event.data.source !== 'xiaobaix-host') return;

                    const data = event.data;
                    if ((data.type === 'commandResult' || data.type === 'commandError') && data.id === id) {
                        window.removeEventListener('message', listener);

                        if (data.type === 'commandResult') {
                            resolve(data.result);
                        } else {
                            reject(new Error(data.error));
                        }
                    }
                };

                window.addEventListener('message', listener);

                setTimeout(() => {
                    window.removeEventListener('message', listener);
                    reject(new Error('Command timeout'));
                }, 180000);
            } catch(e) {
                reject(e);
            }
        });
    };

    function setupAutoResize() {
        window.STBridge.updateHeight();
        window.addEventListener('resize', () => window.STBridge.updateHeight());
        window.addEventListener('load', () => window.STBridge.updateHeight());
        try {
            const observer = new MutationObserver(() => window.STBridge.updateHeight());
            observer.observe(document.body, { attributes: true, childList: true, subtree: true, characterData: true });
        } catch(e) {}
        setInterval(() => window.STBridge.updateHeight(), 1000);
        window.addEventListener('load', function() {
            Array.from(document.images).forEach(img => {
                if (!img.complete) {
                    img.addEventListener('load', () => window.STBridge.updateHeight());
                    img.addEventListener('error', () => window.STBridge.updateHeight());
                }
            });
        });
    }

    function setupSecurity() {
        document.addEventListener('click', function(e) {
            const link = e.target.closest('a');
            if (link && link.href && link.href.startsWith('http')) {
                if (link.target !== '_blank') {
                    e.preventDefault();
                    window.open(link.href, '_blank');
                }
            }
        });
    }

    window.addEventListener('error', function(e) { return true; });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            setupAutoResize();
            setupSecurity();
        });
    } else {
        setupAutoResize();
        setupSecurity();
    }
    `;
}

async function executeSlashCommand(command) {
    try {
        if (!command) return { error: "命令为空" };
        if (!command.startsWith('/')) command = '/' + command;

        const { executeSlashCommands, substituteParams } = getContext();
        if (typeof executeSlashCommands !== 'function') {
            throw new Error("executeSlashCommands 函数不可用");
        }

        command = substituteParams(command);
        const result = await executeSlashCommands(command, true);

        if (result && typeof result === 'object' && result.pipe !== undefined) {
            const pipeValue = result.pipe;
            if (typeof pipeValue === 'string') {
                try { return JSON.parse(pipeValue); } catch { return pipeValue; }
            }
            return pipeValue;
        }

        if (typeof result === 'string' && result.trim()) {
            try { return JSON.parse(result); } catch { return result; }
        }

        return result === undefined ? "" : result;
    } catch (err) {
        throw err;
    }
}

function handleIframeMessage(event) {
    if (!event.data || event.data.source !== 'xiaobaix-iframe') return;

    const { type, height, command, id } = event.data;

    if (type === 'resize') {
        const iframes = document.querySelectorAll('iframe.xiaobaix-iframe');
        for (const iframe of iframes) {
            if (iframe.contentWindow === event.source) {
                iframe.style.height = `${height}px`;
                break;
            }
        }
    } else if (type === 'runCommand') {
        executeSlashCommand(command)
            .then(result => event.source.postMessage({
                source: 'xiaobaix-host', type: 'commandResult', id, result
            }, '*'))
            .catch(err => event.source.postMessage({
                source: 'xiaobaix-host', type: 'commandError', id, error: err.message || String(err)
            }, '*'));
    }
}

function prepareHtmlContent(htmlContent) {
    const apiScript = `<script>${createIframeApi()}</script>`;

    if (htmlContent.includes('<html') && htmlContent.includes('</html>')) {
        return htmlContent.replace('</head>', `${apiScript}</head>`);
    }

    const baseTemplate = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>body { margin: 0; padding: 10px; font-family: inherit; color: inherit; background: transparent; }</style>
    ${apiScript}
</head>`;

    if (htmlContent.includes('<body') && htmlContent.includes('</body>')) {
        return baseTemplate + htmlContent + '</html>';
    }

    return baseTemplate + `<body>${htmlContent}</body></html>`;
}

function renderHtmlInIframe(htmlContent, container, preElement) {
    try {
        const iframe = document.createElement('iframe');
        iframe.id = generateUniqueId();
        iframe.className = 'xiaobaix-iframe';
        iframe.style.cssText = `width: 100%; border: none; background: transparent; overflow: hidden; height: 0; margin: 0; padding: 0; display: block;`;
        iframe.setAttribute('frameborder', '0');
        iframe.setAttribute('scrolling', 'no');

        if (settings.sandboxMode) {
            iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-forms');
        }

        const wrapper = document.createElement('div');
        wrapper.className = 'xiaobaix-iframe-wrapper';
        wrapper.style.cssText = 'margin: 10px 0;';

        preElement.parentNode.insertBefore(wrapper, preElement);
        wrapper.appendChild(iframe);
        preElement.style.display = 'none';

        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        iframeDoc.open();
        try {
            iframeDoc.write(prepareHtmlContent(htmlContent));
        } catch (writeError) {
            iframeDoc.write(`<html><body><p>内容渲染出现问题，请检查HTML格式</p></body></html>`);
        }
        iframeDoc.close();
        return iframe;
    } catch (err) {
        return null;
    }
}

function toggleSettingsControls(enabled) {
    const controls = [
        'xiaobaix_sandbox', 'xiaobaix_memory_enabled', 'xiaobaix_memory_inject',
        'xiaobaix_memory_depth', 'xiaobaix_recorded_enabled', 'xiaobaix_preview_enabled',
        'xiaobaix_script_assistant', 'scheduled_tasks_enabled', 'xiaobaix_template_enabled',
        'wallhaven_enabled', 'wallhaven_bg_mode', 'wallhaven_category',
        'wallhaven_purity', 'wallhaven_opacity',
        'xiaobaix_immersive_enabled', 'character_updater_enabled'
    ];

    controls.forEach(id => {
        $(`#${id}`).prop('disabled', !enabled).closest('.flex-container').toggleClass('disabled-control', !enabled);
    });

    const styleId = 'xiaobaix-disabled-style';
    if (!enabled && !document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `.disabled-control, .disabled-control * { opacity: 0.4 !important; pointer-events: none !important; cursor: not-allowed !important; }`;
        document.head.appendChild(style);
    } else if (enabled) {
        document.getElementById(styleId)?.remove();
    }
}

function saveCurrentSettings() {
    savedSettings = {
        sandboxMode: settings.sandboxMode,
        memoryEnabled: settings.memoryEnabled,
        memoryInjectEnabled: settings.memoryInjectEnabled,
        memoryInjectDepth: settings.memoryInjectDepth,
        recordedEnabled: extension_settings[EXT_ID].recorded?.enabled,
        previewEnabled: extension_settings[EXT_ID].preview?.enabled,
        scriptAssistantEnabled: extension_settings[EXT_ID].scriptAssistant?.enabled,
        scheduledTasksEnabled: extension_settings[EXT_ID].tasks?.enabled,
        templateEnabled: extension_settings[EXT_ID].templateEditor?.enabled,
        characterUpdaterEnabled: extension_settings[EXT_ID].characterUpdater?.enabled
    };
}

function restoreSettings() {
    if (savedSettings.sandboxMode !== undefined) $("#xiaobaix_sandbox").prop("checked", savedSettings.sandboxMode);
    if (savedSettings.memoryEnabled !== undefined) $("#xiaobaix_memory_enabled").prop("checked", savedSettings.memoryEnabled);
    if (savedSettings.memoryInjectEnabled !== undefined) $("#xiaobaix_memory_inject").prop("checked", savedSettings.memoryInjectEnabled);
    if (savedSettings.memoryInjectDepth !== undefined) $("#xiaobaix_memory_depth").val(savedSettings.memoryInjectDepth);

    const moduleSettings = [
        { key: 'recordedEnabled', module: 'recorded', control: 'xiaobaix_recorded_enabled' },
        { key: 'previewEnabled', module: 'preview', control: 'xiaobaix_preview_enabled' },
        { key: 'scriptAssistantEnabled', module: 'scriptAssistant', control: 'xiaobaix_script_assistant' },
        { key: 'scheduledTasksEnabled', module: 'tasks', control: 'scheduled_tasks_enabled' },
        { key: 'templateEnabled', module: 'templateEditor', control: 'xiaobaix_template_enabled' },
        { key: 'characterUpdaterEnabled', module: 'characterUpdater', control: 'character_updater_enabled' }
    ];

    moduleSettings.forEach(({ key, module, control }) => {
        if (savedSettings[key] !== undefined) {
            if (!extension_settings[EXT_ID][module]) extension_settings[EXT_ID][module] = {};
            extension_settings[EXT_ID][module].enabled = savedSettings[key];
            $(`#${control}`).prop("checked", savedSettings[key]);
        }
    });

}

function toggleAllFeatures(enabled) {
    if (enabled) {
        restoreSettings();
        toggleSettingsControls(true);
        saveSettingsDebounced();
        setTimeout(() => processExistingMessages(), 100);
        setupEventListeners();

        if (settings.memoryEnabled && moduleInstances.statsTracker?.updateMemoryPrompt) setTimeout(() => moduleInstances.statsTracker.updateMemoryPrompt(), 200);
        if (extension_settings[EXT_ID].scriptAssistant?.enabled && window.injectScriptDocs) setTimeout(() => window.injectScriptDocs(), 300);
        if (extension_settings[EXT_ID].preview?.enabled) setTimeout(() => { document.querySelectorAll('#message_preview_btn').forEach(btn => btn.style.display = ''); }, 400);
        if (extension_settings[EXT_ID].recorded?.enabled) setTimeout(() => addHistoryButtonsDebounced(), 500);

        document.dispatchEvent(new CustomEvent('xiaobaixEnabledChanged', { detail: { enabled: true } }));
    } else {
        saveCurrentSettings();
        cleanupAllResources();

        if (window.messagePreviewCleanup) try { window.messagePreviewCleanup(); } catch (e) {}

        Object.assign(settings, { sandboxMode: false, memoryEnabled: false, memoryInjectEnabled: false });

        ['recorded', 'preview', 'scriptAssistant', 'tasks', 'immersive', 'templateEditor', 'wallhaven', 'characterUpdater'].forEach(module => {
            if (!extension_settings[EXT_ID][module]) extension_settings[EXT_ID][module] = {};
            extension_settings[EXT_ID][module].enabled = false;
        });

        ["xiaobaix_sandbox", "xiaobaix_memory_enabled", "xiaobaix_memory_inject",
         "xiaobaix_recorded_enabled", "xiaobaix_preview_enabled", "xiaobaix_script_assistant",
         "scheduled_tasks_enabled", "xiaobaix_template_enabled", "wallhaven_enabled",
         "xiaobaix_immersive_enabled", "character_updater_enabled"].forEach(id => $(`#${id}`).prop("checked", false));

        toggleSettingsControls(false);

        document.querySelectorAll('pre[data-xiaobaix-bound="true"]').forEach(pre => {
            pre.style.display = '';
            delete pre.dataset.xiaobaixBound;
        });

        moduleInstances.statsTracker?.removeMemoryPrompt?.();
        window.removeScriptDocs?.();

        document.dispatchEvent(new CustomEvent('xiaobaixEnabledChanged', { detail: { enabled: false } }));
    }
}

function processCodeBlocks(messageElement) {
    if (!settings.enabled || !isXiaobaixEnabled) return;
    try {
        const codeBlocks = messageElement.querySelectorAll('pre > code');
        codeBlocks.forEach(codeBlock => {
            const preElement = codeBlock.parentElement;
            if (preElement.dataset.xiaobaixBound === 'true') return;

            const oldIframe = preElement.parentNode.querySelector('iframe.xiaobaix-iframe');
            if (oldIframe) oldIframe.remove();
            const oldWrapper = preElement.parentNode.querySelector('.xiaobaix-iframe-wrapper');
            if (oldWrapper) oldWrapper.remove();

            preElement.dataset.xiaobaixBound = 'true';
            const codeContent = codeBlock.textContent || '';
            if (shouldRenderContent(codeContent)) {
                renderHtmlInIframe(codeContent, preElement.parentNode, preElement);
            }
        });
    } catch (err) {}
}

function processExistingMessages() {
    if (!settings.enabled || !isXiaobaixEnabled) return;
    document.querySelectorAll('.mes_text').forEach(processCodeBlocks);
    if (settings.memoryEnabled) {
        $('#chat .mes').each(function() {
            const messageId = $(this).attr('mesid');
            if (messageId) statsTracker.addMemoryButtonToMessage(messageId);
        });
    }
    if (templateSettings.get().enabled) {}
}

async function setupSettings() {
    try {
        const settingsContainer = await waitForElement("#extensions_settings");
        if (!settingsContainer) return;

        const response = await fetch(`${extensionFolderPath}/settings.html`);
        const settingsHtml = await response.text();
        $(settingsContainer).append(settingsHtml);

        $("#xiaobaix_enabled").prop("checked", settings.enabled).on("change", function() {
            const wasEnabled = settings.enabled;
            settings.enabled = $(this).prop("checked");
            isXiaobaixEnabled = settings.enabled;
            window.isXiaobaixEnabled = isXiaobaixEnabled;
            saveSettingsDebounced();
            if (settings.enabled !== wasEnabled) {
                toggleAllFeatures(settings.enabled);
            }
        });

        if (!settings.enabled) toggleSettingsControls(false);

        $("#xiaobaix_sandbox").prop("checked", settings.sandboxMode).on("change", function() {
            if (!isXiaobaixEnabled) return;
            settings.sandboxMode = $(this).prop("checked");
            saveSettingsDebounced();
        });

        $("#xiaobaix_memory_enabled").prop("checked", settings.memoryEnabled).on("change", function() {
            if (!isXiaobaixEnabled) return;
            settings.memoryEnabled = $(this).prop("checked");
            saveSettingsDebounced();
            if (!settings.memoryEnabled) {
                $('.memory-button').remove();
                statsTracker.removeMemoryPrompt();
            } else if (settings.memoryEnabled && settings.memoryInjectEnabled) {
                statsTracker.updateMemoryPrompt();
            }
        });

        $("#xiaobaix_memory_inject").prop("checked", settings.memoryInjectEnabled).on("change", function() {
            if (!isXiaobaixEnabled) return;
            settings.memoryInjectEnabled = $(this).prop("checked");
            saveSettingsDebounced();
            statsTracker.removeMemoryPrompt();
            if (settings.memoryEnabled && settings.memoryInjectEnabled) {
                statsTracker.updateMemoryPrompt();
            }
        });

        $("#xiaobaix_memory_depth").val(settings.memoryInjectDepth).on("change", function() {
            if (!isXiaobaixEnabled) return;
            settings.memoryInjectDepth = parseInt($(this).val()) || 2;
            saveSettingsDebounced();
            if (settings.memoryEnabled && settings.memoryInjectEnabled) {
                statsTracker.updateMemoryPrompt();
            }
        });

        $("#xiaobaix_recorded_enabled").prop("checked", settings.recorded?.enabled || false).on("change", function() {
            if (!isXiaobaixEnabled) return;
            const enabled = $(this).prop('checked');
            settings.recorded = extension_settings[EXT_ID].recorded || {};
            settings.recorded.enabled = enabled;
            extension_settings[EXT_ID].recorded = settings.recorded;
            saveSettingsDebounced();
        });

        $('#xiaobaix_immersive_enabled').prop("checked", settings.immersive?.enabled || false).on('change', function() {
            if (!isXiaobaixEnabled) return;
            const enabled = $(this).prop('checked');
            settings.immersive = extension_settings[EXT_ID].immersive || {};
            settings.immersive.enabled = enabled;
            extension_settings[EXT_ID].immersive = settings.immersive;
            saveSettingsDebounced();
            if (moduleCleanupFunctions.has('immersiveMode')) moduleCleanupFunctions.get('immersiveMode')();
            if (enabled) initImmersiveMode();
        });

        $('#xiaobaix_preview_enabled').prop("checked", settings.preview?.enabled || false).on('change', function() {
            if (!isXiaobaixEnabled) return;
            const enabled = $(this).prop('checked');
            settings.preview = extension_settings[EXT_ID].preview || {};
            settings.preview.enabled = enabled;
            extension_settings[EXT_ID].preview = settings.preview;
            saveSettingsDebounced();
            if (moduleCleanupFunctions.has('messagePreview')) moduleCleanupFunctions.get('messagePreview')();
            if (enabled) initMessagePreview();
        });

        $('#xiaobaix_script_assistant').prop("checked", settings.scriptAssistant?.enabled || false).on('change', function() {
            if (!isXiaobaixEnabled) return;
            const enabled = $(this).prop('checked');
            settings.scriptAssistant = extension_settings[EXT_ID].scriptAssistant || {};
            settings.scriptAssistant.enabled = enabled;
            extension_settings[EXT_ID].scriptAssistant = settings.scriptAssistant;
            saveSettingsDebounced();
            if (moduleCleanupFunctions.has('scriptAssistant')) moduleCleanupFunctions.get('scriptAssistant')();
            if (enabled) initScriptAssistant();
        });

        $('#scheduled_tasks_enabled').prop("checked", settings.tasks?.enabled || false).on('change', function() {
            if (!isXiaobaixEnabled) return;
            const enabled = $(this).prop('checked');
            settings.tasks = extension_settings[EXT_ID].tasks || {};
            settings.tasks.enabled = enabled;
            extension_settings[EXT_ID].tasks = settings.tasks;
            saveSettingsDebounced();
            if (moduleCleanupFunctions.has('scheduledTasks')) moduleCleanupFunctions.get('scheduledTasks')();
            if (enabled) initTasks();
        });

        $('#xiaobaix_template_enabled').prop("checked", settings.templateEditor?.enabled || false).on('change', function() {
            if (!isXiaobaixEnabled) return;
            const enabled = $(this).prop('checked');
            settings.templateEditor = extension_settings[EXT_ID].templateEditor || {};
            settings.templateEditor.enabled = enabled;
            extension_settings[EXT_ID].templateEditor = settings.templateEditor;
            saveSettingsDebounced();
            if (moduleCleanupFunctions.has('templateEditor')) moduleCleanupFunctions.get('templateEditor')();
            if (enabled) initTemplateEditor();
        });

        $('#wallhaven_enabled').prop("checked", settings.wallhaven?.enabled || false).on('change', function() {
            if (!isXiaobaixEnabled) return;
            const enabled = $(this).prop('checked');
            settings.wallhaven = extension_settings[EXT_ID].wallhaven || {};
            settings.wallhaven.enabled = enabled;
            extension_settings[EXT_ID].wallhaven = settings.wallhaven;
            saveSettingsDebounced();
            if (moduleCleanupFunctions.has('wallhavenBackground')) moduleCleanupFunctions.get('wallhavenBackground')();
            if (enabled) initWallhavenBackground();
        });

        $('#character_updater_enabled').prop("checked", settings.characterUpdater?.enabled ?? true).on('change', function() {
            if (!isXiaobaixEnabled) return;
            const enabled = $(this).prop('checked');
            settings.characterUpdater = extension_settings[EXT_ID].characterUpdater || {};
            settings.characterUpdater.enabled = enabled;
            // Automatically manage notifications: enabled when module is enabled, disabled when module is disabled
            settings.characterUpdater.showNotifications = enabled;
            saveSettingsDebounced();
            if (moduleCleanupFunctions.has('characterUpdater')) {
                moduleCleanupFunctions.get('characterUpdater')();
                moduleCleanupFunctions.delete('characterUpdater');
            }
            if (enabled) initCharacterUpdater();
        });

    } catch (err) {}
}

function setupMenuTabs() {
    $(document).on('click', '.menu-tab', function() {
        const targetId = $(this).attr('data-target');
        $('.menu-tab').removeClass('active');
        $('.settings-section').hide();
        $(this).addClass('active');
        $('.' + targetId).show();
    });

    setTimeout(() => {
        $('.js-memory').show();
        $('.task, .instructions').hide();
        $('.menu-tab[data-target="js-memory"]').addClass('active');
        $('.menu-tab[data-target="task"], .menu-tab[data-target="instructions"]').removeClass('active');
    }, 300);
}

function setupEventListeners() {
    if (!isXiaobaixEnabled) return;

    const { eventSource, event_types } = getContext();

    const handleMessage = async (data, isReceived = false) => {
        if (!settings.enabled || !isXiaobaixEnabled) return;

        setTimeout(async () => {
            const messageId = typeof data === 'object' ? data.messageId : data;
            if (!messageId) return;

            const messageElement = document.querySelector(`div.mes[mesid="${messageId}"] .mes_text`);
            if (!messageElement) return;

            processCodeBlocks(messageElement);

            if (settings.memoryEnabled) {
                statsTracker.addMemoryButtonToMessage(messageId);

                if (isReceived) {
                    await statsTracker.updateStatisticsForNewMessage();
                    $(`.mes[mesid="${messageId}"] .memory-button`).addClass('has-memory');
                }
            }
        }, isReceived ? 300 : 100);
    };

    const messageReceivedHandler = (data) => handleMessage(data, true);
    eventSource.on(event_types.MESSAGE_RECEIVED, messageReceivedHandler);
    globalEventListeners.push({ target: eventSource, event: event_types.MESSAGE_RECEIVED, handler: messageReceivedHandler, isEventSource: true });

    eventSource.on(event_types.USER_MESSAGE_RENDERED, handleMessage);
    globalEventListeners.push({ target: eventSource, event: event_types.USER_MESSAGE_RENDERED, handler: handleMessage, isEventSource: true });

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, handleMessage);
    globalEventListeners.push({ target: eventSource, event: event_types.CHARACTER_MESSAGE_RENDERED, handler: handleMessage, isEventSource: true });

    if (event_types.MESSAGE_SWIPED) {
        eventSource.on(event_types.MESSAGE_SWIPED, handleMessage);
        globalEventListeners.push({ target: eventSource, event: event_types.MESSAGE_SWIPED, handler: handleMessage, isEventSource: true });
    }
    if (event_types.MESSAGE_EDITED) {
        eventSource.on(event_types.MESSAGE_EDITED, handleMessage);
        globalEventListeners.push({ target: eventSource, event: event_types.MESSAGE_EDITED, handler: handleMessage, isEventSource: true });
    }
    if (event_types.MESSAGE_UPDATED) {
        eventSource.on(event_types.MESSAGE_UPDATED, handleMessage);
        globalEventListeners.push({ target: eventSource, event: event_types.MESSAGE_UPDATED, handler: handleMessage, isEventSource: true });
    }

    const chatChangedHandler = async () => {
        if (!isXiaobaixEnabled) return;

        const timer1 = setTimeout(() => processExistingMessages(), 200);
        addGlobalTimer(timer1);

        if (!settings.memoryEnabled) return;
        const timer2 = setTimeout(async () => {
            try {
                let stats = await executeSlashCommand('/getvar xiaobaix_stats');

                if (!stats || stats === "undefined") {
                    const messagesText = await executeSlashCommand('/messages names=on');
                    if (messagesText) {
                        const newStats = statsTracker.dataManager.createEmptyStats();

                        const messageBlocks = messagesText.split('\n\n');
                        for (const block of messageBlocks) {
                            const colonIndex = block.indexOf(':');
                            if (colonIndex !== -1) {
                                const name = block.substring(0, colonIndex).trim();
                                const content = block.substring(colonIndex + 1).trim();

                                if (name !== getContext().name1 && content) {
                                    statsTracker.textAnalysis.updateStatsFromText(newStats, content, name);
                                }
                            }
                        }

                        await executeSlashCommand(`/setvar key=xiaobaix_stats ${JSON.stringify(newStats)}`);
                        if (settings.memoryInjectEnabled) statsTracker.updateMemoryPrompt();
                    }
                } else if (settings.memoryInjectEnabled) {
                    statsTracker.updateMemoryPrompt();
                }
            } catch (error) {}
        }, 500);
        addGlobalTimer(timer2);
    };

    eventSource.on(event_types.CHAT_CHANGED, chatChangedHandler);
    globalEventListeners.push({ target: eventSource, event: event_types.CHAT_CHANGED, handler: chatChangedHandler, isEventSource: true });

    addGlobalEventListener(window, 'message', handleIframeMessage);
}

window.processExistingMessages = processExistingMessages;
window.renderHtmlInIframe = renderHtmlInIframe;
window.registerModuleCleanup = registerModuleCleanup;
window.addGlobalEventListener = addGlobalEventListener;
window.addGlobalTimer = addGlobalTimer;

jQuery(async () => {
    try {
        isXiaobaixEnabled = settings.enabled;
        window.isXiaobaixEnabled = isXiaobaixEnabled;

        const response = await fetch(`${extensionFolderPath}/style.css`);
        const styleElement = document.createElement('style');
        styleElement.textContent = await response.text();
        document.head.appendChild(styleElement);

        moduleInstances.statsTracker = statsTracker;
        statsTracker.init(EXT_ID, MODULE_NAME, settings, executeSlashCommand);

        await setupSettings();
        if(isXiaobaixEnabled) setupEventListeners();

        // 监听app_ready事件以执行扩展更新检查
        eventSource.on(event_types.APP_READY, () => {
            // 延迟执行更新检查，确保UI完全加载
            setTimeout(performExtensionUpdateCheck, 2000);
        });

        if (isXiaobaixEnabled){
            if (settings.tasks?.enabled) initTasks();
            if (settings.scriptAssistant?.enabled) initScriptAssistant();
            if (settings.immersive?.enabled) initImmersiveMode();
            if (settings.templateEditor?.enabled) initTemplateEditor();
            if (settings.wallhaven?.enabled) initWallhavenBackground();
            if (settings.characterUpdater?.enabled) initCharacterUpdater();
            if (settings.preview?.enabled || settings.recorded?.enabled) {
                const timer2 = setTimeout(initMessagePreview, 1500);
                addGlobalTimer(timer2);
            }
        }

        const timer1 = setTimeout(setupMenuTabs, 500);
        addGlobalTimer(timer1);

        addGlobalTimer(setTimeout(() => {
            if (window.messagePreviewCleanup) {
                registerModuleCleanup('messagePreview', window.messagePreviewCleanup);
            }
        }, 2000));

        const timer3 = setTimeout(async () => {
            if (isXiaobaixEnabled) {
                processExistingMessages();
                if (settings.memoryEnabled) {
                    const messages = await statsTracker.dataManager.processMessageHistory();
                    if (messages?.length > 0) {
                        const stats = statsTracker.dataManager.createEmptyStats();
                        messages.forEach(message => {
                            statsTracker.textAnalysis.updateStatsFromText(stats, message.content, message.name);
                        });
                        await executeSlashCommand(`/setvar key=xiaobaix_stats ${JSON.stringify(stats)}`);
                        if (settings.memoryInjectEnabled) statsTracker.updateMemoryPrompt();
                    }
                }
            }
        }, 1000);
        addGlobalTimer(timer3);

        const intervalId = setInterval(() => {
            if (isXiaobaixEnabled) processExistingMessages();
        }, 5000);
        addGlobalTimer(intervalId);

    } catch (err) {}
});

export { executeSlashCommand };
