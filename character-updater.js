import { extension_settings, getContext, writeExtensionField } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, characters, this_chid } from "../../../../script.js";
import { callGenericPopup, POPUP_TYPE } from "../../../popup.js";

const EXT_ID = "LittleWhiteBox";
const MODULE_NAME = "characterUpdater";
const extensionFolderPath = `scripts/extensions/third-party/${EXT_ID}`;

const SECURITY_CONFIG = {
    AUTH_TOKEN: 'L15bEs6Nut9b4skgabYC',
    AUTH_HEADER_KEY: 'GTpzLYc21yopWLKhjjEQ',
    PASSWORD_SALT: 'kXUAjsi8wMa1AM8NJ9uA',
    TRUSTED_DOMAINS: ['rentry.org', 'discord.com', 'discordapp.net', 'discordapp.com']
};

const moduleState = {
    isInitialized: false,
    eventHandlers: {}
};

const defaultSettings = {
    enabled: true,
    showNotifications: true
};

const utils = {
    getSettings: () => {
        const parentSettings = extension_settings[EXT_ID] || {};
        const moduleSettings = parentSettings.characterUpdater || {};
        const settings = { ...defaultSettings, ...moduleSettings };
        settings.serverUrl = parentSettings.characterUpdater?.serverUrl || "https://db.littlewhitebox.qzz.io";
        return settings;
    },

    generateUUID: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c == 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    }),

    showToast: (message, type = 'info') => {
        if (utils.getSettings().showNotifications) {
            toastr[type](message, '角色卡更新');
        }
    },

    encryptPassword: (password) => {
        const key = SECURITY_CONFIG.PASSWORD_SALT;
        let result = '';
        for (let i = 0; i < password.length; i++) {
            result += String.fromCharCode(password.charCodeAt(i) ^ key.charCodeAt(i % key.length));
        }
        return btoa(result);
    },

    validateUrl: (url) => {
        if (!url || typeof url !== 'string') return false;
        try {
            const hostname = new URL(url).hostname.toLowerCase();
            return SECURITY_CONFIG.TRUSTED_DOMAINS.some(domain =>
                hostname === domain || hostname.endsWith('.' + domain)
            );
        } catch { return false; }
    },

    sanitizeContent: (content) => {
        if (!content || typeof content !== 'string') return '';
        const allowedTags = ['br', 'b', 'strong', 'i', 'em', 'u', 'p', 'div', 'span'];
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = content;

        const cleanNode = (node) => {
            if (node.nodeType === Node.TEXT_NODE) return node.textContent;
            if (node.nodeType === Node.ELEMENT_NODE) {
                const tagName = node.tagName.toLowerCase();
                if (!allowedTags.includes(tagName)) return node.textContent;
                let result = `<${tagName}>`;
                for (let child of node.childNodes) result += cleanNode(child);
                return result + `</${tagName}>`;
            }
            return '';
        };

        return [...tempDiv.childNodes].map(cleanNode).join('');
    }
};

const characterManager = {
    getCharacter: id => id != null ? characters[id] || null : null,
    getExtensionData: id => characterManager.getCharacter(id)?.data?.extensions?.[MODULE_NAME] || null,

    saveExtensionData: async (id, data) => {
        try {
            await writeExtensionField(id, MODULE_NAME, data);
            return true;
        } catch (error) {
            console.error('保存失败:', error);
            return false;
        }
    },

    isBound: id => {
        const data = characterManager.getExtensionData(id);
        return !!(data?.uniqueValue && data?.nameGroup);
    },

    getAllBound: () => characters.reduce((acc, char, index) => {
        if (char && characterManager.isBound(index)) acc.push(index);
        return acc;
    }, [])
};

const serverAPI = {
    request: async (endpoint, method = 'GET', data = null, useFormData = false) => {
        const { serverUrl } = utils.getSettings();
        if (!serverUrl) throw new Error('服务器地址未配置');

        const authParams = new URLSearchParams({
            auth: SECURITY_CONFIG.AUTH_TOKEN,
            key: SECURITY_CONFIG.AUTH_HEADER_KEY,
            ts: Date.now().toString()
        });

        let requestOptions = { method };

        if (data) {
            if (useFormData) {
                const formData = new URLSearchParams();
                formData.append('data', JSON.stringify(data));
                requestOptions.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
                requestOptions.body = formData;
            } else {
                requestOptions.headers = { 'Content-Type': 'application/json' };
                requestOptions.body = JSON.stringify(data);
            }
        }

        const response = await fetch(`${serverUrl.replace(/\/$/, '')}${endpoint}?${authParams}`, requestOptions);

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            const errorMessage = error.error || `服务器错误: ${response.status}`;
            const errorObj = new Error(errorMessage);
            errorObj.status = response.status;
            errorObj.isPasswordError = response.status === 401 && errorMessage.includes('密码');
            throw errorObj;
        }

        return await response.json();
    },

    create: data => serverAPI.request('/create', 'POST', data, true),
    update: data => serverAPI.request('/update', 'POST', data, true),
    batchData: async (characters) => serverAPI.request('/batch/data', 'POST', {
        characters: characters.map((char, index) => ({
            name: char.nameGroup || char.name,
            uniqueValue: char.uniqueValue,
            clientId: index
        }))
    }, true)
};

const cooldownManager = {
    isActive: false,
    timeLeft: 0,
    timer: null,

    start: (duration = 30) => {
        cooldownManager.isActive = true;
        cooldownManager.timeLeft = duration;
        cooldownManager.timer = setInterval(() => {
            if (--cooldownManager.timeLeft <= 0) cooldownManager.stop();
        }, 1000);
    },

    stop: () => {
        clearInterval(cooldownManager.timer);
        Object.assign(cooldownManager, { isActive: false, timeLeft: 0, timer: null });
    },

    check: () => {
        if (cooldownManager.isActive) {
            utils.showToast(`操作冷却中，请等待 ${cooldownManager.timeLeft} 秒`, 'warning');
            return false;
        }
        return true;
    }
};

const dataCache = {
    CACHE_KEY: 'character_updater_cache',
    CACHE_EXPIRY: 24 * 60 * 60 * 1000,

    getCache: () => {
        try {
            const cached = localStorage.getItem(dataCache.CACHE_KEY);
            return cached ? JSON.parse(cached) : {};
        } catch { return {}; }
    },

    set: (key, data) => {
        try {
            const cache = dataCache.getCache();
            cache[key] = { ...data, cachedAt: Date.now() };
            localStorage.setItem(dataCache.CACHE_KEY, JSON.stringify(cache));
        } catch (error) {
            console.error('[小白X] 保存缓存失败:', error);
        }
    },

    get: key => {
        try {
            const cache = dataCache.getCache();
            const item = cache[key];
            if (!item || Date.now() - item.cachedAt > dataCache.CACHE_EXPIRY) {
                if (item) {
                    delete cache[key];
                    localStorage.setItem(dataCache.CACHE_KEY, JSON.stringify(cache));
                }
                return null;
            }
            return item;
        } catch { return null; }
    },

    getCloudData: charId => dataCache.get(charId)?.serverData || null,

    setBatch: (dataMap) => {
        try {
            const cache = dataCache.getCache();
            const timestamp = Date.now();
            dataMap.forEach((data, key) => {
                cache[key] = { ...data, cachedAt: timestamp };
            });
            localStorage.setItem(dataCache.CACHE_KEY, JSON.stringify(cache));
        } catch (error) {
            console.error('[小白X] 批量保存缓存失败:', error);
        }
    },

    clear: () => {
        try {
            localStorage.removeItem(dataCache.CACHE_KEY);
        } catch (error) {
            console.error('[小白X] 清除缓存失败:', error);
        }
    }
};

const longPressManager = {
    start: (element, onLongPress, onShortPress) => {
        let longPressTimer = null;

        element.on('mousedown touchstart', () => {
            longPressTimer = setTimeout(() => {
                longPressTimer = null;
                onLongPress();
            }, 3000);
        });

        element.on('mouseup touchend mouseleave', () => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        });

        element.on('click', () => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
                return;
            }
            onShortPress();
        });
    }
};

const menuManager = {
    showMenu: type => {
        $('.character-menu-overlay').hide();
        menuManager.updateUUIDDisplay(type);
        $(`#${type}-character-menu`).show();
    },

    closeMenu: type => {
        $(`#${type}-character-menu`).hide();
        $(`#${type}-password, #${type}-update-note, #${type}-png-url`).val('');
    },

    updateUUIDDisplay: type => {
        if (this_chid == null) return;
        const data = characterManager.getExtensionData(this_chid);
        const displays = {
            'bind': () => $('#bind-uuid-display').text('将自动生成'),
            'rebind': () => {
                $('#rebind-current-uuid').text(data?.uniqueValue || '未绑定');
                $('#rebind-new-uuid').text('将自动生成');
            },
            'update': () => $('#update-uuid-display').text(data?.uniqueValue || '未绑定')
        };
        displays[type]?.();
    },

    getFormData: type => ({
        password: $(`#${type}-password`).val().trim(),
        updateNote: $(`#${type}-update-note`).val().trim() ||
            (type === 'bind' ? '初始版本' : type === 'rebind' ? '重新绑定' : '版本更新'),
        pngUrl: $(`#${type}-png-url`).val().trim()
    }),

    validateForm: (type, data) => {
        const validations = [
            [!data.password || data.password.length < 4, '密码至少需要4个字符'],
            [data.pngUrl && !utils.validateUrl(data.pngUrl), '链接地址只能使用受信任的域名(rentry,dc)'],
            [data.updateNote.length > 300, '更新公告超过300字限制'],
            [data.pngUrl.length > 300, '链接地址超过300字限制']
        ];

        for (const [condition, message] of validations) {
            if (condition) {
                utils.showToast(message, 'error');
                return false;
            }
        }
        return true;
    },

    handleConfirm: async (type, isSilent = false) => {
        if (!cooldownManager.check() || this_chid == null) {
            if (this_chid == null) utils.showToast('请先选择一个角色', 'error');
            return;
        }

        const formData = menuManager.getFormData(type);
        if (!menuManager.validateForm(type, formData)) return;

        const $button = $(isSilent ? `#${type}-silent` : `#${type}-confirm`);
        const originalText = $button.text();

        try {
            $button.prop('disabled', true).text(isSilent ? '静默更新中...' : '处理中...');

            const actions = {
                'bind': () => businessLogic.bindCharacter(this_chid, formData),
                'rebind': async () => {
                    await characterManager.saveExtensionData(this_chid, {});
                    return businessLogic.bindCharacter(this_chid, formData);
                },
                'update': () => isSilent ?
                    businessLogic.silentUpdateCharacter(this_chid, formData) :
                    businessLogic.updateCharacter(this_chid, formData)
            };

            const result = await actions[type]();

            if (result.success) {
                const actionText = type === 'bind' ? '绑定' : type === 'rebind' ? '重新绑定' : (isSilent ? '静默更新' : '更新');
                utils.showToast(`角色${actionText}成功！`, 'success');
                cooldownManager.start(30);
                menuManager.closeMenu(type);
                setTimeout(() => uiManager.updateDisplay(), 500);
            } else {
                utils.showToast(`操作失败: ${result.error}`, 'error');
            }
        } catch (error) {
            console.error(`${type}操作失败:`, error);
            utils.showToast(error.isPasswordError ? '密码错误，请检查密码' : '操作失败，请检查网络连接', 'error');
        } finally {
            $button.prop('disabled', false).text(originalText);
        }
    }
};

const businessLogic = {
    bindCharacter: async (id, formData) => {
        const character = characterManager.getCharacter(id);
        if (!character) return { success: false, error: '角色不存在' };

        const uuid = utils.generateUUID();
        const timestamp = new Date().toISOString();
        let nameGroup = (character.name || "无名称角色卡").substring(0, 300);

        try {
            const result = await serverAPI.create({
                name: nameGroup,
                unique_value: uuid,
                password: utils.encryptPassword(formData.password),
                update_notice: formData.updateNote,
                link_address: formData.pngUrl,
                timestamp
            });

            if (!result.success) return { success: false, error: result.error };

            await characterManager.saveExtensionData(id, {
                nameGroup, uniqueValue: uuid, updateNote: formData.updateNote,
                linkAddress: formData.pngUrl, timestamp, bindTime: Date.now()
            });

            return { success: true, nameGroup, uniqueValue: uuid };
        } catch (error) {
            console.error('绑定失败:', error);
            return { success: false, error: error.isPasswordError ? '密码错误' : '网络连接失败' };
        }
    },

    updateCharacter: async (id, formData) => {
        const data = characterManager.getExtensionData(id);
        if (!characterManager.isBound(id)) return { success: false, error: '角色未绑定' };

        const timestamp = new Date().toISOString();
        return businessLogic.performUpdate(id, data, formData, timestamp, false);
    },

    silentUpdateCharacter: async (id, formData) => {
        const data = characterManager.getExtensionData(id);
        if (!characterManager.isBound(id)) return { success: false, error: '角色未绑定' };

        return businessLogic.performUpdate(id, data, formData, data.timestamp, true);
    },

    performUpdate: async (id, data, formData, timestamp, isSilent) => {
        try {
            const result = await serverAPI.update({
                name: data.nameGroup,
                unique_value: data.uniqueValue,
                password: utils.encryptPassword(formData.password),
                update_notice: formData.updateNote,
                link_address: formData.pngUrl,
                timestamp
            });

            if (!result.success) return { success: false, error: result.error };

            await characterManager.saveExtensionData(id, {
                ...data,
                updateNote: formData.updateNote,
                linkAddress: formData.pngUrl,
                timestamp,
                [isSilent ? 'lastSilentUpdateTime' : 'lastUpdateTime']: Date.now()
            });

            dataCache.set(id, {
                serverData: { timestamp, update_notice: formData.updateNote, link_address: formData.pngUrl }
            });

            return { success: true, timestamp };
        } catch (error) {
            console.error('更新失败:', error);
            return { success: false, error: error.isPasswordError ? '密码错误' : '网络连接失败' };
        }
    }
};

const uiManager = {
    updateDisplay: () => {
        const $name = $('#current-character-name');
        const $status = $('#current-character-status');

        if (this_chid == null) {
            $name.text('未选择角色');
            $status.removeClass().text('');
            characterEditUI.updateButtonState(false);
            return;
        }

        const character = characterManager.getCharacter(this_chid);
        if (!character) return;

        $name.text(character.name);
        const isBound = characterManager.isBound(this_chid);
        $status.removeClass().addClass(isBound ? 'bound' : 'unbound').text(isBound ? '已绑定' : '未绑定');

        if (!isBound) {
            characterEditUI.updateButtonState(false);
            characterListUI.removeUpdateNotification(this_chid);
        }
    },

    handleLongPress: () => {
        if (this_chid == null) {
            utils.showToast('请先选择一个角色', 'warning');
            return;
        }
        menuManager.showMenu(characterManager.isBound(this_chid) ? 'rebind' : 'bind');
    },

    handleShortPress: () => {
        if (this_chid == null) {
            utils.showToast('请先选择一个角色', 'warning');
            return;
        }

        if (characterManager.isBound(this_chid)) {
            menuManager.showMenu('update');
        } else {
            utils.showToast('角色尚未绑定，请长按3秒进行绑定', 'info');
        }
    },

    checkCurrentCharacterUpdate: async () => {
        if (this_chid == null || !characterManager.isBound(this_chid)) {
            characterEditUI.updateButtonState(false);
            return;
        }

        try {
            const data = characterManager.getExtensionData(this_chid);
            if (!data?.uniqueValue || !data?.nameGroup) return;

            const cloudData = dataCache.getCloudData(this_chid);
            if (!cloudData) {
                return;
            }

            const hasUpdate = cloudData.timestamp && cloudData.timestamp !== data.timestamp;
            characterEditUI.updateButtonState(hasUpdate);

            if (hasUpdate) {
                const character = characterManager.getCharacter(this_chid);
                const updateInfo = {
                    characterId: this_chid,
                    characterName: character?.name || '未知角色',
                    currentTimestamp: data.timestamp,
                    latestTimestamp: cloudData.timestamp,
                    updateNote: cloudData.update_notice || '無更新說明',
                    linkAddress: cloudData.link_address || '',
                    serverData: cloudData
                };
                characterListUI.addUpdateNotification(this_chid, updateInfo);
            } else {
                characterListUI.removeUpdateNotification(this_chid);
            }
        } catch (error) {
            console.error('[小白X] 检查角色更新状态失败:', error);
            characterEditUI.updateButtonState(false);
        }
    },

    restoreUpdateNotifications: async () => {
        try {
            const boundCharacters = characterManager.getAllBound();
            for (const charId of boundCharacters) {
                const data = characterManager.getExtensionData(charId);
                const cloudData = dataCache.getCloudData(charId);
                if (data && cloudData && cloudData.timestamp && cloudData.timestamp !== data.timestamp) {
                    const character = characterManager.getCharacter(charId);
                    const updateInfo = {
                        characterId: charId,
                        characterName: character?.name || '未知角色',
                        currentTimestamp: data.timestamp,
                        latestTimestamp: cloudData.timestamp,
                        updateNote: cloudData.update_notice || '無更新說明',
                        linkAddress: cloudData.link_address || '',
                        serverData: cloudData
                    };
                    characterListUI.addUpdateNotification(charId, updateInfo);
                }
            }
        } catch (error) {
            console.error('恢复更新通知失败:', error);
        }
    }
};

const characterListUI = {
    addUpdateNotification: (characterId, updateInfo) => {
        const characterElement = $(`#CharID${characterId}`);
        const nameBlock = characterElement.find('.character_name_block');
        if (!nameBlock.length) return;

        nameBlock.find('.character-update-notification').remove();

        const updateNotification = $(`
            <span class="character-update-notification" data-character-id="${characterId}">
                <i class="fa-solid fa-circle-exclamation"></i>
                <small>有可用更新</small>
            </span>
        `);

        updateNotification.on('click', e => {
            e.stopPropagation();
            popupManager.showUpdatePopup(updateInfo);
        });

        nameBlock.append(updateNotification);
    },

    removeUpdateNotification: characterId => {
        $(`#CharID${characterId}`).find('.character-update-notification').remove();
    }
};

const popupManager = {
    formatSimpleDate: timestamp => timestamp ? new Date(timestamp).toLocaleDateString() : 'Unknown',

    showUpdatePopup: async updateInfo => {
        // 只显示角色卡 data.character_book.name
        let charBookName = null;
        if (updateInfo?.characterId != null && typeof characters !== 'undefined') {
            const char = characters[updateInfo.characterId];
            charBookName = char?.data?.character_book?.name || null;
        }
        const hasUpdate = updateInfo?.latestTimestamp && updateInfo.latestTimestamp !== updateInfo.currentTimestamp;
        const sanitizedAnnouncementText = utils.sanitizeContent(updateInfo?.updateNote || 'No announcements available');
        const linkAddress = updateInfo?.linkAddress || '';
        const isValidUrl = linkAddress && utils.validateUrl(linkAddress);
        const sanitizedLinkAddress = isValidUrl ? utils.sanitizeContent(linkAddress) : '';

        // 用jQuery对象构造弹窗内容
        const $popup = $('<div class="character-update-popup"></div>');
        $popup.append(`<h3>${utils.sanitizeContent(updateInfo?.characterName || 'Unknown')} 更新信息</h3>`);
        $popup.append(`
            <div class="update-description">
                <strong style="color: #666; text-align: left; display: block;">${hasUpdate ? '最新更新公告:' : '上次更新公告:'}</strong>
                <div class="announcement-content" style="word-break: break-all; word-wrap: break-word; user-select: none; pointer-events: none; text-align: left;">${sanitizedAnnouncementText}</div>
            </div>`);
        $popup.append(`
            <div class="update-description">
                <strong style="color: #666; text-align: left; display: block;">${hasUpdate ? '最新更新地址:' : '更新地址:'}</strong>
                <div class="link-content" style="word-break: break-all; word-wrap: break-word; text-align: left;">${sanitizedLinkAddress || (linkAddress ? '该链接地址非dc或rentry来源, 不予显示' : '无链接地址')}</div>
            </div>`);

        const $lorebookInfo = $(`
            <div class="lorebook-info">
                <strong style="color: #666; text-align: left; display: block;">角色卡绑定的世界书信息</strong>
                <div style="margin: 8px; text-align: left; display: flex; align-items: center; justify-content: space-between;">
                    <span id="xiaobaix-character-book">${charBookName ? utils.sanitizeContent(charBookName) : '无'}</span>
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <input type="checkbox" id="xiaobaix_lorebook_info_delete" style="bottom: -3px;">
                        <label for="xiaobaix_lorebook_info_delete" style="margin-right: 10px;">清除世界书</label>
                    </div>
                </div>
            </div>


            <hr class="sysHR" style="margin-top: 15px;">
        `);

        $popup.append($lorebookInfo);


        if (isValidUrl) {
            $popup.append(`
<div class="update-container" style="display: flex; align-items: center; gap: 15px;">
    <div class="update-status" style="flex: 1;">
        <div style="margin-top: 20px; "class="status-message ${hasUpdate ? 'status-update' : 'status-success'}">
            <i class="fa-solid ${hasUpdate ? 'fa-exclamation-circle' : 'fa-check-circle'}"></i>
            ${hasUpdate ? '有可用更新' : '已是最新版本'}
        </div>
    </div>
    ${hasUpdate ? `
        <button class="menu_button" onclick="window.open('${linkAddress}', '_blank', 'noopener,noreferrer')" style="margin-top: 10px;">
            <i class="fa-solid fa-external-link-alt"></i>
            更新地址
        </button>
                ` : ''}
</div>


            <hr class="sysHR" style="margin-bottom: 15px;">
            `);
        $popup.append(`
            <div class="update-timestamps" style="color: #666;">
                <div><strong style="color: #666;">上次更新时间:</strong> ${popupManager.formatSimpleDate(updateInfo?.currentTimestamp)}</div>
                <div><strong style="color: #666;">最新更新时间:</strong> ${popupManager.formatSimpleDate(updateInfo?.latestTimestamp)}</div>
            </div>
`);

        }
        // 按钮区
        const $buttons = $(
            '<div class="xiaobaix-confirm-buttons">' +
            '  <button class="xiaobaix-confirm-yes" style="background-color: var(--crimson70a);">确认</button>' +
            '  <button class="xiaobaix-confirm-no">取消</button>' +
            '</div>'
        );
        $popup.append($buttons);


        // 弹窗插入body
        const $modal = $('<div class="xiaobaix-confirm-modal"></div>').append(
            $('<div class="xiaobaix-confirm-content"></div>').append($popup)
        );
        $('body').append($modal);

        // 事件绑定
        $buttons.find('.xiaobaix-confirm-yes').on('click', function () {
            const checked = $lorebookInfo.find('#xiaobaix_lorebook_info_delete').prop('checked');
            if (checked) {
                // 只保留模拟select和按钮点击的方案
                const $select = $('#world_editor_select');
                const $deleteBtn = $('#world_popup_delete');
                if ($select.length && $deleteBtn.length) {
                    const $option = $select.find('option').filter(function () {
                        return $(this).text().trim() === (charBookName ? charBookName.trim() : '');
                    });
                    if ($option.length) {
                        $select.val($option.val()).trigger('change');
                        setTimeout(() => {
                            $deleteBtn.trigger('click');
                        }, 200);
                    } else {
                        utils.showToast('未找到同名世界书，请检查世界书列表', 'error');
                    }
                }
                $modal.remove();
            } else {
                utils.showToast('请勾选删除世界书复选框', 'warning');
            }
        });
        $buttons.find('.xiaobaix-confirm-no').on('click', function () {
            $modal.remove();
        });
        $modal.on('click', function (e) {
            if (e.target === this) $modal.remove();
        });
        $(document).on('keydown.xiaobaixconfirm', function (e) {
            if (e.key === 'Escape') {
                $modal.remove();
                $(document).off('keydown.xiaobaixconfirm');
            }
        });
    },

    showGeneralInfoPopup: async characterName => {
        const characterData = characterManager.getExtensionData(this_chid);
        let cloudData = dataCache.getCloudData(this_chid);

        if (!cloudData) {
        }

        await popupManager.showUpdatePopup({
            characterId: this_chid,
            characterName,
            currentTimestamp: characterData?.timestamp || new Date().toISOString(),
            latestTimestamp: cloudData?.timestamp || characterData?.timestamp || new Date().toISOString(),
            updateNote: cloudData?.update_notice || characterData?.updateNote || '',
            linkAddress: cloudData?.link_address || characterData?.linkAddress || ''
        });
    }
};

const startupManager = {
    performStartupCheck: async () => {
        try {
            const boundCharacters = characterManager.getAllBound();
            if (boundCharacters.length === 0) {
                return;
            }

            const charactersToCheck = [];
            const characterMap = new Map();

            boundCharacters.forEach((charId, index) => {
                const data = characterManager.getExtensionData(charId);
                if (data?.uniqueValue && data?.nameGroup) {
                    charactersToCheck.push({
                        nameGroup: data.nameGroup,
                        uniqueValue: data.uniqueValue,
                        clientId: index,
                        localTimestamp: data.timestamp
                    });
                    characterMap.set(index, charId);
                }
            });

            if (charactersToCheck.length === 0) {
                return;
            }

            const batchResult = await serverAPI.batchData(charactersToCheck);

            if (batchResult.success && batchResult.results) {
                const cacheMap = new Map();
                const updates = [];

                batchResult.results.forEach(result => {
                    if (result.found && result.data) {
                        const charId = characterMap.get(result.clientId);
                        const localData = characterManager.getExtensionData(charId);

                        cacheMap.set(charId, { serverData: result.data });

                        if (result.data.timestamp && result.data.timestamp !== localData.timestamp) {
                            const character = characterManager.getCharacter(charId);
                            updates.push({
                                characterId: charId,
                                characterName: character?.name || '未知角色',
                                currentTimestamp: localData.timestamp,
                                latestTimestamp: result.data.timestamp,
                                updateNote: result.data.update_notice || '无更新说明',
                                linkAddress: result.data.link_address || '',
                                serverData: result.data
                            });
                        }
                    }
                });

                dataCache.setBatch(cacheMap);
                $('.character-update-notification').remove();
                updates.forEach(update => {
                    characterListUI.addUpdateNotification(update.characterId, update);
                });

                if (this_chid != null) {
                    const currentCharacterHasUpdate = updates.some(update => update.characterId === this_chid);
                    characterEditUI.updateButtonState(currentCharacterHasUpdate);

                    if (!currentCharacterHasUpdate && characterManager.isBound(this_chid)) {
                        setTimeout(() => uiManager.checkCurrentCharacterUpdate(), 1000);
                    }
                }

                console.log(`[小白X] 云端检查完成，发现 ${updates.length} 个角色有更新`);
            }
        } catch (error) {
            console.error('[小白X] 云端检查失败:', error);
        }
    }
};

const characterEditUI = {
    addCharacterEditButton: () => {
        if ($('#character-updater-edit-button').length > 0) return;

        const buttonHtml = `
            <div id="character-updater-edit-button" class="menu_button fa-solid fa-cloud-arrow-down interactable"
                 title="Check for character updates">
            </div>
        `;

        $('.form_create_bottom_buttons_block').prepend(buttonHtml);

        $('#character-updater-edit-button').on('click', async () => {
            if (this_chid == null) {
                utils.showToast('No character selected', 'warning');
                return;
            }

            if (!characterManager.isBound(this_chid)) {
                utils.showToast('Character is not bound to update service', 'warning');
                return;
            }

            try {
                const character = characterManager.getCharacter(this_chid);
                await popupManager.showGeneralInfoPopup(character.name);
            } catch (error) {
                console.error('显示角色信息失败:', error);
                utils.showToast('Failed to show character info', 'error');
            }
        });
    },

    updateButtonState: hasUpdate => {
        $('#character-updater-edit-button').toggleClass('has-update', hasUpdate);
    }
};

async function initCharacterUpdater() {
    if (moduleState.isInitialized) return;

    if (window.registerModuleCleanup) {
        window.registerModuleCleanup(MODULE_NAME, cleanup);
    }

    await addMenusHTML();
    bindEvents();
    characterEditUI.addCharacterEditButton();

    uiManager.updateDisplay();
    moduleState.isInitialized = true;
}

function cleanup() {
    Object.keys(moduleState.eventHandlers).forEach(eventType => {
        eventSource.off(eventType, moduleState.eventHandlers[eventType]);
    });
    moduleState.eventHandlers = {};

    $('.character-menu-overlay, #character-updater-edit-button, .character-update-notification').remove();
    dataCache.clear();
    moduleState.isInitialized = false;
}

async function addMenusHTML() {
    try {
        const response = await fetch(`${extensionFolderPath}/character-updater-menus.html`);
        if (response.ok) {
            $('body').append(await response.text());
        }
    } catch (error) {
        console.error('[小白X-角色更新] 加载菜单HTML失败:', error);
    }
}

function bindEvents() {
    $(document.body).on('click', '#bind-confirm', () => menuManager.handleConfirm('bind'));
    $(document.body).on('click', '#rebind-confirm', () => menuManager.handleConfirm('rebind'));
    $(document.body).on('click', '#update-confirm', () => menuManager.handleConfirm('update'));
    $(document.body).on('click', '#update-silent', () => menuManager.handleConfirm('update', true));

    ['bind', 'rebind', 'update'].forEach(type => {
        $(document.body).on('click', `#${type}-menu-close, #${type}-cancel`, () => menuManager.closeMenu(type));
    });

    $(document.body).on('click', '.character-menu-overlay', function (e) {
        if (e.target === this) $(this).hide();
    });

    const trigger = $('#current-character-info-trigger');
    if (trigger.length) {
        longPressManager.start(trigger, () => uiManager.handleLongPress(), () => uiManager.handleShortPress());
    }

    const eventHandlers = {
        [event_types.APP_READY]: async () => {
            await startupManager.performStartupCheck();
        },
        [event_types.CHAT_CHANGED]: async () => {
            uiManager.updateDisplay();
            if (this_chid != null && characterManager.isBound(this_chid)) {
                await uiManager.checkCurrentCharacterUpdate();
            }
        },
        [event_types.CHARACTER_EDITED]: () => uiManager.updateDisplay(),
        [event_types.CHARACTER_PAGE_LOADED]: () => uiManager.restoreUpdateNotifications()
    };

    Object.entries(eventHandlers).forEach(([eventType, handler]) => {
        moduleState.eventHandlers[eventType] = handler;
        eventSource.on(eventType, handler);
    });
}

export { initCharacterUpdater };
