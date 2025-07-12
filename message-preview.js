import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";
import { callGenericPopup, POPUP_TYPE } from "../../../popup.js";

const EXT_ID = "LittleWhiteBox";
const CONSTANTS = {
    MAX_HISTORY_RECORDS: 10,
    CHECK_INTERVAL: 200,
    DEBOUNCE_DELAY: 300,
    CLEANUP_INTERVAL: 300000,
    TARGET_ENDPOINT: '/api/backends/chat-completions/generate',
    DEFAULT_TIMEOUT_SECONDS: 30,
    MESSAGE_ASSOCIATION_DELAY: 1000,
    RECENT_REQUEST_WINDOW: 30000
};

let state = {
    isPreviewMode: false,
    isLongInterceptMode: false,
    isInterceptorActive: false,
    capturedPreviewData: null,
    originalFetch: null,
    previewMessageIds: new Set(),
    apiRequestHistory: [],
    eventListeners: [],
    previewPromiseResolve: null,
    previewPromiseReject: null,
    sendButtonState: { wasDisabled: false },
    longPressTimer: null,
    longPressDelay: 1000,
    interceptedMessageIds: [],
    chatLengthBeforeIntercept: 0,
    longInterceptRestoreFunction: null,
    cleanupTimer: null,
    previewAbortController: null
};

function getSettings() {
    if (!extension_settings[EXT_ID]) {
        extension_settings[EXT_ID] = {
            preview: { enabled: false, timeoutSeconds: CONSTANTS.DEFAULT_TIMEOUT_SECONDS },
            recorded: { enabled: true }
        };
    }
    const settings = extension_settings[EXT_ID];
    if (!settings.preview) settings.preview = { enabled: false, timeoutSeconds: CONSTANTS.DEFAULT_TIMEOUT_SECONDS };
    if (!settings.recorded) settings.recorded = { enabled: true };
    settings.preview.timeoutSeconds = CONSTANTS.DEFAULT_TIMEOUT_SECONDS;
    return settings;
}

function highlightXmlTags(text) {
    return typeof text === 'string' ?
        text.replace(/<([^>]+)>/g, '<span style="color:rgb(153, 153, 153); font-weight: bold;">&lt;$1&gt;</span>') :
        text;
}

function isTargetApiRequest(url, options = {}) {
    return url?.includes(CONSTANTS.TARGET_ENDPOINT) && options.body?.includes('"messages"');
}

function setupInterceptor() {
    if (state.isInterceptorActive) return;
    state.originalFetch = window.fetch;
    state.isInterceptorActive = true;

    window.fetch = function(url, options = {}) {
        if (isTargetApiRequest(url, options)) {
            if (state.isPreviewMode || state.isLongInterceptMode) {
                return handlePreviewInterception(url, options).catch(() =>
                    new Response(JSON.stringify({ error: { message: "拦截失败，请手动中止消息生成。" } }),
                    { status: 500, headers: { 'Content-Type': 'application/json' } })
                );
            } else {
                recordRealApiRequest(url, options);
                return state.originalFetch.call(window, url, options);
            }
        }
        return state.originalFetch.call(window, url, options);
    };
}

function restoreOriginalFetch() {
    if (state.originalFetch && state.isInterceptorActive) {
        window.fetch = state.originalFetch;
        state.originalFetch = null;
        state.isInterceptorActive = false;
    }
}

function manageSendButton(disable = true) {
    const $sendBtn = $('#send_but');
    if (disable) {
        state.sendButtonState.wasDisabled = $sendBtn.prop('disabled');
        $sendBtn.prop('disabled', true).off('click.preview-block').on('click.preview-block', e => {
            e.preventDefault();
            e.stopImmediatePropagation();
            return false;
        });
    } else {
        $sendBtn.prop('disabled', state.sendButtonState.wasDisabled).off('click.preview-block');
        state.sendButtonState.wasDisabled = false;
    }
}

function triggerSendSafely() {
    const $sendBtn = $('#send_but');
    const $textarea = $('#send_textarea');
    if (typeof $textarea.val() === 'string' && !$textarea.val().trim()) return false;

    const wasDisabled = $sendBtn.prop('disabled');
    $sendBtn.prop('disabled', false);
    $sendBtn[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    if (wasDisabled) $sendBtn.prop('disabled', true);
    return true;
}

function recordRealApiRequest(url, options) {
    try {
        const requestData = JSON.parse(options.body);
        const context = getContext();
        const userInput = extractUserInputFromMessages(requestData.messages || []);

        const historyItem = {
            url, method: options.method || 'POST', requestData,
            messages: requestData.messages || [], model: requestData.model || 'Unknown',
            timestamp: Date.now(), messageId: context.chat?.length || 0,
            characterName: context.characters?.[context.characterId]?.name || 'Unknown',
            userInput, isRealRequest: true
        };

        state.apiRequestHistory.unshift(historyItem);
        if (state.apiRequestHistory.length > CONSTANTS.MAX_HISTORY_RECORDS) {
            state.apiRequestHistory = state.apiRequestHistory.slice(0, CONSTANTS.MAX_HISTORY_RECORDS);
        }

        setTimeout(() => {
            if (state.apiRequestHistory[0] && !state.apiRequestHistory[0].associatedMessageId) {
                state.apiRequestHistory[0].associatedMessageId = context.chat?.length || 0;
            }
        }, CONSTANTS.MESSAGE_ASSOCIATION_DELAY);
    } catch (error) {}
}

async function handlePreviewInterception(url, options) {
    try {
        const requestData = JSON.parse(options.body);
        const userInput = extractUserInputFromMessages(requestData?.messages || []);

        state.capturedPreviewData = {
            url, method: options.method || 'POST', requestData,
            messages: requestData?.messages || [], model: requestData?.model || 'Unknown',
            timestamp: Date.now(), userInput, isPreview: true
        };

        if (state.isLongInterceptMode) {
            setTimeout(() => {
                displayPreviewResult(state.capturedPreviewData, userInput);
                if (state.longInterceptRestoreFunction) {
                    try { state.longInterceptRestoreFunction(); } catch (error) {}
                    const context = getContext();
                    state.chatLengthBeforeIntercept = context.chat?.length || 0;
                    state.longInterceptRestoreFunction = interceptMessageCreation();
                }
            }, 100);
        } else if (state.previewPromiseResolve) {
            state.previewPromiseResolve({ success: true, data: state.capturedPreviewData });
            state.previewPromiseResolve = state.previewPromiseReject = null;
        }

        return new Response(JSON.stringify({
            choices: [{ message: { content: "" }, finish_reason: "stop" }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    } catch (error) {
        if (state.previewPromiseReject) {
            state.previewPromiseReject(error);
            state.previewPromiseResolve = state.previewPromiseReject = null;
        }
        throw error;
    }
}

function interceptMessageCreation() {
    const context = getContext();
    const originalPush = context.chat.push;
    const chatLengthBefore = context.chat.length;

    context.chat.push = function(...items) {
        if (state.isPreviewMode || state.isLongInterceptMode) {
            const startId = this.length;
            const result = originalPush.apply(this, items);
            for (let i = 0; i < items.length; i++) {
                const messageId = startId + i;
                state.previewMessageIds.add(messageId);
                if (state.isPreviewMode) recordInterceptedMessage(messageId);
            }
            return result;
        }
        return originalPush.apply(this, items);
    };

    const originalAppendChild = Element.prototype.appendChild;
    const originalInsertBefore = Element.prototype.insertBefore;

    Element.prototype.appendChild = function(child) {
        return (state.isPreviewMode || state.isLongInterceptMode) && child?.classList?.contains('mes') ?
            child : originalAppendChild.call(this, child);
    };

    Element.prototype.insertBefore = function(child, ref) {
        return (state.isPreviewMode || state.isLongInterceptMode) && child?.classList?.contains('mes') ?
            child : originalInsertBefore.call(this, child, ref);
    };

    return function restore() {
        context.chat.push = originalPush;
        Element.prototype.appendChild = originalAppendChild;
        Element.prototype.insertBefore = originalInsertBefore;

        if (state.previewMessageIds.size > 0) {
            const idsToDelete = Array.from(state.previewMessageIds).sort((a, b) => b - a);
            idsToDelete.forEach(id => {
                if (id < context.chat.length) context.chat.splice(id, 1);
                $(`#chat .mes[mesid="${id}"]`).remove();
            });
            while (context.chat.length > chatLengthBefore) context.chat.pop();
            state.previewMessageIds.clear();
        }
    };
}

function extractUserInputFromMessages(messages) {
    if (!Array.isArray(messages)) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') return messages[i].content || '';
    }
    return '';
}

function waitForPreviewInterception() {
    const settings = getSettings();
    const timeoutMs = settings.preview.timeoutSeconds * 1000;

    return new Promise((resolve, reject) => {
        state.previewPromiseResolve = resolve;
        state.previewPromiseReject = reject;

        const timeoutId = setTimeout(() => {
            if (state.previewPromiseResolve) {
                state.previewPromiseResolve({ success: false, error: `等待超时 (${settings.preview.timeoutSeconds}秒)` });
                state.previewPromiseResolve = state.previewPromiseReject = null;
            }
        }, timeoutMs);

        const originalResolve = state.previewPromiseResolve;
        const originalReject = state.previewPromiseReject;

        state.previewPromiseResolve = (value) => { clearTimeout(timeoutId); if (originalResolve) originalResolve(value); };
        state.previewPromiseReject = (error) => { clearTimeout(timeoutId); if (originalReject) originalReject(error); };
    });
}

async function showMessagePreview() {
    let restoreMessageCreation = null, loadingToast = null, userMessageBackup = null;

    try {
        const settings = getSettings();
        let globalEnabled = true;
        try { if ('isXiaobaixEnabled' in window) globalEnabled = Boolean(window['isXiaobaixEnabled']); } catch {}
        if (!settings.preview.enabled || !globalEnabled) {
            toastr.warning('消息拦截功能未启用');
            return;
        }

        const textareaText = String($('#send_textarea').val()).trim();
        if (!textareaText) {
            toastr.error('请先输入消息内容');
            return;
        }

        userMessageBackup = textareaText;
        manageSendButton(true);
        state.isPreviewMode = true;
        state.capturedPreviewData = null;
        state.previewMessageIds.clear();
        state.previewAbortController = new AbortController();
        restoreMessageCreation = interceptMessageCreation();

        loadingToast = toastr.info(`正在拦截请求...（${settings.preview.timeoutSeconds}秒超时）`, '消息拦截', {
            timeOut: 0, tapToDismiss: false
        });

        if (!triggerSendSafely()) throw new Error('无法触发发送事件');

        const result = await waitForPreviewInterception().catch(error => ({ success: false, error: error.message }));

        if (loadingToast) { toastr.clear(loadingToast); loadingToast = null; }

        if (result.success) {
            await displayPreviewResult(result.data, textareaText);
            toastr.success('拦截成功！', '', { timeOut: 3000 });
        } else {
            toastr.error(`拦截失败: ${result.error}`, '', { timeOut: 5000 });
        }

    } catch (error) {
        if (loadingToast) { toastr.clear(loadingToast); loadingToast = null; }
        toastr.error(`拦截异常: ${error.message}`, '', { timeOut: 5000 });
    } finally {
        if (state.previewAbortController) {
            try { state.previewAbortController.abort('拦截结束'); } catch (abortError) {}
            state.previewAbortController = null;
        }
        if (state.previewPromiseResolve) {
            state.previewPromiseResolve({ success: false, error: '拦截已取消' });
        }
        state.previewPromiseResolve = state.previewPromiseReject = null;
        if (restoreMessageCreation) {
            try { restoreMessageCreation(); } catch (cleanupError) {}
        }
        state.isPreviewMode = false;
        state.capturedPreviewData = null;
        manageSendButton(false);
        if (userMessageBackup) $('#send_textarea').val(userMessageBackup);
    }
}

async function displayPreviewResult(data, userInput) {
    try {
        const formattedContent = formatPreviewContent(data, userInput, false);
        const popupContent = `<div class="message-preview-container"><div class="message-preview-content-box">${formattedContent}</div></div>`;
        await callGenericPopup(popupContent, POPUP_TYPE.TEXT, '消息拦截', { wide: true, large: true });
    } catch (error) {
        toastr.error('显示拦截失败');
    }
}

function findApiRequestForMessage(messageId) {
    if (state.apiRequestHistory.length === 0) return null;

    const strategies = [
        record => record.associatedMessageId === messageId,
        record => record.messageId === messageId,
        record => record.messageId === messageId - 1,
        record => Math.abs(record.messageId - messageId) <= 1
    ];

    for (const strategy of strategies) {
        const match = state.apiRequestHistory.find(strategy);
        if (match) return match;
    }

    const candidates = state.apiRequestHistory.filter(record => record.messageId <= messageId + 2);
    return candidates.length > 0 ? candidates.sort((a, b) => b.messageId - a.messageId)[0] : state.apiRequestHistory[0];
}

async function showMessageHistoryPreview(messageId) {
    try {
        const settings = getSettings();
        let globalEnabled = true;
        try { if ('isXiaobaixEnabled' in window) globalEnabled = Boolean(window['isXiaobaixEnabled']); } catch {}
        if (!settings.recorded.enabled || !globalEnabled) return;

        const apiRecord = findApiRequestForMessage(messageId);
        if (apiRecord?.messages?.length > 0) {
            const messageData = { ...apiRecord, isHistoryPreview: true, targetMessageId: messageId };
            const formattedContent = formatPreviewContent(messageData, messageData.userInput, true);
            const popupContent = `<div class="message-preview-container"><div class="message-preview-content-box">${formattedContent}</div></div>`;
            await callGenericPopup(popupContent, POPUP_TYPE.TEXT, `消息历史查看 - 第 ${messageId + 1} 条消息`, { wide: true, large: true });
        } else {
            toastr.warning(`未找到第 ${messageId + 1} 条消息的API请求记录`);
        }
    } catch (error) {
        toastr.error('查看历史消息失败');
    }
}

function formatPreviewContent(data, userInput, isHistory = false) {
    return formatMessagesArray(data.messages);
}

function formatMessagesArray(messages) {
    let content = `↓酒馆日志↓(已整理好json格式使其更具可读性) (${messages.length}):\n${'-'.repeat(30)}\n`;

    messages.forEach((msg, index) => {
        const msgContent = msg.content || '';
        const roleMap = {
            system: { label: 'SYSTEM:', color: '#F7E3DA' },
            user: { label: 'USER:', color: '#F0ADA7' },
            assistant: { label: 'ASSISTANT:', color: '#6BB2CC' }
        };

        const role = roleMap[msg.role] || { label: `${msg.role.toUpperCase()}:`, color: '#FFF' };

        content += `<div style="color: ${role.color}; font-weight: bold; margin-top: ${index > 0 ? '15px' : '0'};">${role.label}</div>`;

        if (/<[^>]+>/g.test(msgContent)) {
            content += `<pre style="white-space: pre-wrap; margin: 5px 0; color: ${role.color};">${highlightXmlTags(msgContent)}</pre>`;
        } else {
            content += `<div style="margin: 5px 0; color: ${role.color}; white-space: pre-wrap;">${msgContent}</div>`;
        }
    });
    return content;
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => { clearTimeout(timeout); func(...args); };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

const addHistoryButtonsDebounced = debounce(() => {
    const settings = getSettings();
    let globalEnabled = true;
    try { if ('isXiaobaixEnabled' in window) globalEnabled = Boolean(window['isXiaobaixEnabled']); } catch {}
    if (!settings.recorded.enabled || !globalEnabled) return;

    $('.mes_history_preview').remove();
    $('#chat .mes').each(function() {
        const mesId = parseInt($(this).attr('mesid'));
        if (mesId <= 0) return;

        const flexContainer = $(this).find('.flex-container.flex1.alignitemscenter');
        if (flexContainer.length > 0) {
            const historyButton = $(`<div class="mes_btn mes_history_preview" title="查看历史API请求">
                                        <i class="fa-regular fa-note-sticky"></i>
                                     </div>`)
                .on('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    showMessageHistoryPreview(mesId);
                });
            flexContainer.append(historyButton);
        }
    });
}, CONSTANTS.DEBOUNCE_DELAY);

function cleanupMemory() {
    if (state.apiRequestHistory.length > CONSTANTS.MAX_HISTORY_RECORDS) {
        state.apiRequestHistory = state.apiRequestHistory.slice(0, CONSTANTS.MAX_HISTORY_RECORDS);
    }
    state.previewMessageIds.clear();
    state.capturedPreviewData = null;
    $('.mes_history_preview').each(function() {
        if (!$(this).closest('.mes').length) $(this).remove();
    });
    if (!state.isLongInterceptMode) state.interceptedMessageIds = [];
}

function addEventListeners() {
    removeEventListeners();

    const listeners = [
        { event: event_types.MESSAGE_RECEIVED, handler: addHistoryButtonsDebounced },
        { event: event_types.CHARACTER_MESSAGE_RENDERED, handler: addHistoryButtonsDebounced },
        { event: event_types.USER_MESSAGE_RENDERED, handler: addHistoryButtonsDebounced },
        {
            event: event_types.CHAT_CHANGED,
            handler: () => {
                state.apiRequestHistory = [];
                setTimeout(addHistoryButtonsDebounced, CONSTANTS.CHECK_INTERVAL);
            }
        },
        {
            event: event_types.MESSAGE_RECEIVED,
            handler: (messageId) => {
                setTimeout(() => {
                    const recentRequest = state.apiRequestHistory.find(record =>
                        !record.associatedMessageId && (Date.now() - record.timestamp) < CONSTANTS.RECENT_REQUEST_WINDOW
                    );
                    if (recentRequest) recentRequest.associatedMessageId = messageId;
                }, 100);
            }
        }
    ];

    listeners.forEach(({ event, handler }) => {
        eventSource.on(event, handler);
        state.eventListeners.push({ event, handler });
    });
}

function removeEventListeners() {
    state.eventListeners.forEach(({ event, handler }) => eventSource.removeListener(event, handler));
    state.eventListeners = [];
}

function cleanup() {
    if (state.cleanupTimer) { clearInterval(state.cleanupTimer); state.cleanupTimer = null; }
    removeEventListeners();
    restoreOriginalFetch();
    manageSendButton(false);
    $('.mes_history_preview').remove();
    $('#message_preview_btn').remove();
    cleanupMemory();

    Object.assign(state, {
        previewPromiseResolve: null, previewPromiseReject: null,
        isPreviewMode: false, isLongInterceptMode: false,
        interceptedMessageIds: [], chatLengthBeforeIntercept: 0,
        sendButtonState: { wasDisabled: false }
    });

    if (state.longPressTimer) { clearTimeout(state.longPressTimer); state.longPressTimer = null; }
    if (state.longInterceptRestoreFunction) {
        try { state.longInterceptRestoreFunction(); } catch (error) {}
        state.longInterceptRestoreFunction = null;
    }
}

function toggleLongInterceptMode() {
    state.isLongInterceptMode = !state.isLongInterceptMode;
    const $btn = $('#message_preview_btn');

    if (state.isLongInterceptMode) {
        const context = getContext();
        state.chatLengthBeforeIntercept = context.chat?.length || 0;
        state.longInterceptRestoreFunction = interceptMessageCreation();
        $btn.css('color', 'red');
        toastr.info('持续拦截已开启', '', { timeOut: 2000 });
    } else {
        $btn.css('color', '');
        if (state.longInterceptRestoreFunction) {
            try { state.longInterceptRestoreFunction(); } catch (error) {}
            state.longInterceptRestoreFunction = null;
        }
        state.interceptedMessageIds = [];
        state.chatLengthBeforeIntercept = 0;
        toastr.info('持续拦截已关闭', '', { timeOut: 2000 });
    }
}

function handlePreviewButtonEvents() {
    const $btn = $('#message_preview_btn');

    $btn.on('mousedown touchstart', () => {
        state.longPressTimer = setTimeout(() => toggleLongInterceptMode(), state.longPressDelay);
    });

    $btn.on('mouseup touchend mouseleave', () => {
        if (state.longPressTimer) { clearTimeout(state.longPressTimer); state.longPressTimer = null; }
    });

    $btn.on('click', () => {
        if (state.longPressTimer) { clearTimeout(state.longPressTimer); state.longPressTimer = null; return; }
        if (!state.isLongInterceptMode) showMessagePreview();
    });
}

function recordInterceptedMessage(messageId) {
    if (state.isPreviewMode && !state.interceptedMessageIds.includes(messageId)) {
        state.interceptedMessageIds.push(messageId);
    }
}

async function deleteMessageById(messageId) {
    try {
        const context = getContext();
        if (messageId === context.chat?.length - 1) {
            await deleteLastMessage();
            return true;
        }
        if (context.chat && context.chat[messageId]) {
            context.chat.splice(messageId, 1);
            $(`#chat .mes[mesid="${messageId}"]`).remove();
            if (context.chat_metadata) context.chat_metadata.tainted = true;
            return true;
        }
        const messageElement = $(`#chat .mes[mesid="${messageId}"]`);
        if (messageElement.length > 0) { messageElement.remove(); return true; }
        return false;
    } catch (error) {
        return false;
    }
}

async function deleteInterceptedMessages() {
    try {
        if (!state.interceptedMessageIds.length) return;
        const sortedIds = [...state.interceptedMessageIds].sort((a, b) => b - a);
        let deletedCount = 0;

        for (const messageId of sortedIds) {
            if (await deleteMessageById(messageId)) deletedCount++;
        }

        state.interceptedMessageIds = [];
        try { await saveChatConditional(); } catch (error) {}
        if (deletedCount > 0) {
            toastr.success(`拦截模式下的 ${deletedCount} 条消息已自动删除`, '', { timeOut: 2000 });
        }
    } catch (error) {
        toastr.error('删除拦截消息失败');
    }
}

function shouldSetupInterceptor() {
    const settings = getSettings();
    return settings.preview.enabled || settings.recorded.enabled;
}

function updateInterceptorState() {
    const settings = getSettings();
    const shouldSetup = settings.preview.enabled || settings.recorded.enabled;

    if (shouldSetup && !state.isInterceptorActive) {
        setupInterceptor();
    } else if (!shouldSetup && state.isInterceptorActive) {
        restoreOriginalFetch();
    }
}

function initMessagePreview() {
    try {
        cleanup();
        const settings = getSettings();
        const previewButton = $(`<div id="message_preview_btn" class="fa-regular fa-note-sticky interactable" title="预览消息"></div>`);
        $("#send_but").before(previewButton);
        handlePreviewButtonEvents();

        $("#xiaobaix_preview_enabled").prop("checked", settings.preview.enabled).on("change", function() {
            let globalEnabled = true;
            try { if ('isXiaobaixEnabled' in window) globalEnabled = Boolean(window['isXiaobaixEnabled']); } catch {}
            if (!globalEnabled) return;
            settings.preview.enabled = $(this).prop("checked");
            saveSettingsDebounced();
            $('#message_preview_btn').toggle(settings.preview.enabled);
            if (settings.preview.enabled) {
                state.cleanupTimer = setInterval(cleanupMemory, CONSTANTS.CLEANUP_INTERVAL);
            } else if (state.cleanupTimer) {
                clearInterval(state.cleanupTimer);
                state.cleanupTimer = null;
            }
            updateInterceptorState();
            if (!settings.preview.enabled && settings.recorded.enabled) {
                addEventListeners();
                addHistoryButtonsDebounced();
            }
        });

        $("#xiaobaix_recorded_enabled").prop("checked", settings.recorded.enabled).on("change", function() {
            let globalEnabled = true;
            try { if ('isXiaobaixEnabled' in window) globalEnabled = Boolean(window['isXiaobaixEnabled']); } catch {}
            if (!globalEnabled) return;
            settings.recorded.enabled = $(this).prop("checked");
            saveSettingsDebounced();
            if (settings.recorded.enabled) {
                addEventListeners();
                addHistoryButtonsDebounced();
            } else {
                $('.mes_history_preview').remove();
                state.apiRequestHistory.length = 0;
                if (!settings.preview.enabled) {
                    removeEventListeners();
                }
            }
            updateInterceptorState();
        });

        if (!settings.preview.enabled) $('#message_preview_btn').hide();
        updateInterceptorState();
        if (settings.recorded.enabled) addHistoryButtonsDebounced();
        if (settings.preview.enabled || settings.recorded.enabled) {
            addEventListeners();
        }
        if (window['registerModuleCleanup']) window['registerModuleCleanup']('messagePreview', cleanup);
        if (settings.preview.enabled) state.cleanupTimer = setInterval(cleanupMemory, CONSTANTS.CLEANUP_INTERVAL);

    } catch (error) {
        toastr.error('模块初始化失败');
    }
}

window.addEventListener('beforeunload', cleanup);

window['messagePreviewCleanup'] = cleanup;

export { initMessagePreview, addHistoryButtonsDebounced, cleanup };
