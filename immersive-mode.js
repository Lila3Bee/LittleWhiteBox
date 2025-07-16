import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, this_chid, getCurrentChatId } from "../../../../script.js";
import { selected_group } from "../../../group-chats.js";

const EXT_ID = "LittleWhiteBox";
const MODULE_NAME = "immersive";

const defaultSettings = {
    enabled: false,
    showAllMessages: false,
    autoJumpOnAI: true
};

let isImmersiveModeActive = false;
let chatObserver = null;
let eventsBound = false;
let eventHandlers = {};

function initImmersiveMode() {
    if (!extension_settings[EXT_ID].immersive) {
        extension_settings[EXT_ID].immersive = structuredClone(defaultSettings);
    }

    const settings = extension_settings[EXT_ID].immersive;

    for (const key in defaultSettings) {
        if (settings[key] === undefined) {
            settings[key] = defaultSettings[key];
        }
    }

    const globalEnabled = window.isXiaobaixEnabled !== undefined ? window.isXiaobaixEnabled : true;

    $('#xiaobaix_immersive_enabled').prop('disabled', !globalEnabled).toggleClass('disabled-control', !globalEnabled);

    if (globalEnabled) {
        isImmersiveModeActive = settings.enabled;

        if (isImmersiveModeActive) {
            enableImmersiveMode();
        }

        bindSettingsEvents();
    }

    eventHandlers.chatChanged = onChatChanged;
    eventHandlers.globalStateChange = handleGlobalStateChange;

    eventSource.on(event_types.CHAT_CHANGED, eventHandlers.chatChanged);
    document.addEventListener('xiaobaixEnabledChanged', eventHandlers.globalStateChange);

    if (window.registerModuleCleanup) {
        window.registerModuleCleanup('immersiveMode', cleanup);
    }

    console.log(`[${EXT_ID}] 沉浸式显示模式功能已加载`);
}

function bindSettingsEvents() {
    if (eventsBound) return;
    setTimeout(() => {
        const checkbox = document.getElementById('xiaobaix_immersive_enabled');
        if (checkbox && !eventsBound) {
            const settings = getImmersiveSettings();
            checkbox.checked = settings.enabled;
            checkbox.addEventListener('change', () => setImmersiveMode(checkbox.checked));
            eventsBound = true;
        }
    }, 500);
}

function unbindSettingsEvents() {
    const checkbox = document.getElementById('xiaobaix_immersive_enabled');
    if (checkbox) {
        const newCheckbox = checkbox.cloneNode(true);
        checkbox.parentNode.replaceChild(newCheckbox, checkbox);
    }
    eventsBound = false;
}

function handleGlobalStateChange(event) {
    const globalEnabled = event.detail.enabled;

    $('#xiaobaix_immersive_enabled').prop('disabled', !globalEnabled).toggleClass('disabled-control', !globalEnabled);

    if (globalEnabled) {
        const settings = getImmersiveSettings();
        isImmersiveModeActive = settings.enabled;

        if (isImmersiveModeActive) {
            enableImmersiveMode();
        }

        bindSettingsEvents();

        setTimeout(() => {
            const checkbox = document.getElementById('xiaobaix_immersive_enabled');
            if (checkbox) {
                checkbox.checked = settings.enabled;
            }
        }, 100);
    } else {
        if (isImmersiveModeActive) {
            disableImmersiveMode();
        }
        isImmersiveModeActive = false;

        unbindSettingsEvents();
    }
}

function getImmersiveSettings() {
    return extension_settings[EXT_ID].immersive;
}

function setImmersiveMode(enabled) {
    const settings = getImmersiveSettings();
    settings.enabled = enabled;
    isImmersiveModeActive = enabled;

    const checkbox = document.getElementById('xiaobaix_immersive_enabled');
    if (checkbox) {
        checkbox.checked = enabled;
    }

    if (enabled) {
        enableImmersiveMode();
    } else {
        disableImmersiveMode();
        cleanup();
    }

    saveSettingsDebounced();
}

function toggleImmersiveMode() {
    const globalEnabled = window.isXiaobaixEnabled !== undefined ? window.isXiaobaixEnabled : true;
    if (!globalEnabled) return;

    const settings = getImmersiveSettings();
    setImmersiveMode(!settings.enabled);
}

function enableImmersiveMode() {
    const globalEnabled = window.isXiaobaixEnabled !== undefined ? window.isXiaobaixEnabled : true;
    if (!globalEnabled) return;

    console.log('[小白X] 启用沉浸式显示模式');
    $('body').addClass('immersive-mode');
    updateMessageDisplay();
    showNavigationButtons();
    startChatObserver();
}

function disableImmersiveMode() {
    console.log('[小白X] 禁用沉浸式显示模式');
    $('body').removeClass('immersive-mode');
    $('#chat .mes').show();
    hideNavigationButtons();
    stopChatObserver();
    $('.mesAvatarWrapper, .timestamp, .swipe_left, .swipeRightBlock').show();
}

function startChatObserver() {
    if (chatObserver) {
        stopChatObserver();
    }

    const chatContainer = document.getElementById('chat');
    if (!chatContainer) return;

    chatObserver = new MutationObserver((mutations) => {
        let hasValidAIMessage = false;

        mutations.forEach((mutation) => {
            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === Node.ELEMENT_NODE && node.classList && node.classList.contains('mes')) {
                        const isUser = node.getAttribute('is_user') === 'true';
                        const isSystem = node.getAttribute('is_system') === 'true';

                        if (!isUser && !isSystem) {
                            hasValidAIMessage = true;
                            console.log('[小白X] 检测到AI消息，准备切换页面');
                        }
                    }
                });
            }

            if (mutation.type === 'subtree' || mutation.type === 'characterData') {
                const target = mutation.target;
                if (target && target.closest) {
                    const mesElement = target.closest('.mes');
                    if (mesElement) {
                        const isUser = mesElement.getAttribute('is_user') === 'true';
                        const isSystem = mesElement.getAttribute('is_system') === 'true';

                        if (!isUser && !isSystem) {
                            hasValidAIMessage = true;
                        }
                    }
                }
            }
        });

        if (hasValidAIMessage) {
            handleChatUpdate();
        }
    });

    chatObserver.observe(chatContainer, {
        childList: true,
        subtree: true,
        characterData: true
    });
}

function stopChatObserver() {
    if (chatObserver) {
        chatObserver.disconnect();
        chatObserver = null;
    }
}

function handleChatUpdate() {
    if (!isImmersiveModeActive) return;

    const settings = getImmersiveSettings();

    if (settings.autoJumpOnAI && !settings.showAllMessages) {
        console.log('[小白X] AI消息检测，保持单个消息显示模式');
        updateMessageDisplay();
    } else if (settings.showAllMessages) {
        console.log('[小白X] AI消息检测，但当前为多层模式，不进行跳转');
        updateMessageDisplay();
    }
}

function updateMessageDisplay() {
    if (!isImmersiveModeActive) return;

    const messages = $('#chat .mes');
    const settings = getImmersiveSettings();

    if (messages.length === 0) return;

    if (settings.showAllMessages) {
        messages.show();
    } else {
        messages.hide();
        messages.last().show();
    }

    updateNavigationButtons();
}

function isInChat() {
    return this_chid !== undefined || selected_group || getCurrentChatId() !== undefined;
}

function showNavigationButtons() {
    if (!isInChat()) {
        hideNavigationButtons();
        return;
    }

    if ($('#immersive-navigation').length === 0) {
        const navigationHtml = `
            <div id="immersive-navigation" class="immersive-navigation">
                <button id="immersive-swipe-left" class="immersive-nav-btn" title="左滑消息">
                    <i class="fa-solid fa-chevron-left"></i>
                </button>
                <button id="immersive-toggle" class="immersive-nav-btn" title="切换显示模式">
                    <i class="fa-solid fa-expand"></i>
                </button>
                <button id="immersive-swipe-right" class="immersive-nav-btn" title="右滑消息">
                    <i class="fa-solid fa-chevron-right"></i>
                </button>
            </div>
        `;

        $('#form_sheld').append(navigationHtml);

        const navActions = {
            '#immersive-swipe-left': () => handleSwipe('.swipe_left'),
            '#immersive-toggle': toggleDisplayMode,
            '#immersive-swipe-right': () => handleSwipe('.swipe_right')
        };

        Object.entries(navActions).forEach(([selector, handler]) => {
            $(selector).on('click', handler);
        });
    }

    updateNavigationButtons();
}


function hideNavigationButtons() {
    $('#immersive-navigation').remove();
}

function updateNavigationButtons() {
    if (!isImmersiveModeActive) return;

    const settings = getImmersiveSettings();
    const $toggleBtn = $('#immersive-toggle');

    if (settings.showAllMessages) {
        $toggleBtn.find('i').removeClass('fa-expand').addClass('fa-compress');
        $toggleBtn.attr('title', '切换到单层模式');
    } else {
        $toggleBtn.find('i').removeClass('fa-compress').addClass('fa-expand');
        $toggleBtn.attr('title', '切换到多层模式');
    }
}

function toggleDisplayMode() {
    if (!isImmersiveModeActive) return;

    const settings = getImmersiveSettings();
    settings.showAllMessages = !settings.showAllMessages;

    updateMessageDisplay();
    saveSettingsDebounced();
}

function handleSwipe(swipeSelector) {
    if (!isImmersiveModeActive) return;

    const currentMessage = $('#chat .mes:visible').last();
    const swipeBtn = currentMessage.find(swipeSelector);
    if (swipeBtn.length > 0) {
        swipeBtn.click();
    }
}

function onChatChanged() {
    const globalEnabled = window.isXiaobaixEnabled !== undefined ? window.isXiaobaixEnabled : true;
    if (!globalEnabled) return;

    if (isImmersiveModeActive) {
        setTimeout(() => {
            startChatObserver();
            updateMessageDisplay();
            showNavigationButtons();
        }, 100);
    }
}

function cleanup() {
    if (isImmersiveModeActive) {
        disableImmersiveMode();
    }

    if (eventHandlers.chatChanged) {
        eventSource.removeListener(event_types.CHAT_CHANGED, eventHandlers.chatChanged);
    }
    if (eventHandlers.globalStateChange) {
        document.removeEventListener('xiaobaixEnabledChanged', eventHandlers.globalStateChange);
    }

    if (chatObserver) {
        chatObserver.disconnect();
        chatObserver = null;
    }

    isImmersiveModeActive = false;
    eventsBound = false;
    eventHandlers = {};
}

export { initImmersiveMode, toggleImmersiveMode };
