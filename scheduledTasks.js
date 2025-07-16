import { extension_settings, getContext, writeExtensionField, renderExtensionTemplateAsync } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, characters, this_chid, chat } from "../../../../script.js";
import { executeSlashCommandsWithOptions } from "../../../slash-commands.js";
import { SlashCommandParser } from "../../../slash-commands/SlashCommandParser.js";
import { SlashCommand } from "../../../slash-commands/SlashCommand.js";
import { ARGUMENT_TYPE, SlashCommandArgument } from "../../../slash-commands/SlashCommandArgument.js";
import { callPopup } from "../../../../script.js";
import { callGenericPopup, POPUP_TYPE } from "../../../popup.js";
import { accountStorage } from "../../../util/AccountStorage.js";
import { download, getFileText, uuidv4, debounce } from "../../../utils.js";
import { executeSlashCommand } from "./index.js";

const TASKS_MODULE_NAME = "xiaobaix-tasks";
const EXT_ID = "LittleWhiteBox";
const defaultSettings = {
    enabled: true,
    globalTasks: [],
    processedMessages: [],
    character_allowed_tasks: []
};

const MAX_PROCESSED_MESSAGES = 20;
const MAX_COOLDOWN_ENTRIES = 10;
const CLEANUP_INTERVAL = 30000;
const TASK_COOLDOWN = 3000;
const DEBOUNCE_DELAY = 1000;

let currentEditingTask = null;
let currentEditingIndex = -1;
let lastChatId = null;
let chatJustChanged = false;
let isNewChat = false;
let lastTurnCount = 0;
let isExecutingTask = false;
let isCommandGenerated = false;
let taskLastExecutionTime = new Map();
let cleanupTimer = null;
let lastTasksHash = '';

const debouncedSave = debounce(() => {
    saveSettingsDebounced();
}, DEBOUNCE_DELAY);

function getSettings() {
    if (!extension_settings[EXT_ID].tasks) {
        extension_settings[EXT_ID].tasks = structuredClone(defaultSettings);
    }
    const settings = extension_settings[EXT_ID].tasks;
    Object.keys(defaultSettings).forEach(key => {
        if (settings[key] === undefined) settings[key] = defaultSettings[key];
    });
    return settings;
}

function scheduleCleanup() {
    if (cleanupTimer) return;

    cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [taskName, lastTime] of taskLastExecutionTime.entries()) {
            if (now - lastTime > TASK_COOLDOWN * 2) {
                taskLastExecutionTime.delete(taskName);
            }
        }

        if (taskLastExecutionTime.size > MAX_COOLDOWN_ENTRIES) {
            const entries = Array.from(taskLastExecutionTime.entries());
            entries.sort((a, b) => b[1] - a[1]);
            taskLastExecutionTime.clear();
            entries.slice(0, MAX_COOLDOWN_ENTRIES).forEach(([name, time]) => {
                taskLastExecutionTime.set(name, time);
            });
        }

        const settings = getSettings();
        if (settings.processedMessages.length > MAX_PROCESSED_MESSAGES) {
            settings.processedMessages = settings.processedMessages.slice(-MAX_PROCESSED_MESSAGES);
            debouncedSave();
        }

    }, CLEANUP_INTERVAL);
}

function isTaskInCooldown(taskName) {
    const lastExecution = taskLastExecutionTime.get(taskName);
    return lastExecution && (Date.now() - lastExecution) < TASK_COOLDOWN;
}

function setTaskCooldown(taskName) {
    taskLastExecutionTime.set(taskName, Date.now());
}

function isMessageProcessed(messageKey) {
    return getSettings().processedMessages.includes(messageKey);
}

function markMessageAsProcessed(messageKey) {
    const settings = getSettings();
    if (settings.processedMessages.includes(messageKey)) return;

    settings.processedMessages.push(messageKey);

    if (settings.processedMessages.length > MAX_PROCESSED_MESSAGES) {
        settings.processedMessages = settings.processedMessages.slice(-Math.floor(MAX_PROCESSED_MESSAGES/2));
    }

    debouncedSave();
}

function getCharacterTasks() {
    if (!this_chid || !characters[this_chid]) return [];
    const character = characters[this_chid];
    if (!character.data?.extensions?.[TASKS_MODULE_NAME]) {
        if (!character.data) character.data = {};
        if (!character.data.extensions) character.data.extensions = {};
        character.data.extensions[TASKS_MODULE_NAME] = { tasks: [] };
    }
    return character.data.extensions[TASKS_MODULE_NAME].tasks || [];
}

async function saveCharacterTasks(tasks) {
    if (!this_chid || !characters[this_chid]) return;
    await writeExtensionField(Number(this_chid), TASKS_MODULE_NAME, { tasks });
    const settings = getSettings();
    const avatar = characters[this_chid].avatar;
    if (avatar && !settings.character_allowed_tasks?.includes(avatar)) {
        if (!settings.character_allowed_tasks) settings.character_allowed_tasks = [];
        settings.character_allowed_tasks.push(avatar);
        debouncedSave();
    }
}

async function executeCommands(commands, taskName) {
    if (!commands?.trim()) return null;
    isCommandGenerated = true;
    isExecutingTask = true;
    try {
        return await processTaskCommands(commands);
    } finally {
        setTimeout(() => {
            isCommandGenerated = false;
            isExecutingTask = false;
        }, 500);
    }
}

async function processTaskCommands(commands) {
    const jsTagRegex = /<<taskjs>>([\s\S]*?)<<\/taskjs>>/g;
    let lastIndex = 0;
    let result = null;

    let match;
    while ((match = jsTagRegex.exec(commands)) !== null) {
        const beforeJs = commands.slice(lastIndex, match.index).trim();
        if (beforeJs) {
            result = await executeSlashCommand(beforeJs);
        }

        const jsCode = match[1].trim();
        if (jsCode) {
            try {
                await executeTaskJS(jsCode);
            } catch (error) {
                console.error(`[任务JS执行错误] ${error.message}`);
            }
        }

        lastIndex = match.index + match[0].length;
    }

    const remaining = commands.slice(lastIndex).trim();
    if (remaining) {
        result = await executeSlashCommand(remaining);
    }

    if (lastIndex === 0) {
        result = await executeSlashCommand(commands);
    }

    return result;
}

async function executeTaskJS(jsCode) {
    const STscript = async (command) => {
        if (!command) return { error: "命令为空" };
        if (!command.startsWith('/')) command = '/' + command;
        return await executeSlashCommand(command);
    };

    const iframes = document.querySelectorAll('iframe.xiaobaix-iframe');

    if (iframes.length > 0) {
        const latestIframe = iframes[iframes.length - 1];
        if (latestIframe && latestIframe.contentWindow) {
            try {
                latestIframe.contentWindow.STscript = STscript;

                const executeFunction = `
                    (async function() {
                        try {
                            ${jsCode}
                        } catch (error) {
                            console.error('Task JS Error:', error);
                            throw error;
                        }
                    })();
                `;

                await latestIframe.contentWindow.eval(executeFunction);
                return;
            } catch (error) {
                console.error('IFRAME JS执行失败:', error);
            }
        }
    }

    try {
        const executeFunction = new Function('STscript', `
            return (async function() {
                ${jsCode}
            })();
        `);

        await executeFunction(STscript);
    } catch (error) {
        console.error('主窗口JS执行失败:', error);
        throw error;
    }
}

function handleTaskMessage(event) {
    if (!event.data || event.data.source !== 'xiaobaix-iframe') return;

    const { type } = event.data;

    if (type === 'executeTaskJS') {
        try {
            const script = document.createElement('script');
            script.textContent = event.data.code;
            event.source.document.head.appendChild(script);
            event.source.document.head.removeChild(script);
        } catch (error) {
            console.error('执行任务JS失败:', error);
        }
    }
}

function calculateFloorByType(floorType) {
    if (!Array.isArray(chat) || chat.length === 0) return 0;
    let count = 0;
    switch (floorType) {
        case 'user':
            count = Math.max(0, chat.filter(msg => msg.is_user && !msg.is_system).length - 1);
            break;
        case 'llm':
            count = Math.max(0, chat.filter(msg => !msg.is_user && !msg.is_system).length - 1);
            break;
        default:
            count = Math.max(0, chat.length - 1);
            break;
    }
    return count;
}

function calculateTurnCount() {
    if (!Array.isArray(chat) || chat.length === 0) return 0;
    const userMessages = chat.filter(msg => msg.is_user && !msg.is_system).length;
    const aiMessages = chat.filter(msg => !msg.is_user && !msg.is_system).length;
    return Math.min(userMessages, aiMessages);
}

async function checkAndExecuteTasks(triggerContext = 'after_ai', overrideChatChanged = null, overrideNewChat = null) {
    const settings = getSettings();
    const globalEnabled = window.isXiaobaixEnabled !== undefined ? window.isXiaobaixEnabled : true;
    if (!settings.enabled || !globalEnabled || (overrideChatChanged ?? chatJustChanged) ||
        (overrideNewChat ?? isNewChat) || isExecutingTask) return;

    const allTasks = [...settings.globalTasks, ...getCharacterTasks()];
    if (allTasks.length === 0) return;

    const now = Date.now();
    const currentTurnCount = calculateTurnCount();

    const tasksToExecute = allTasks.filter(task => {
        if (task.disabled || task.interval <= 0) return false;

        const lastExecution = taskLastExecutionTime.get(task.name);
        if (lastExecution && (now - lastExecution) < TASK_COOLDOWN) return false;

        const taskTriggerTiming = task.triggerTiming || 'after_ai';
        if (taskTriggerTiming !== triggerContext && taskTriggerTiming !== 'per_turn') return false;

        if (taskTriggerTiming === 'per_turn') {
            return triggerContext === 'after_ai' && currentTurnCount > lastTurnCount && currentTurnCount % task.interval === 0;
        } else {
            const currentFloor = calculateFloorByType(task.floorType || 'all');
            return currentFloor % task.interval === 0 && currentFloor > 0;
        }
    });

    for (const task of tasksToExecute) {
        taskLastExecutionTime.set(task.name, now);
        await executeCommands(task.commands, task.name);
    }

    if (triggerContext === 'after_ai') lastTurnCount = currentTurnCount;
}

async function onMessageReceived(messageId, type) {
    if (typeof messageId !== 'number' || messageId < 0 || !chat[messageId]) return;

    const message = chat[messageId];
    if (message.is_user || message.is_system || message.mes === '...' ||
        isCommandGenerated || isExecutingTask) return;

    if (message.swipe_id !== undefined && message.swipe_id > 0) {
        return;
    }

    const settings = getSettings();
    const globalEnabled = window.isXiaobaixEnabled !== undefined ? window.isXiaobaixEnabled : true;
    if (!settings.enabled || !globalEnabled) return;

    const messageKey = `${getContext().chatId}_${messageId}_${message.send_date || Date.now()}`;
    if (isMessageProcessed(messageKey)) {
        return;
    }

    markMessageAsProcessed(messageKey);
    await checkAndExecuteTasks('after_ai');
    chatJustChanged = isNewChat = false;
}


async function onUserMessage() {
    const settings = getSettings();
    const globalEnabled = window.isXiaobaixEnabled !== undefined ? window.isXiaobaixEnabled : true;
    if (!settings.enabled || !globalEnabled) return;
    const messageKey = `${getContext().chatId}_user_${chat.length}`;
    if (isMessageProcessed(messageKey)) return;
    markMessageAsProcessed(messageKey);
    await checkAndExecuteTasks('before_user');
    chatJustChanged = isNewChat = false;
}

function onMessageDeleted(data) {
    const settings = getSettings();
    const chatId = getContext().chatId;

    settings.processedMessages = settings.processedMessages.filter(key =>
        !key.startsWith(`${chatId}_`)
    );

    isExecutingTask = false;
    isCommandGenerated = false;

    debouncedSave();
}


function onChatChanged(chatId) {
    chatJustChanged = true;
    isNewChat = lastChatId !== chatId && chat.length <= 1;
    lastChatId = chatId;
    lastTurnCount = 0;
    isExecutingTask = false;
    isCommandGenerated = false;
    taskLastExecutionTime.clear();

    const settings = getSettings();
    settings.processedMessages = settings.processedMessages.filter(key => !key.startsWith(`${chatId}_`));
    debouncedSave();

    checkEmbeddedTasks();
    refreshTaskLists();
    setTimeout(() => { chatJustChanged = isNewChat = false; }, 2000);
}

function getTasksHash() {
    const allTasks = [...getSettings().globalTasks, ...getCharacterTasks()];
    return allTasks.map(t =>
        `${t.id}_${t.disabled}_${t.name}_${t.interval}_${t.floorType}_${t.triggerTiming}`
    ).join('|');
}

function createTaskItem(task, index, isCharacterTask = false) {
    if (!task.id) task.id = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const taskType = isCharacterTask ? 'character' : 'global';
    const floorTypeText = { user: '用户楼层', llm: 'LLM楼层' }[task.floorType] || '全部楼层';
    const triggerTimingText = { before_user: '用户前', per_turn: '每轮' }[task.triggerTiming] || 'AI后';
    const displayName = task.interval === 0 ? `${task.name} (手动激活)` : `${task.name} (每${task.interval}${floorTypeText}·${triggerTimingText})`;

    const taskElement = $('#task_item_template').children().first().clone();
    taskElement.attr({ id: task.id, 'data-index': index, 'data-type': taskType });
    taskElement.find('.task_name').attr('title', task.commands).text(displayName);
    taskElement.find('.disable_task').attr('id', `task_disable_${task.id}`).prop('checked', task.disabled);
    taskElement.find('label.checkbox').attr('for', `task_disable_${task.id}`);

    taskElement.find('.disable_task').on('input', () => {
        task.disabled = taskElement.find('.disable_task').prop('checked');
        saveTask(task, index, isCharacterTask);
    });
    taskElement.find('.test_task').on('click', () => testTask(index, taskType));
    taskElement.find('.edit_task').on('click', () => editTask(index, taskType));
    taskElement.find('.delete_task').on('click', () => deleteTask(index, taskType));
    return taskElement;
}

function refreshTaskLists() {
    const currentHash = getTasksHash();
    if (currentHash === lastTasksHash) return;

    lastTasksHash = currentHash;

    const $globalList = $('#global_tasks_list');
    const $charList = $('#character_tasks_list');
    const globalTasks = getSettings().globalTasks;
    const characterTasks = getCharacterTasks();

    $globalList.empty();
    globalTasks.forEach((task, i) =>
        $globalList.append(createTaskItem(task, i, false))
    );

    $charList.empty();
    characterTasks.forEach((task, i) =>
        $charList.append(createTaskItem(task, i, true))
    );
}

function showTaskEditor(task = null, isEdit = false, isCharacterTask = false) {
    currentEditingTask = task;
    currentEditingIndex = isEdit ? (isCharacterTask ? getCharacterTasks() : getSettings().globalTasks).indexOf(task) : -1;
    const editorTemplate = $('#task_editor_template').clone().removeAttr('id').show();
    editorTemplate.find('.task_name_edit').val(task?.name || '');
    editorTemplate.find('.task_commands_edit').val(task?.commands || '');
    editorTemplate.find('.task_interval_edit').val(task?.interval ?? 3);
    editorTemplate.find('.task_floor_type_edit').val(task?.floorType || 'all');
    editorTemplate.find('.task_trigger_timing_edit').val(task?.triggerTiming || 'after_ai');
    editorTemplate.find('.task_type_edit').val(isCharacterTask ? 'character' : 'global');
    editorTemplate.find('.task_enabled_edit').prop('checked', !task?.disabled);

    callPopup(editorTemplate, 'confirm', undefined, { okButton: '保存' }).then(result => {
        if (result) {
            const newTask = {
                id: task?.id || `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                name: editorTemplate.find('.task_name_edit').val().trim(),
                commands: editorTemplate.find('.task_commands_edit').val().trim(),
                interval: parseInt(editorTemplate.find('.task_interval_edit').val()) || 0,
                floorType: editorTemplate.find('.task_floor_type_edit').val() || 'all',
                triggerTiming: editorTemplate.find('.task_trigger_timing_edit').val() || 'after_ai',
                disabled: !editorTemplate.find('.task_enabled_edit').prop('checked'),
                createdAt: task?.createdAt || new Date().toISOString()
            };
            saveTaskFromEditor(newTask, editorTemplate.find('.task_type_edit').val() === 'character');
        }
    });
}

function saveTaskFromEditor(task, isCharacterTask) {
    if (!task.name || !task.commands) return;
    if (isCharacterTask) {
        const tasks = getCharacterTasks();
        if (currentEditingIndex >= 0) tasks[currentEditingIndex] = task;
        else tasks.push(task);
        saveCharacterTasks(tasks);
    } else {
        const settings = getSettings();
        if (currentEditingIndex >= 0) settings.globalTasks[currentEditingIndex] = task;
        else settings.globalTasks.push(task);
        debouncedSave();
    }
    refreshTaskLists();
}

function saveTask(task, index, isCharacterTask) {
    const tasks = isCharacterTask ? getCharacterTasks() : getSettings().globalTasks;
    if (index >= 0 && index < tasks.length) tasks[index] = task;
    if (isCharacterTask) {
        saveCharacterTasks(tasks);
    } else {
        debouncedSave();
    }
    refreshTaskLists();
}

async function testTask(index, type) {
    const task = (type === 'character' ? getCharacterTasks() : getSettings().globalTasks)[index];
    if (task) await executeCommands(task.commands, task.name);
}

function editTask(index, type) {
    const task = (type === 'character' ? getCharacterTasks() : getSettings().globalTasks)[index];
    if (task) showTaskEditor(task, true, type === 'character');
}

function deleteTask(index, type) {
    const task = (type === 'character' ? getCharacterTasks() : getSettings().globalTasks)[index];
    if (!task) return;

    $(document).off('keydown.confirmmodal');
    $('.xiaobaix-confirm-modal').remove();

    const dialogHtml = `
    <div class="xiaobaix-confirm-modal">
        <div class="xiaobaix-confirm-content">
            <div class="xiaobaix-confirm-message">确定要删除任务 "${task.name}" 吗？</div>
            <div class="xiaobaix-confirm-buttons">
                <button class="xiaobaix-confirm-yes">确定</button>
                <button class="xiaobaix-confirm-no">取消</button>
            </div>
        </div>
    </div>`;

    $('body').append(dialogHtml);

    $('.xiaobaix-confirm-yes').on('click', function() {
        $('.xiaobaix-confirm-modal').remove();
        if (type === 'character') {
            const tasks = getCharacterTasks();
            tasks.splice(index, 1);
            saveCharacterTasks(tasks);
        } else {
            getSettings().globalTasks.splice(index, 1);
            debouncedSave();
        }
        refreshTaskLists();
    });

    $('.xiaobaix-confirm-no, .xiaobaix-confirm-modal').on('click', function(e) {
        if (e.target === this) $('.xiaobaix-confirm-modal').remove();
    });

    $(document).on('keydown.confirmmodal', function(e) {
        if (e.key === 'Escape') {
            $('.xiaobaix-confirm-modal').remove();
            $(document).off('keydown.confirmmodal');
        }
    });
}



function getAllTaskNames() {
    return [...getSettings().globalTasks, ...getCharacterTasks()]
        .filter(t => !t.disabled)
        .map(t => t.name);
}

async function checkEmbeddedTasks() {
    if (!this_chid) return;
    const avatar = characters[this_chid]?.avatar;
    const tasks = characters[this_chid]?.data?.extensions?.[TASKS_MODULE_NAME]?.tasks;

    if (Array.isArray(tasks) && tasks.length > 0 && avatar) {
        const settings = getSettings();
        if (!settings.character_allowed_tasks) settings.character_allowed_tasks = [];

        if (!settings.character_allowed_tasks.includes(avatar)) {
            const checkKey = `AlertTasks_${avatar}`;
            if (!accountStorage.getItem(checkKey)) {
                accountStorage.setItem(checkKey, 'true');
                let result;
                try {
                    const templateFilePath = `scripts/extensions/third-party/LittleWhiteBox/embeddedTasks.html`;
                    const templateContent = await fetch(templateFilePath).then(r => r.text());
                    const templateElement = $(templateContent);
                    const taskListContainer = templateElement.find('#embedded-tasks-list');
                    tasks.forEach(task => {
                        const taskPreview = $('#task_preview_template').children().first().clone();
                        taskPreview.find('.task-preview-name').text(task.name);
                        taskPreview.find('.task-preview-interval').text(`(每${task.interval}回合)`);
                        taskPreview.find('.task-preview-commands').text(task.commands);
                        taskListContainer.append(taskPreview);
                    });
                    result = await callGenericPopup(templateElement, POPUP_TYPE.CONFIRM, '', { okButton: '允许' });
                } catch (error) {
                    result = await callGenericPopup(`此角色包含 ${tasks.length} 个定时任务。是否允许使用？`, POPUP_TYPE.CONFIRM, '', { okButton: '允许' });
                }
                if (result) {
                    settings.character_allowed_tasks.push(avatar);
                    debouncedSave();
                }
            }
        }
    }
    refreshTaskLists();
}

async function exportGlobalTasks() {
    const settings = getSettings();
    const tasks = settings.globalTasks;
    if (tasks.length === 0) return;
    const fileName = `global_tasks_${new Date().toISOString().split('T')[0]}.json`;
    const fileData = JSON.stringify({ type: 'global', exportDate: new Date().toISOString(), tasks }, null, 4);
    download(fileData, fileName, 'application/json');
}

async function importGlobalTasks(file) {
    if (!file) return;
    try {
        const fileText = await getFileText(file);
        const importData = JSON.parse(fileText);
        if (!Array.isArray(importData.tasks)) throw new Error('无效的任务文件格式');
        const tasksToImport = importData.tasks.map(task => ({
            ...task,
            id: uuidv4(),
            importedAt: new Date().toISOString()
        }));
        const settings = getSettings();
        settings.globalTasks = [...settings.globalTasks, ...tasksToImport];
        debouncedSave();
        refreshTaskLists();
    } catch (error) {
        console.error('任务导入失败:', error);
    }
}

function clearProcessedMessages() {
    getSettings().processedMessages = [];
    debouncedSave();
}

function clearTaskCooldown(taskName = null) {
    if (taskName) taskLastExecutionTime.delete(taskName);
    else taskLastExecutionTime.clear();
}

function getTaskCooldownStatus() {
    const status = {};
    for (const [taskName, lastTime] of taskLastExecutionTime.entries()) {
        const remaining = Math.max(0, TASK_COOLDOWN - (Date.now() - lastTime));
        status[taskName] = {
            lastExecutionTime: lastTime,
            remainingCooldown: remaining,
            isInCooldown: remaining > 0
        };
    }
    return status;
}

function getMemoryUsage() {
    return {
        processedMessages: getSettings().processedMessages.length,
        taskCooldowns: taskLastExecutionTime.size,
        globalTasks: getSettings().globalTasks.length,
        characterTasks: getCharacterTasks().length,
        maxProcessedMessages: MAX_PROCESSED_MESSAGES,
        maxCooldownEntries: MAX_COOLDOWN_ENTRIES
    };
}

function cleanup() {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }
    taskLastExecutionTime.clear();

    eventSource.removeListener(event_types.CHARACTER_MESSAGE_RENDERED, onMessageReceived);
    eventSource.removeListener(event_types.USER_MESSAGE_RENDERED, onUserMessage);
    eventSource.removeListener(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.removeListener(event_types.MESSAGE_DELETED, onMessageDeleted);
    eventSource.removeListener(event_types.MESSAGE_SWIPED);
    eventSource.removeListener(event_types.CHARACTER_DELETED);

    window.removeEventListener('message', handleTaskMessage);

    $(window).off('beforeunload', cleanup);
}

window.xbqte = async (name) => {
    try {
        if (!name?.trim()) throw new Error('请提供任务名称');
        const task = [...getSettings().globalTasks, ...getCharacterTasks()]
            .find(t => t.name.toLowerCase() === name.toLowerCase());
        if (!task) throw new Error(`找不到名为 "${name}" 的任务`);
        if (task.disabled) throw new Error(`任务 "${name}" 已被禁用`);
        if (isTaskInCooldown(task.name)) {
            const cooldownStatus = getTaskCooldownStatus()[task.name];
            throw new Error(`任务 "${name}" 仍在冷却中，剩余 ${cooldownStatus.remainingCooldown}ms`);
        }
        setTaskCooldown(task.name);
        const result = await executeCommands(task.commands, task.name);
        return result || `已执行任务: ${task.name}`;
    } catch (error) {
        console.error(`执行任务失败: ${error.message}`);
        throw error;
    }
};

window.setScheduledTaskInterval = async (name, interval) => {
    if (!name?.trim()) throw new Error('请提供任务名称');
    const intervalNum = parseInt(interval);
    if (isNaN(intervalNum) || intervalNum < 0 || intervalNum > 99999) {
        throw new Error('间隔必须是 0-99999 之间的数字');
    }

    const settings = getSettings();
    const globalTaskIndex = settings.globalTasks.findIndex(t => t.name.toLowerCase() === name.toLowerCase());
    if (globalTaskIndex !== -1) {
        settings.globalTasks[globalTaskIndex].interval = intervalNum;
        debouncedSave();
        refreshTaskLists();
        return `已设置全局任务 "${name}" 的间隔为 ${intervalNum === 0 ? '手动激活' : `每${intervalNum}楼层`}`;
    }

    const characterTasks = getCharacterTasks();
    const characterTaskIndex = characterTasks.findIndex(t => t.name.toLowerCase() === name.toLowerCase());
    if (characterTaskIndex !== -1) {
        characterTasks[characterTaskIndex].interval = intervalNum;
        await saveCharacterTasks(characterTasks);
        refreshTaskLists();
        return `已设置角色任务 "${name}" 的间隔为 ${intervalNum === 0 ? '手动激活' : `每${intervalNum}楼层`}`;
    }
    throw new Error(`找不到名为 "${name}" 的任务`);
};

window.clearTasksProcessedMessages = clearProcessedMessages;
window.clearTaskCooldown = clearTaskCooldown;
window.getTaskCooldownStatus = getTaskCooldownStatus;
window.getTasksMemoryUsage = getMemoryUsage;

function registerSlashCommands() {
    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'xbqte',
            callback: async (args, value) => {
                if (!value) return '请提供任务名称。用法: /xbqte 任务名称';
                try {
                    return await window.executeScheduledTaskByName(value);
                } catch (error) {
                    return `错误: ${error.message}`;
                }
            },
            unnamedArgumentList: [SlashCommandArgument.fromProps({
                description: '要执行的任务名称',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: getAllTaskNames
            })],
            helpString: '执行指定名称的定时任务。例如: /xbqte 我的任务名称'
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'xbset',
            callback: async (args, value) => {
                const valueStr = String(value || '').trim();
                const parts = valueStr.split(/\s+/);
                if (!parts || parts.length < 2) {
                    return '用法: /xbset 任务名称 间隔数字\n例如: /xbset 我的任务 5\n设为0表示手动激活';
                }
                const interval = parts.pop();
                const taskName = parts.join(' ');
                try {
                    return await window.setScheduledTaskInterval(taskName, interval);
                } catch (error) {
                    return `错误: ${error.message}`;
                }
            },
            unnamedArgumentList: [SlashCommandArgument.fromProps({
                description: '任务名称 间隔数字',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true
            })],
            helpString: '设置定时任务的触发间隔。用法: /xbset 任务名称 间隔数字\n例如: /xbset 我的任务 5 (每5楼层触发)\n设为0表示手动激活'
        }));
    } catch (error) {
        console.error("Error registering slash commands:", error);
    }
}

function initTasks() {
    scheduleCleanup();

    if (!extension_settings[EXT_ID].tasks) {
        extension_settings[EXT_ID].tasks = structuredClone(defaultSettings);
    }

    if (window.registerModuleCleanup) {
        window.registerModuleCleanup('scheduledTasks', cleanup);
    }

    window.addEventListener('message', handleTaskMessage);

    $('#scheduled_tasks_enabled').on('input', e => {

        const globalEnabled = window.isXiaobaixEnabled !== undefined ? window.isXiaobaixEnabled : true;
        if (!globalEnabled) return;

        const enabled = $(e.target).prop('checked');
        getSettings().enabled = enabled;
        debouncedSave();

        if (!enabled) {
            cleanup();
        }
    });
    $('#add_global_task').on('click', () => showTaskEditor(null, false, false));
    $('#add_character_task').on('click', () => showTaskEditor(null, false, true));
    $('#export_global_tasks').on('click', exportGlobalTasks);
    $('#import_global_tasks').on('click', () => $('#import_tasks_file').trigger('click'));
    $('#import_tasks_file').on('change', function(e) {
        const file = e.target.files[0];
        if (file) {
            importGlobalTasks(file);
            $(this).val('');
        }
    });

    $('#scheduled_tasks_enabled').prop('checked', getSettings().enabled);
    refreshTaskLists();

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageReceived);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onUserMessage);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);
    eventSource.on(event_types.MESSAGE_SWIPED, () => {
        isExecutingTask = false;
        isCommandGenerated = false;
    });
    eventSource.on(event_types.CHARACTER_DELETED, ({ character }) => {
        const avatar = character?.avatar;
        const settings = getSettings();
        if (avatar && settings.character_allowed_tasks?.includes(avatar)) {
            const index = settings.character_allowed_tasks.indexOf(avatar);
            if (index !== -1) {
                settings.character_allowed_tasks.splice(index, 1);
                debouncedSave();
            }
        }
    });

    $(window).on('beforeunload', cleanup);

    registerSlashCommands();
    setTimeout(() => { checkEmbeddedTasks(); }, 1000);

}

export { initTasks };
