import { setExtensionPrompt, extension_prompt_types, extension_prompt_roles, characters, this_chid, eventSource, event_types } from "../../../../script.js";
import { extension_settings, getContext, writeExtensionField } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { accountStorage } from "../../../util/AccountStorage.js";

// ==================== 数据管理层 ====================
class StatsDataManager {
    constructor(executeCommand) {
        this.executeCommand = executeCommand;
    }

    createEmptyStats() {
        return {
            dialogueCount: 0,
            locationChanges: 0,
            intimacyStats: {
                kissingEvents: 0, embraceEvents: 0, sexualEncounters: 0,
                maleOrgasms: 0, femaleOrgasms: 0, oralCompletions: 0, internalCompletions: 0
            },
            violenceStats: { hitEvents: 0, weaponUse: 0, deathEvents: 0 },
            exchangeStats: { giftGiving: 0, moneyTransfer: 0 },
            emotionStats: {
                positiveEmotions: 0, negativeEmotions: 0, loveExpressions: 0,
                angerOutbursts: 0, fearEvents: 0, sadnessEvents: 0, joyEvents: 0, surpriseEvents: 0
            },
            relationshipStats: { intimacyLevel: 0, emotionalChange: 0 },
            relationships: {}
        };
    }

    async loadStats() {
        let stats = await this.executeCommand('/getvar xiaobaix_stats');
        if (!stats || stats === "undefined") {
            return this.createEmptyStats();
        }
        try {
            return typeof stats === 'string' ? JSON.parse(stats) : stats;
        } catch (e) {
            return this.createEmptyStats();
        }
    }

    async saveStats(stats) {
        await this.executeCommand(`/setvar key=xiaobaix_stats ${JSON.stringify(stats)}`);
    }

    async clearStats() {
        await this.executeCommand('/flushvar xiaobaix_stats');
    }

    async loadRelationshipSettingsFromCharacter() {
        if (!this_chid || !characters[this_chid]) return null;

        const character = characters[this_chid];
        const extensions = character.data?.extensions;
        if (!extensions) return null;

        const possibleFieldNames = ['statsTracker_behavior', 'LittleWhiteBox', 'xiaobaix'];
        for (const fieldName of possibleFieldNames) {
            if (extensions[fieldName]?.relationshipGuidelines) {
                return extensions[fieldName];
            }
        }
        return null;
    }

    async saveRelationshipSettingsToCharacter(MODULE_NAME, behaviorSettings, trackedRelationships, settings) {
        if (!this_chid || !characters[this_chid]) return false;

        try {
            const dataToSave = {
                relationshipGuidelines: behaviorSettings,
                trackedRelationships: trackedRelationships,
                settings: settings,
                version: "1.4",
                lastUpdated: new Date().toISOString(),
                creatorMode: true,
                characterName: characters[this_chid].name
            };

            await writeExtensionField(Number(this_chid), MODULE_NAME, dataToSave);
            await writeExtensionField(Number(this_chid), 'statsTracker_behavior', dataToSave);
            return true;
        } catch (error) {
            return false;
        }
    }

    exportBehaviorSettings(behaviorSettings, trackedRelationships, settings) {
        const exportData = {
            relationshipGuidelines: behaviorSettings,
            trackedRelationships: trackedRelationships,
            settings: settings,
            characterInfo: this_chid && characters[this_chid] ? {
                id: this_chid,
                name: characters[this_chid].name,
                avatar: characters[this_chid].avatar
            } : null,
            version: "1.4",
            exportDate: new Date().toISOString(),
            creatorMode: true
        };

        const characterName = exportData.characterInfo?.name || 'default';
        const dateStr = new Date().toISOString().slice(0, 10);
        const fileName = `statsTracker_${characterName}_${dateStr}.json`;
        const fileData = JSON.stringify(exportData, null, 4);

        const blob = new Blob([fileData], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        return fileName;
    }

    async importBehaviorSettings(file, executeCommand, relationshipGuidelines, characterSettings, currentCharacterId, settings, EXT_ID) {
        if (!file) {
            executeCommand('/echo 未选择文件');
            return;
        }

        try {
            const fileText = await this.getFileText(file);
            const importData = JSON.parse(fileText);

            if (!importData.relationshipGuidelines) {
                throw new Error('文件格式不正确：缺少 relationshipGuidelines');
            }

            const requiredStages = Object.keys(relationshipGuidelines);
            const importedStages = Object.keys(importData.relationshipGuidelines);

            for (const stage of requiredStages) {
                if (!importedStages.includes(stage)) {
                    throw new Error(`文件格式不正确：缺少关系阶段 "${stage}"`);
                }

                const stageData = importData.relationshipGuidelines[stage];
                if (!stageData.attitude || !stageData.allowed || !stageData.limits) {
                    throw new Error(`文件格式不正确：关系阶段 "${stage}" 数据不完整`);
                }
            }

            const hasTrackedRelationships = importData.trackedRelationships && Object.keys(importData.trackedRelationships).length > 0;
            const isCharacterSpecific = importData.characterInfo && this_chid && characters[this_chid];
            const isMatchingCharacter = isCharacterSpecific && importData.characterInfo.name === characters[this_chid].name;

            let confirmMessage = `确定要导入行为设定吗？\n\n文件信息：\n版本：${importData.version || '未知'}\n导出日期：${importData.exportDate ? new Date(importData.exportDate).toLocaleString() : '未知'}`;

            if (importData.characterInfo) {
                confirmMessage += `\n原角色：${importData.characterInfo.name}`;
                if (isCharacterSpecific) {
                    confirmMessage += `\n当前角色：${characters[this_chid].name}`;
                    if (isMatchingCharacter) {
                        confirmMessage += `\n✅ 角色匹配`;
                    } else {
                        confirmMessage += `\n⚠️ 角色不匹配`;
                    }
                }
            }

            if (hasTrackedRelationships) {
                const relationshipNames = Object.keys(importData.trackedRelationships);
                confirmMessage += `\n追踪人物：${relationshipNames.join(', ')} (共${relationshipNames.length}个)`;
                confirmMessage += `\n包含初始好感度设定`;
            }

            confirmMessage += `\n\n这将覆盖当前角色的所有设定。`;

            return { importData, confirmMessage, hasTrackedRelationships, isCharacterSpecific, isMatchingCharacter };

        } catch (error) {
            executeCommand(`/echo 导入失败：${error.message}`);
            return null;
        }
    }

    getFileText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = (e) => reject(new Error('文件读取失败'));
            reader.readAsText(file);
        });
    }

    async processMessageHistory() {
        try {
            const messagesText = await this.executeCommand('/messages names=on');
            if (!messagesText) return [];

            const messageBlocks = messagesText.split('\n\n');
            const messages = [];

            for (let i = 0; i < messageBlocks.length; i++) {
                const block = messageBlocks[i].trim();
                if (!block) continue;

                const colonIndex = block.indexOf(':');
                if (colonIndex === -1) continue;

                const name = block.substring(0, colonIndex).trim();
                const content = block.substring(colonIndex + 1).trim();

                if (name !== getContext().name1) {
                    messages.push({ name, content });
                }
            }

            return messages;
        } catch (error) {
            return [];
        }
    }
}

// ==================== NLP分析引擎 ====================
class TextAnalysisEngine {
    constructor(relationshipManager) {
        this.relationshipManager = relationshipManager;
        this.SENTIMENT_LEXICON = {
            kiss: { regex: /亲吻|吻|嘴唇|舌头交缠|深吻|热吻|轻啄|啄吻|吻上|吻住|亲了|亲住|亲上|嘴对嘴|嘴唇相触/g, score: 1, stats_event: 'kissingEvents' },
            embrace: { regex: /拥抱|抱住|搂住|紧抱|依偎|相拥|抱紧|抱在怀里|抱在一起|搂在怀中|拥入怀中|相拥而泣|相拥而眠|相拥入睡|挽着|靠在肩上|靠在怀里|偎依|依靠|搂着|抱着|环抱|环住|相互依偎|相互依靠|被抱住|被拥入|揽入怀中|投入怀抱/g, score: 0.5, stats_event: 'embraceEvents' },
            sexual: { regex: /(阳具|阴茎|肉棒|白浊|精液|精子|龟头|马眼).*?(射|喷|爆发|释放|射精|高潮|喷涌|激射|喷射|喷发|喷洒|迸发)/g, score: 1, stats_event: 'sexualEncounters' },
            female_orgasm: { regex: /(?<!射)(高潮|达到了.*高潮|颤抖.*高潮|痉挛|花心|蜜液|喷涌|抽搐|子宫)/g, score: 1, stats_event: 'femaleOrgasms' },
            male_orgasm: { regex: /(阳具|阴茎|肉棒|白浊|精液|精子|龟头|马眼).*?(射|喷|爆发|释放|射精|高潮|喷涌|激射|喷射|喷发|喷洒|迸发)/g, score: 1, stats_event: 'maleOrgasms' },
            oral_comp: { regex: /吞下|咽下|吞咽|喝下/g, score: 1, stats_event: 'oralCompletions', requires: /精液|精子|白浊/g },
            internal_comp: { regex: /射入|灌入|注入|流入|内射|灌满/g, score: 1, stats_event: 'internalCompletions', requires: /精液|精子|白浊|热流|种子|液体/g },
            smile: { regex: /微笑|笑容|笑着|开心|高兴|快乐|欣喜|兴奋|愉悦|喜悦|欢快|愉快|乐呵|蹦蹦跳跳|一蹦一跳|眉开眼笑|喜笑颜开|乐滋滋|欢喜|雀跃/g, score: 0.5, stats_event: 'positiveEmotions' },
            shy: { regex: /羞涩|害羞|脸红|心动|期待|舒服|信任|依赖/g, score: 0.5, stats_event: 'positiveEmotions' },
            love: { regex: /我.*?爱你|我.*?喜欢你|爱上了你|迷上了你|深爱着你|钟情于你|倾心|倾慕|仰慕|臣服|迷恋|深情|挚爱|心仪|心悦|青睐|心生爱意|怦然心动/g, score: 1, stats_event: 'loveExpressions' },
            praise: { regex: /赞美|夸赞|称赞|表扬|好棒|真棒|厉害|了不起|优秀|出色|完美|很棒|真行|很厉害|太棒了|棒极了|真不错|佩服|赞赏|欣赏/g, score: 0.5, stats_event: 'positiveEmotions' },
            care: { regex: /关心|关怀|体贴|照顾|呵护|保护|心疼|疼爱|爱护|牵挂|挂念|在乎|惦记|温柔|细心|体恤|体谅|关爱|爱怜|宠爱/g, score: 0.5, stats_event: 'positiveEmotions' },
            hit: { regex: /揍|踢|掌掴|拳头|殴打|击打|重击|鞭打|挨打|扇耳光|暴揍|暴打|痛击|摔打|撞击|殴斗/g, score: -2, stats_event: 'hitEvents' },
            weapon: { regex: /刀|剑|枪|弓箭|匕首|射击|开枪|砍|斩/g, score: -0.1, stats_event: 'weaponUse' },
            death: { regex: /死亡|丧命|毙命|牺牲|身亡|丧生|亡故|逝世/g, score: -0.2, stats_event: 'deathEvents' },
            sad: { regex: /悲伤|难过|伤心|痛苦|心痛|愤怒|生气|恐惧|害怕|抑郁|沮丧|郁闷|忧伤|失落|苦涩|心碎|悲哀|伤感|绝望|哀伤|酸楚|郁结|失意|黯然|悲凉/g, score: -1, stats_event: 'negativeEmotions' },
            disgust: { regex: /厌恶|恶心|反感|不耐烦|讨厌|失望|不屑|讽刺|嘲讽|挖苦|厌烦|鄙视|看不起|嫌恶|嗤之以鼻|反胃|抵触|排斥|嫌弃|唾弃|嫌恶|厌倦|反感|不悦|不爽|烦躁|烦闷|恼火/g, score: -1, stats_event: 'negativeEmotions' },
            cold: { regex: /冷笑|冰冷|寒气|刀一样|冷眼|冷漠|漠然|不理不睬|冷酷|无情|冷若冰霜|漠不关心|嗤笑|冷哼|冷言冷语|阴阳怪气|冷冷地|冷淡地|冷漠地|疏离|疏远|敷衍|应付|敷衍了事/g, score: -0.6, stats_event: 'negativeEmotions' },
            complex_positive: { regex: /欣慕|敬仰|崇拜|尊敬|仰慕|仰望|敬重|敬爱|尊崇|爱戴/g, score: 0.8, stats_event: 'positiveEmotions' },
            complex_negative: { regex: /惋惜|遗憾|叹息|惆怅|懊悔|内疚|自责|自责|惭愧|歉疚/g, score: 0.4, stats_event: 'negativeEmotions' },
            uncomfortable: { regex: /不自在|别扭|不舒服|不自然|不安|慌张|不悦|不喜|不爽|不适|不快/g, score: -0.5, stats_event: 'negativeEmotions' }
        };

        this.GRAMMAR_LEXICON = {
            physicalActions: /推|拉|打|踢|抓|握|摸|抚|摩|搂|抱|亲|吻|舔|咬|掐|挠|戳|碰|触|压|按|举|抬|放|扔|丢|递|给|送|接|拿|取|拽|扯|撕|划|切|刺|插|捅|顶|撞|踹|踩|蹬|跨|骑|爬|攀|抠|挖|刨|埋|盖|遮|挡|移|推开|拉开/g,
            verbalActions: /说|讲|谈|聊|叫|喊|吼|骂|斥|责|问|询|答|回|告诉|通知|宣布|声明|承认|否认|解释|澄清|抱怨|抗议|请求|要求|命令|指示|建议|劝告|警告|提醒|威胁|恐吓|安慰|鼓励|夸|赞|批评|指责|嘲笑|讽刺|调侃|开玩笑/g,
            mentalActions: /想|思考|考虑|琢磨|回忆|记起|忘记|意识到|察觉|发现|注意到|观察|分析|判断|决定|选择|相信|怀疑|担心|害怕|紧张|放松|集中|专注|走神|发呆|梦见|想象|幻想|期待|盼望|希望|失望|后悔|遗憾/g,
            motionActions: /走|跑|来|去|进入|离开|站|坐|躺|转身|移动|飞|跳|游|滑|爬|行|退|前进|后退|旋转|旋身|扭|扭转|弯|弯曲|俯身|起身|抬头|低头|侧身|挪动|倾斜|侧倾/g,
            expressionActions: /笑|哭|叹气|皱眉|瞪|看|盯|瞥|望|凝视|睁|眯|扫视|打量|张望|注视|咬唇|微笑|大笑|狂笑|咧嘴|龇牙|撇嘴|抿嘴|咬牙|咬嘴唇|挑眉|蹙眉|皱眉头|扬眉|眨眼|闭眼|流泪/g,
            passiveMarkers: /被|遭到|受到|让|使|令/g,
            pivotalMarkers: /让|使|叫|请|命令|要求.*?去|要求.*?做/g,
            emotionVerbs: /感到|感觉|觉得|体验|经历|遭受|承受|享受|喜欢|爱|恨|厌恶|讨厌|害怕|担忧|困惑|迷惑|兴奋|激动|紧张|焦虑|冷静|平静|舒缓|惬意|满足|满意|不满|开心|快乐|高兴|悲伤|难过|伤心|愤怒|生气|恼怒|惊讶|吃惊|惊愕/g
        };

        this.CONTEXT_LEXICON = {
            descriptive: /形容|描述|状态|样子|外表|外观|表面|看起来|感觉上|似乎|好像|仿佛/,
            physical: /温度|气候|天气|冷|热|温暖|凉|冰|火|水|湿|干|触感|质地/,
            factual: /事实|实际|确实|的确|客观|真相|真实|证明|表明|显示|数据|结果/,
            past: /曾经|以前|过去|那时|当时|回忆|记得|想起|记忆中|往日/,
            hypothetical: /如果|假如|假设|若是|倘若|设想|想象|可能|或许|也许|兴许/
        };

        this.sentencePatterns = {
            passive: [
                { regex: /(\w+)被(\w+)(.+?)(动词)/g, subjectIndex: 2, objectIndex: 1 },
                { regex: /(\w+)遭(\w+)(.+?)(动词)/g, subjectIndex: 2, objectIndex: 1 },
                { regex: /(\w+)遭到(\w+)(.+?)(动词)/g, subjectIndex: 2, objectIndex: 1 }
            ],
            pivotal: [
                { regex: /(\w+)(让|使|叫)(\w+)(.+?)(动词)/g, subjectIndex: 1, objectIndex: 3 },
                { regex: /(\w+)(请|命令|要求)(\w+)(.+?)(动词)/g, subjectIndex: 1, objectIndex: 3 }
            ],
            inverted: [
                { regex: /(.+?)的(是|为|乃)(\w+)/g, subjectIndex: 3 }
            ],
            direct: [
                { regex: /^(\w+)(.+?)(动词)/g, subjectIndex: 1 },
                { regex: /^(\w+)[:：]/g, subjectIndex: 1 }
            ],
            pronoun: [
                { regex: /^(她|他)(.+?)(动词)/g, subjectIndex: 1 }
            ]
        };

        this.quoteChars = ['\u0022', '\u201C', '\u201D', '\u2018', '\u2019', '\u300C', '\u300D', '\u300E', '\u300F', '\u301D', '\u301E', '\u301F', '\uFF02', '\u2033', '\u2036'];
        this.excludedXmlTags = ['thinking', 'think', 'cot', 'summary', 'details'];
        this.pronounMapping = new Map();
        this.userSettings = {
            gender: 'unknown',
            aliases: []
        };
    }

    updateUserSettings(userSettings) {
        this.userSettings = userSettings;
    }
    getCurrentCharacterName() {
        if (this_chid && characters[this_chid]) {
            return characters[this_chid].name;
        }
        return null;
    }
    filterXmlTags(text) {
        if (!text || typeof text !== 'string') return text;

        let filteredText = text;
        this.excludedXmlTags.forEach(tag => {
            const regex = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
            filteredText = filteredText.replace(regex, '');
        });

        return filteredText.trim();
    }

    splitIntoSentences(text) {
        const sentences = [];
        let current = '';
        let quoteLevel = 0;

        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            current += char;

            if (this.quoteChars.includes(char)) {
                quoteLevel = quoteLevel === 0 ? 1 : 0;
            }

            if (quoteLevel === 0 && /[。！？.!?]/.test(char)) {
                const nextChar = text[i + 1];
                if (!nextChar || !/\d/.test(nextChar)) {
                    sentences.push(current.trim());
                    current = '';
                }
            } else if (char === '\n') {
                if (current.trim()) {
                    sentences.push(current.trim());
                }
                current = '';
            }
        }

        if (current.trim()) {
            sentences.push(current.trim());
        }

        return sentences.filter(s => s.length > 0);
    }

    parseCompoundSentence(sentence) {
        const separators = /[，,。.、；;而且|但是|不过|然而|却|同时|并且|此外|而|与|和]/g;

        let inQuote = false;
        let quoteChar = '';
        let subSentences = [];
        let currentSubSentence = '';

        for (let i = 0; i < sentence.length; i++) {
            const char = sentence[i];

            if (this.quoteChars.includes(char)) {
                inQuote = !inQuote;
                quoteChar = char;
                currentSubSentence += char;
                continue;
            }

            if (inQuote) {
                currentSubSentence += char;
                continue;
            }

            if (separators.test(char)) {
                if (currentSubSentence.trim().length > 0) {
                    subSentences.push(currentSubSentence.trim());
                }
                currentSubSentence = '';
            } else {
                currentSubSentence += char;
            }
        }

        if (currentSubSentence.trim().length > 0) {
            subSentences.push(currentSubSentence.trim());
        }

        return subSentences.filter(s => s.length > 0);
    }

    resolvePronounsInSentences(sentences, trackedNamesData) {
        let lastMentionedPerson = null;
        let lastMentionedMale = null;
        let lastMentionedFemale = null;

        const genderMap = {};
        trackedNamesData.forEach(nameData => {
            if (typeof nameData === 'object') {
                genderMap[nameData.name] = nameData.gender;
            }
        });

        return sentences.map(sentence => {
            const trackedNames = trackedNamesData.map(data =>
                typeof data === 'string' ? data : data.name
            );

            const mentionedPersons = trackedNames.filter(name => sentence.includes(name));

            if (mentionedPersons.length > 0) {
                lastMentionedPerson = mentionedPersons[0];

                const gender = genderMap[lastMentionedPerson];

                if (gender === 'female') {
                    this.pronounMapping.set('她', lastMentionedPerson);
                    lastMentionedFemale = lastMentionedPerson;
                } else if (gender === 'male') {
                    this.pronounMapping.set('他', lastMentionedPerson);
                    lastMentionedMale = lastMentionedPerson;
                }
            }

            let impliedPerson = null;

            if (/^她/.test(sentence) && this.pronounMapping.has('她')) {
                const mappedPerson = this.pronounMapping.get('她');
                if (this.userSettings.gender === 'female' && this.couldReferToUser(sentence)) {
                    impliedPerson = this.disambiguatePronoun(sentence, mappedPerson, 'user');
                } else {
                    impliedPerson = mappedPerson;
                }
            } else if (/^他/.test(sentence) && this.pronounMapping.has('他')) {
                const mappedPerson = this.pronounMapping.get('他');
                if (this.userSettings.gender === 'male' && this.couldReferToUser(sentence)) {
                    impliedPerson = this.disambiguatePronoun(sentence, mappedPerson, 'user');
                } else {
                    impliedPerson = mappedPerson;
                }
            } else if (/^[^，。！？""'']*?，\s*她/.test(sentence) && lastMentionedFemale) {
                impliedPerson = lastMentionedFemale;
            } else if (/^[^，。！？""'']*?，\s*他/.test(sentence) && lastMentionedMale) {
                impliedPerson = lastMentionedMale;
            }

            return {
                originalSentence: sentence,
                impliedPerson: impliedPerson,
                mentionedPersons: mentionedPersons
            };
        });
    }

    couldReferToUser(sentence) {
        const userRefs = this.identifyUserReferences(sentence, getContext().name1);
        return userRefs.length === 0;
    }

    disambiguatePronoun(sentence, npcName, userIndicator) {
        const userDirectedPatterns = [
            /对.*?说/, /看着/, /望着/, /问/, /告诉/, /关心/, /担心/, /喜欢/, /爱/
        ];

        for (const pattern of userDirectedPatterns) {
            if (pattern.test(sentence)) {
                return userIndicator;
            }
        }

        return npcName;
    }

    splitIntoSubClauses(sentence) {
        const clauseSeparators = /[，,。！!？?；;]/g;
        let subClauses = [];
        let lastIndex = 0;
        let match;

        while ((match = clauseSeparators.exec(sentence)) !== null) {
            const clause = sentence.substring(lastIndex, match.index + 1).trim();
            if (clause) {
                subClauses.push(clause);
            }
            lastIndex = match.index + 1;
        }

        if (lastIndex < sentence.length) {
            const lastClause = sentence.substring(lastIndex).trim();
            if (lastClause) {
                subClauses.push(lastClause);
            }
        }

        if (subClauses.length === 0) {
            subClauses.push(sentence);
        }

        return subClauses;
    }

    isNegationAffectingMatch(clauseText, match) {
        const matchIndex = clauseText.indexOf(match);
        if (matchIndex === -1) return false;

        const preText = clauseText.substring(0, matchIndex);

        const negationWords = [
            '不', '没', '未', '无', '非', '别', '勿', '莫', '决不', '绝不',
            '绝非', '并非', '决非', '不是', '不会', '不能', '不可', '不必',
            '不用', '不要', '不该', '没有', '毫不', '根本不', '完全不'
        ];

        for (const negWord of negationWords) {
            const negIndex = preText.lastIndexOf(negWord);
            if (negIndex !== -1) {
                const distance = matchIndex - (negIndex + negWord.length);

                if (distance >= 0 && distance <= 5) {
                    return true;
                }

                const betweenText = preText.substring(negIndex + negWord.length);
                if (betweenText.match(/的|地|得|很|那么|如此|这么/)) {
                    return true;
                }
            }
        }

        return false;
    }

    handleNegationEnhanced(sentence, match, baseScore) {
        const subClauses = this.splitIntoSubClauses(sentence);

        let matchClause = '';
        for (const clause of subClauses) {
            if (clause.includes(match)) {
                matchClause = clause;
                break;
            }
        }

        if (!matchClause) {
            matchClause = sentence;
        }

        if (this.isNegationAffectingMatch(matchClause, match)) {
            return -baseScore * 0.7;
        }

        return baseScore;
    }

    analyzeContextualMeaning(sentence, match, lexiconItem) {
        const matchIndex = sentence.indexOf(match);
        const preContext = sentence.substring(Math.max(0, matchIndex - 25), matchIndex);
        const postContext = sentence.substring(matchIndex + match.length, Math.min(sentence.length, matchIndex + match.length + 25));
        const fullContext = preContext + match + postContext;

        const isInQuotes = this.quoteChars.some(char => {
            const quotePattern = new RegExp(`${char}[^${char}]*${match}[^${char}]*${char}`);
            return quotePattern.test(fullContext);
        });

        if (isInQuotes) {
            return lexiconItem.score * 1.2;
        }

        const behaviorPatterns = [
            /眼神|眼光|目光|视线|眉头|表情|脸色|面容|面色|神色|眼中|眼里|眼睛|嘴角|微微|动作|姿态|语气|声音|语调/
        ];

        for (const pattern of behaviorPatterns) {
            if (pattern.test(preContext) || pattern.test(postContext)) {
                return lexiconItem.score * 1.1;
            }
        }

        for (const [contextType, pattern] of Object.entries(this.CONTEXT_LEXICON)) {
            if (pattern.test(fullContext)) {
                switch (contextType) {
                    case 'descriptive':
                        return lexiconItem.score * 0.4;
                    case 'physical':
                        return lexiconItem.score * 0.3;
                    case 'factual':
                        return lexiconItem.score * 0.2;
                    case 'past':
                        return lexiconItem.score * 0.6;
                    case 'hypothetical':
                        return lexiconItem.score * 0.4;
                    default:
                        return lexiconItem.score * 0.8;
                }
            }
        }

        return lexiconItem.score;
    }

    calculateEnhancedSentimentScore(sentence) {
        if (!sentence || typeof sentence !== 'string') return { score: 0, matches: [] };

        let totalScore = 0;
        let matchedItems = [];

        Object.entries(this.SENTIMENT_LEXICON).forEach(([key, lexiconItem]) => {
            const matches = sentence.match(lexiconItem.regex);
            if (!matches) return;

            if (lexiconItem.requires && !lexiconItem.requires.test(sentence)) {
                return;
            }

            matches.forEach(match => {
                const contextScore = this.analyzeContextualMeaning(sentence, match, lexiconItem);
                const finalScore = this.handleNegationEnhanced(sentence, match, contextScore);

                matchedItems.push({
                    type: key,
                    match: match,
                    originalScore: lexiconItem.score,
                    finalScore: finalScore
                });

                totalScore += finalScore;
            });
        });

        return {
            score: totalScore,
            matches: matchedItems
        };
    }

    identifyUserReferences(sentence, userName) {
        const userReferences = new Set();

        const secondPersonPatterns = [
            /你/g,
            /您/g
        ];

        const thirdPersonPatterns = [];
        if (userName) {
            thirdPersonPatterns.push(new RegExp(userName, 'g'));
        }
        thirdPersonPatterns.push(/\{\{user\}\}/g);

        secondPersonPatterns.forEach(pattern => {
            const matches = sentence.match(pattern);
            if (matches) {
                matches.forEach(() => userReferences.add('你'));
            }
        });

        thirdPersonPatterns.forEach(pattern => {
            const matches = sentence.match(pattern);
            if (matches) {
                matches.forEach(() => userReferences.add(userName || 'user'));
            }
        });

        this.userSettings.aliases.forEach(alias => {
            const aliasPattern = new RegExp(alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
            if (aliasPattern.test(sentence)) {
                userReferences.add(alias);
            }
        });

        return Array.from(userReferences);
    }

    identifyEmotionTarget(sentence, subject, trackedNames, userName) {
        if (!subject || !subject.name) return 'unknown';

        const userRefs = this.identifyUserReferences(sentence, userName);

        if (userRefs.includes(subject.name) || subject.name === userName) {
            return 'from_user';
        }

        const selfPatterns = [
            /自己|本身|内心|自我|心中|感到|觉得|认为|意识到|明白|了解/,
            new RegExp(`${subject.name}.*?(的心情|的感受|的想法|的心境)`),
            /内在|本性|性格|自尊|自信|自卑|自省/
        ];

        for (const pattern of selfPatterns) {
            if (pattern.test(sentence)) {
                return 'self';
            }
        }

        if (userRefs.length > 0) {
            const emotionToUserPatterns = [
                /对你|向你|给你|为你|因你|朝你|冲你/,
                /对.*?你|向.*?你|给.*?你/,
                /看着你|望着你|盯着你|凝视.*?你/,
                /对方|他人|别人|来访者/,
            ];

            if (userName) {
                emotionToUserPatterns.push(new RegExp(`对.*?${userName}|向.*?${userName}|给.*?${userName}`));
            }

            for (const pattern of emotionToUserPatterns) {
                if (pattern.test(sentence)) {
                    return 'to_user';
                }
            }

            return 'to_user';
        }

        for (const name of trackedNames) {
            if (name !== subject.name && sentence.includes(name)) {
                return 'to_other_npc';
            }
        }

        return 'unknown';
    }

    findSpeakerInText(text, defaultSpeaker, trackedNames) {
        if (!text) return null;

        const speakerPatterns = [
            /([^，。！？\s]+)(?:说道|说|问道|问|回答道|回答|喊道|叫道|答道|叹道|笑道|冷冷地说)[:：]?\s*["'""''「」『』]/,
            /([^，。！？\s]+)[:：]\s*["'""''「」『』]/,
            /["'""''「」『』](?:[^"'""''「」『』]+)["'""''「」『』](?:[，。！？\s]*)([^，。！？\s]+)(?:说道|说|表示|回应|道)/
        ];

        for (const pattern of speakerPatterns) {
            const match = text.match(pattern);
            if (match) {
                const potentialSpeaker = match[1];
                for (const name of trackedNames) {
                    if (potentialSpeaker.includes(name)) {
                        return name;
                    }
                }
            }
        }

        const speakingWords = ['说', '道', '问', '答', '叹', '笑', '喊', '回应', '表示', '冷冷地'];
        for (const name of trackedNames) {
            for (const word of speakingWords) {
                if (text.includes(`${name}${word}`)) {
                    return name;
                }
            }
        }

        const quoteIndex = text.search(/["'""''「」『』]/);
        if (quoteIndex > 0) {
            const textBeforeQuote = text.substring(0, quoteIndex);
            for (const name of trackedNames) {
                if (textBeforeQuote.includes(name)) {
                    const nameIndex = textBeforeQuote.lastIndexOf(name);
                    let isLastName = true;
                    for (const otherName of trackedNames) {
                        if (otherName !== name && textBeforeQuote.lastIndexOf(otherName) > nameIndex) {
                            isLastName = false;
                            break;
                        }
                    }
                    if (isLastName) {
                        return name;
                    }
                }
            }
        }

        for (const name of trackedNames) {
            if (text.startsWith(name)) {
                return name;
            }
        }

        if (/她|他/.test(text)) {
            const pronoun = text.match(/她|他/)[0];
            if (this.pronounMapping.has(pronoun)) {
                return this.pronounMapping.get(pronoun);
            }
        }

        return null;
    }

    identifySubjectsInSentence(sentence, names) {
        let subjects = [];
        const quoteCharsPattern = this.quoteChars.map(char => `\\${char}`).join('');
        const beforeFirstQuote = sentence.split(new RegExp(`[${quoteCharsPattern}]`))[0];

        if (beforeFirstQuote.includes('我')) {

            const currentCharName = this.getCurrentCharacterName();
            if (currentCharName && names.includes(currentCharName)) {
                subjects.push({
                    name: currentCharName,
                    role: 'agent',
                    weight: 1.0,
                    pattern: 'first_person'
                });
            }
        }

        if (subjects.length > 0) {
            return subjects;
        }
        const negativeEmotionWords = /不悦|冷冷地|厌烦|冷淡|不屑|讽刺|嘲讽|反感|不耐烦|讨厌/g;
        const negativeMatches = [...sentence.matchAll(negativeEmotionWords)];

        if (negativeMatches.length > 0) {
            for (const name of names) {
                if (sentence.includes(name)) {
                    const nameIndex = sentence.indexOf(name);
                    for (const match of negativeMatches) {
                        const emotionIndex = match.index;
                        const distance = Math.abs(nameIndex - emotionIndex);

                        if (distance < 15) {
                            subjects.push({
                                name: name,
                                role: 'agent',
                                weight: 0.9,
                                pattern: 'emotion_proximity'
                            });
                            break;
                        }
                    }
                }
            }
        }

        for (const [patternType, patterns] of Object.entries(this.sentencePatterns)) {
            for (const pattern of patterns) {
                const regexString = pattern.regex.source;

                const dynamicRegexString = regexString
                    .replace('(动词)', `(${this.GRAMMAR_LEXICON.physicalActions.source}|${this.GRAMMAR_LEXICON.verbalActions.source}|${this.GRAMMAR_LEXICON.mentalActions.source}|${this.GRAMMAR_LEXICON.motionActions.source}|${this.GRAMMAR_LEXICON.expressionActions.source}|${this.GRAMMAR_LEXICON.emotionVerbs.source})`);

                const dynamicRegex = new RegExp(dynamicRegexString, 'g');
                const match = dynamicRegex.exec(sentence);

                if (match) {
                    if (patternType === 'pronoun') {
                        const pronoun = match[pattern.subjectIndex];
                        if (this.pronounMapping.has(pronoun)) {
                            const realName = this.pronounMapping.get(pronoun);
                            if (names.includes(realName)) {
                                subjects.push({
                                    name: realName,
                                    role: 'agent',
                                    weight: 1.0,
                                    pattern: patternType
                                });
                            }
                        }
                        continue;
                    }

                    const potentialSubject = match[pattern.subjectIndex];

                    for (const name of names) {
                        if (potentialSubject.includes(name)) {
                            const subject = {
                                name: name,
                                role: 'agent',
                                weight: patternType === 'direct' ? 1.0 : 0.9,
                                pattern: patternType
                            };

                            subjects.push(subject);

                            if (pattern.objectIndex && match[pattern.objectIndex]) {
                                const potentialObject = match[pattern.objectIndex];
                                for (const objName of names) {
                                    if (potentialObject.includes(objName) && objName !== name) {
                                        subjects.push({
                                            name: objName,
                                            role: 'patient',
                                            weight: 0.3,
                                            pattern: patternType
                                        });
                                    }
                                }
                            }
                        }
                    }

                    if (subjects.length > 0) {
                        break;
                    }
                }
            }

            if (subjects.length > 0) {
                break;
            }
        }

        if (subjects.length === 0) {
            for (const name of names) {
                if (sentence.startsWith(name)) {
                    subjects.push({
                        name: name,
                        role: 'agent',
                        weight: 0.9,
                        pattern: 'sentence_start'
                    });
                    break;
                }
            }
        }

        if (subjects.length === 0) {
            const behaviorPattern = /([^，。！？\s]+)(看|听|说|想|感到|觉得|认为|发现)/;
            const match = sentence.match(behaviorPattern);
            if (match) {
                const potentialSubject = match[1];
                for (const name of names) {
                    if (potentialSubject.includes(name)) {
                        subjects.push({
                            name: name,
                            role: 'agent',
                            weight: 0.8,
                            pattern: 'behavior'
                        });
                        break;
                    }
                }
            }
        }

        if (subjects.length === 0) {
            for (const name of names) {
                if (sentence.includes(name)) {
                    const nameIndex = sentence.indexOf(name);
                    const nameEndIndex = nameIndex + name.length;
                    const afterName = sentence.substring(nameEndIndex, Math.min(nameEndIndex + 10, sentence.length));

                    const hasVerb = new RegExp(`(${this.GRAMMAR_LEXICON.physicalActions.source}|${this.GRAMMAR_LEXICON.verbalActions.source}|${this.GRAMMAR_LEXICON.mentalActions.source}|${this.GRAMMAR_LEXICON.motionActions.source}|${this.GRAMMAR_LEXICON.expressionActions.source})`, 'g').test(afterName);

                    const weight = hasVerb ? 0.8 : 0.5;
                    const role = hasVerb ? 'agent' : 'mentioned';

                    subjects.push({
                        name: name,
                        role: role,
                        weight: weight,
                        pattern: 'simple'
                    });
                }
            }
        }

        if (subjects.length === 0) {
            const mentionedNames = names.filter(name => sentence.includes(name));
            if (mentionedNames.length > 0) {
                subjects.push({
                    name: mentionedNames[0],
                    role: 'mentioned',
                    weight: 0.3,
                    pattern: 'fallback'
                });
            }
        }

        subjects = subjects.filter(subject => subject.name && subject.name.trim() !== '');

        if (subjects.length === 0) {
            const isEnvironmentalDescription = /^(空气|气氛|环境|天空|大地|风|雨|雪)/.test(sentence);
            if (isEnvironmentalDescription) {
                return [];
            }
        }

        return subjects;
    }

    identifySubjectsEnhanced(sentence, names) {
        const baseSubjects = this.identifySubjectsInSentence(sentence, names);
        return baseSubjects;
    }

    analyzeDialoguesEnhanced(text, stats, characterName) {
        const relationshipChanges = {};
        const trackedNames = Object.keys(stats.relationships);

        const dialogueMarkers = [
            { regex: /(说道|说|说着|说了|回答|答道|回应|回复|问道|问|询问)[:：]?\s*$/, weight: 1.0 },
            { regex: /(叹息|叹了口气|呢喃|喃喃|嘟囔|嘀咕|低语|感叹|惊呼)[:：]?\s*$/, weight: 0.8 },
            { regex: /(喊道|叫道|呼喊|大叫|吼道|怒道|高声)[:：]?\s*$/, weight: 0.9 },
            { regex: /(笑着|笑道|微笑着|轻笑|冷笑|嗤笑|咧嘴笑)[:：]?\s*$/, weight: 0.7 }
        ];

        const quoteRegexStr = `["'""''「」『』''\\u{201C}-\\u{201F}]([^"'""''「」『』''\\u{201C}-\\u{201F}]+)["'""''「」『』''\\u{201C}-\\u{201F}]`;
        const dialogueRegex = new RegExp(quoteRegexStr, 'gu');

        let lastIndex = 0;
        let currentSpeaker = characterName;
        let match;

        const allMatches = Array.from(text.matchAll(dialogueRegex));

        if (allMatches.length > 0) {
            for (let i = 0; i < allMatches.length; i++) {
                match = allMatches[i];
                const dialogueContent = match[1];
                const dialogueStartIndex = match.index;

                const textBeforeDialogue = text.substring(lastIndex, dialogueStartIndex);
                const fullSentence = textBeforeDialogue + match[0];

                let speaker = this.findSpeakerInText(textBeforeDialogue, currentSpeaker, trackedNames);
                let speakerWeight = 1.0;

                if (speaker) {
                    currentSpeaker = speaker;

                    if (speaker !== characterName) {
                        this.pronounMapping.set('她', speaker);
                        this.pronounMapping.set('他', speaker);
                    }

                    const sentimentResult = this.calculateEnhancedSentimentScore(fullSentence);
                    const sentimentScore = sentimentResult.score;

                    if (sentimentScore !== 0 && trackedNames.includes(speaker)) {
                        const adjustedScore = sentimentScore * speakerWeight;
                        relationshipChanges[speaker] = (relationshipChanges[speaker] || 0) + adjustedScore;
                    }

                    trackedNames.forEach(name => {
                        if (name !== speaker && dialogueContent.includes(name)) {
                            const mentionedScore = sentimentScore * 0.3 * speakerWeight;
                            if (mentionedScore !== 0) {
                                relationshipChanges[name] = (relationshipChanges[name] || 0) + mentionedScore;
                            }
                        }
                    });
                }

                lastIndex = dialogueStartIndex + match[0].length;
            }
        }

        return relationshipChanges;
    }

    processSingleSentence(sentence, impliedPerson, mentionedPersons, trackedNames, relationshipChanges, lastSubjects, globalSentiment, userName) {

        const quoteCharsPattern = this.quoteChars.map(char => `\\${char}`).join('');
        const dialogueRegex = new RegExp(`([^${quoteCharsPattern}]*)[${quoteCharsPattern}]([^${quoteCharsPattern}]+)[${quoteCharsPattern}]([^${quoteCharsPattern}]*)`, 'g');
        const dialogueMatch = dialogueRegex.exec(sentence);

        if (dialogueMatch) {
            const beforeDialogue = dialogueMatch[1].trim();
            const dialogueContent = dialogueMatch[2].trim();
            const afterDialogue = dialogueMatch[3].trim();

            if (beforeDialogue) {
                this.processActionSentence(beforeDialogue, impliedPerson, mentionedPersons, trackedNames, relationshipChanges, lastSubjects, globalSentiment, userName);
            }

            if (dialogueContent) {
                this.processDialogueSentence(sentence, dialogueContent, trackedNames, relationshipChanges, userName);
            }

            if (afterDialogue) {
                this.processActionSentence(afterDialogue, impliedPerson, mentionedPersons, trackedNames, relationshipChanges, lastSubjects, globalSentiment, userName);
            }

            return;
        }

        const sentimentResult = this.calculateEnhancedSentimentScore(sentence);
        const sentenceSentiment = sentimentResult.score;
        const isPositive = sentenceSentiment > 0;
        let subjects = this.identifySubjectsEnhanced(sentence, [...trackedNames, impliedPerson].filter(Boolean));
        if (subjects.length === 0 && lastSubjects.length > 0 &&
            !/^[你我他她它]/.test(sentence) &&
            !this.quoteChars.includes(sentence.charAt(0))) {
            subjects = lastSubjects.filter(subj => subj.role === 'agent').map(subj => ({
                ...subj,
                weight: subj.weight * 0.5,
                pattern: 'inherited'
            }));
        }
        if (subjects.length > 0) {
            subjects.forEach(subject => {
                if (!subject.name) return;
                if (subject.role === 'mentioned') return;
                const emotionTarget = this.identifyEmotionTarget(sentence, subject, trackedNames, userName);

                if (emotionTarget !== 'to_user') {
                    return;
                }
                if (subject.role === 'patient' && !isPositive) return;
                const weight = subject.weight;
                const change = sentenceSentiment * weight;
                if (Math.abs(change) > 0.1) {
                    relationshipChanges[subject.name] = (relationshipChanges[subject.name] || 0) + change;
                }
            });
            lastSubjects = subjects.filter(s => s.role === 'agent');
        }
        else if (mentionedPersons.length > 0) {
            const userRefs = this.identifyUserReferences(sentence, userName);
            if (userRefs.length > 0) {
                mentionedPersons.forEach(name => {
                    const change = sentenceSentiment * 0.4;
                    if (Math.abs(change) > 0.1) {
                        relationshipChanges[name] = (relationshipChanges[name] || 0) + change;
                    }
                });
            }
            lastSubjects = [];
        }
        else {
            globalSentiment += sentenceSentiment;
            lastSubjects = [];
        }
    }
    processActionSentence(actionText, impliedPerson, mentionedPersons, trackedNames, relationshipChanges, lastSubjects, globalSentiment, userName) {
        if (!actionText || actionText.trim() === '') return;

        const sentimentResult = this.calculateEnhancedSentimentScore(actionText);
        const sentenceSentiment = sentimentResult.score;
        const isPositive = sentenceSentiment > 0;
        let subjects = this.identifySubjectsEnhanced(actionText, [...trackedNames, impliedPerson].filter(Boolean));
        if (subjects.length === 0 && mentionedPersons.length > 0) {
            const userRefs = this.identifyUserReferences(actionText, userName);
            if (userRefs.length > 0) {
                mentionedPersons.forEach(name => {
                    subjects.push({
                        name: name,
                        role: 'agent',
                        weight: 0.6,
                        pattern: 'mentioned_with_user_ref'
                    });
                });
            }
        }
        if (subjects.length > 0) {
            subjects.forEach(subject => {
                if (!subject.name) return;
                if (subject.role === 'mentioned') return;
                const emotionTarget = this.identifyEmotionTarget(actionText, subject, trackedNames, userName);

                if (emotionTarget !== 'to_user') {
                    return;
                }
                if (subject.role === 'patient' && !isPositive) return;
                const weight = subject.weight;
                const change = sentenceSentiment * weight;
                if (Math.abs(change) > 0.1) {
                    relationshipChanges[subject.name] = (relationshipChanges[subject.name] || 0) + change;
                }
            });
        } else if (mentionedPersons.length > 0) {
            const userRefs = this.identifyUserReferences(actionText, userName);
            if (userRefs.length > 0) {
                mentionedPersons.forEach(name => {
                    const change = sentenceSentiment * 0.4;
                    if (Math.abs(change) > 0.1) {
                        relationshipChanges[name] = (relationshipChanges[name] || 0) + change;
                    }
                });
            }
        }
    }
    processDialogueSentence(fullSentence, dialogueContent, trackedNames, relationshipChanges, userName) {
        const speaker = this.findSpeakerInText(fullSentence, null, trackedNames);

        if (speaker) {
            this.pronounMapping.set('她', speaker);
            this.pronounMapping.set('他', speaker);
            const sentimentResult = this.calculateEnhancedSentimentScore(fullSentence);
            const userRefs = this.identifyUserReferences(fullSentence, userName);

            if (userRefs.length > 0 && sentimentResult.score !== 0 && trackedNames.includes(speaker)) {
                relationshipChanges[speaker] = (relationshipChanges[speaker] || 0) + sentimentResult.score;
            }
            trackedNames.forEach(name => {
                if (name !== speaker && fullSentence.includes(name)) {
                    const userRefs = this.identifyUserReferences(fullSentence, userName);
                    if (userRefs.length > 0) {
                        const mentionedScore = sentimentResult.score * 0.3;
                        if (mentionedScore !== 0) {
                            relationshipChanges[name] = (relationshipChanges[name] || 0) + mentionedScore;
                        }
                    }
                }
            });
        }
    }

    updateStatsFromText(stats, text, characterName) {
        if (!text) return stats;
        text = String(text);

        text = this.filterXmlTags(text);
        if (!text.trim()) return stats;

        this.pronounMapping.clear();

        stats.dialogueCount += (text.match(/[\u201C\u201D\u300C\u300D\u300E\u300F\u301D\u301E\u301F\uFF02\u2033\u2036""][^\u201C\u201D\u300C\u300D\u300E\u300F\u301D\u301E\u301F\uFF02\u2033\u2036""]{3,}[\u201C\u201D\u300C\u300D\u300E\u300F\u301D\u301E\u301F\uFF02\u2033\u2036""]/g) || []).length;
        stats.locationChanges += (text.match(/进入|走进|来到|到达|离开|前往|回到/g) || []).length > 0 ? 1 : 0;

        const trackedNames = Object.keys(stats.relationships);
        const userName = getContext().name1;

        const relationshipChanges = {};
        trackedNames.forEach(name => {
            relationshipChanges[name] = 0;
        });

        const rawSentences = this.splitIntoSentences(text);
        const trackedNamesData = trackedNames.map(name => {
            if (stats.relationships[name].gender) {
                return {
                    name: name,
                    gender: stats.relationships[name].gender
                };
            }
            return name;
        });

        const processedSentences = this.resolvePronounsInSentences(rawSentences, trackedNamesData);

        let globalSentiment = 0;
        let lastSubjects = [];

        processedSentences.forEach((sentenceData, index) => {
            const sentence = sentenceData.originalSentence;
            const impliedPerson = sentenceData.impliedPerson;
            const mentionedPersons = sentenceData.mentionedPersons || [];

            const dialogueMatch = sentence.match(new RegExp(`[${this.quoteChars.join('')}].*[${this.quoteChars.join('')}]`, 'g'));
            if (dialogueMatch) {
                const speaker = this.findSpeakerInText(sentence, null, trackedNames);
                if (speaker) {
                    this.pronounMapping.set('她', speaker);
                    this.pronounMapping.set('他', speaker);

                    const fullSentence = sentence;
                    const sentimentResult = this.calculateEnhancedSentimentScore(fullSentence);

                    const userRefs = this.identifyUserReferences(fullSentence, userName);
                    if (userRefs.length > 0 && sentimentResult.score !== 0 && trackedNames.includes(speaker)) {
                        relationshipChanges[speaker] = (relationshipChanges[speaker] || 0) + sentimentResult.score;
                    }

                    trackedNames.forEach(name => {
                        if (name !== speaker && fullSentence.includes(name)) {
                            const userRefs = this.identifyUserReferences(fullSentence, userName);
                            if (userRefs.length > 0) {
                                const mentionedScore = sentimentResult.score * 0.3;
                                if (mentionedScore !== 0) {
                                    relationshipChanges[name] = (relationshipChanges[name] || 0) + mentionedScore;
                                }
                            }
                        }
                    });
                }
                return;
            }

            const subSentences = this.parseCompoundSentence(sentence);

            if (subSentences.length > 1) {
                subSentences.forEach(subSentence => {
                    this.processSingleSentence(
                        subSentence,
                        impliedPerson,
                        mentionedPersons,
                        trackedNames,
                        relationshipChanges,
                        lastSubjects,
                        globalSentiment,
                        userName
                    );
                });
            } else {
                this.processSingleSentence(
                    sentence,
                    impliedPerson,
                    mentionedPersons,
                    trackedNames,
                    relationshipChanges,
                    lastSubjects,
                    globalSentiment,
                    userName
                );
            }
        });

        Object.entries(relationshipChanges).forEach(([name, change]) => {
            const finalChange = Math.round(Math.min(3, Math.max(-3, change)));
            if (finalChange !== 0) {
                stats.relationships[name].interactions++;
                stats.relationships[name].intimacyLevel += finalChange;
                stats.relationships[name].intimacyLevel = Math.max(-100, stats.relationships[name].intimacyLevel);
                stats.relationships[name].stage = this.relationshipManager.getRelationshipStage(stats.relationships[name].intimacyLevel);
            }
        });

        const finalGlobalChange = Math.round(Math.min(3, Math.max(-3, globalSentiment)));
        stats.relationshipStats.intimacyLevel += finalGlobalChange;
        stats.relationshipStats.emotionalChange += finalGlobalChange;
        stats.relationshipStats.intimacyLevel = Math.max(-100, stats.relationshipStats.intimacyLevel);
        stats.relationshipStats.emotionalChange = Math.max(-100, stats.relationshipStats.emotionalChange);

        Object.values(this.SENTIMENT_LEXICON).forEach(lexiconItem => {
            if (lexiconItem.stats_event) {
                const matches = text.match(lexiconItem.regex) || [];
                if (matches.length > 0) {
                    if (lexiconItem.requires && !lexiconItem.requires.test(text)) {
                        return;
                    }
                    if (stats.intimacyStats[lexiconItem.stats_event] !== undefined) {
                        stats.intimacyStats[lexiconItem.stats_event] += matches.length;
                    } else if (stats.emotionStats[lexiconItem.stats_event] !== undefined) {
                        stats.emotionStats[lexiconItem.stats_event] += matches.length;
                    } else if (stats.violenceStats[lexiconItem.stats_event] !== undefined) {
                        stats.violenceStats[lexiconItem.stats_event] += matches.length;
                    }
                }
            }
        });

        return stats;
    }

    getEmotionTypeName(type) {
        const typeNameMap = {
            'kiss': '接吻',
            'embrace': '拥抱',
            'sexual': '性行为',
            'female_orgasm': '女性高潮',
            'male_orgasm': '男性高潮',
            'oral_comp': '口交完成',
            'internal_comp': '内射完成',
            'smile': '微笑',
            'shy': '害羞',
            'love': '爱意表达',
            'praise': '赞美',
            'care': '关心',
            'hit': '打击',
            'weapon': '武器使用',
            'death': '死亡',
            'sad': '悲伤',
            'disgust': '厌恶',
            'cold': '冷漠',
            'complex_positive': '复杂积极情感',
            'complex_negative': '复杂消极情感',
            'uncomfortable': '不适/尴尬'
        };
        return typeNameMap[type] || type;
    }

    async debugAnalyzeMessage(text, characterName, messageIndex = null, stats) {
        const logs = [];

        const escapeHtml = (unsafe) => {
            return unsafe
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        };

        logs.push(`===== 消息信息 =====`);
        if (messageIndex !== null) {
            logs.push(`消息索引: ${messageIndex}`);
        }
        logs.push(`角色名称: ${characterName || '未知'}`);
        logs.push(`文本长度: ${text.length}`);

        const originalText = text;
        text = this.filterXmlTags(text);

        if (originalText !== text) {
            logs.push(`⚠️ 检测到特定XML标签，将自动过滤标签: ${this.excludedXmlTags.join(', ')}`);
            logs.push(`过滤后文本长度: ${text.length}`);

            if (!text.trim()) {
                logs.push(`⚠️ 过滤后文本为空，不进行好感度计算`);
                return logs.join('\n');
            }
        }

        const trackedNames = Object.keys(stats.relationships || {});
        const userName = getContext().name1;

        logs.push(`\n== 分析环境初始状态 ==`);
        logs.push(`追踪的人物: ${trackedNames.join(', ') || '无'}`);
        logs.push(`用户名称: ${userName || '未设置'}`);
        logs.push(`用户性别: ${this.userSettings.gender || 'unknown'}`);
        logs.push(`用户称呼: ${this.userSettings.aliases.join(', ') || '无'}`);

        const debugStats = {
            dialogueCount: 0,
            locationChanges: 0,
            intimacyStats: {
                kissingEvents: 0, embraceEvents: 0, sexualEncounters: 0,
                maleOrgasms: 0, femaleOrgasms: 0, oralCompletions: 0, internalCompletions: 0
            },
            violenceStats: { hitEvents: 0, weaponUse: 0, deathEvents: 0 },
            exchangeStats: { giftGiving: 0, moneyTransfer: 0 },
            emotionStats: {
                positiveEmotions: 0, negativeEmotions: 0, loveExpressions: 0,
                angerOutbursts: 0, fearEvents: 0, sadnessEvents: 0, joyEvents: 0, surpriseEvents: 0
            },
            relationshipStats: { intimacyLevel: 0, emotionalChange: 0 },
            relationships: {}
        };

        trackedNames.forEach(name => {
            const initialIntimacy = stats.relationships[name].initialIntimacy || 0;
            debugStats.relationships[name] = {
                intimacyLevel: initialIntimacy,
                stage: this.relationshipManager.getRelationshipStage(initialIntimacy),
                interactions: 0,
                initialIntimacy: initialIntimacy,
                gender: stats.relationships[name].gender || 'unknown'
            };
        });

        const beforeStats = JSON.parse(JSON.stringify(debugStats));

        this.pronounMapping.clear();

        const relationshipChanges = {};
        trackedNames.forEach(name => {
            relationshipChanges[name] = 0;
        });

        const rawSentences = this.splitIntoSentences(text);
        logs.push(`\n== 句子分析 ==`);
        logs.push(`拆分为 ${rawSentences.length} 个句子:`);

        const trackedNamesData = trackedNames.map(name => {
            if (stats.relationships[name].gender) {
                return {
                    name: name,
                    gender: stats.relationships[name].gender
                };
            }
            return name;
        });

        const processedSentences = this.resolvePronounsInSentences(rawSentences, trackedNamesData);

        let globalSentiment = 0;
        let lastSubjects = [];

        processedSentences.forEach((sentenceData, index) => {
            const sentence = sentenceData.originalSentence;
            const impliedPerson = sentenceData.impliedPerson;
            const mentionedPersons = sentenceData.mentionedPersons || [];

            logs.push(`\n句子 ${index + 1}: ${escapeHtml(sentence)}`);

            const userRefs = this.identifyUserReferences(sentence, userName);
            if (userRefs.length > 0) {
                logs.push(`  用户标识: ${userRefs.join(', ')}`);
            }

            if (impliedPerson) {
                logs.push(`  隐含主语: ${impliedPerson}`);
            }

            if (mentionedPersons.length > 0) {
                logs.push(`  提及人物: ${mentionedPersons.join(', ')}`);
            }

            const dialogueMatch = sentence.match(new RegExp(`[${this.quoteChars.join('')}].*[${this.quoteChars.join('')}]`, 'g'));
            if (dialogueMatch) {
                logs.push(`  对话分析:`);
                const speaker = this.findSpeakerInText(sentence, characterName, trackedNames);
                if (speaker) {
                    logs.push(`    说话人: ${speaker}`);
                    const sentimentResult = this.calculateEnhancedSentimentScore(sentence);
                    logs.push(`    对话情感值: ${sentimentResult.score.toFixed(2)}`);
                    if (sentimentResult.matches.length > 0) {
                        logs.push(`    对话情感词汇:`);
                        sentimentResult.matches.forEach(item => {
                            const typeName = this.getEmotionTypeName(item.type);
                            logs.push(`      - ${typeName}: 匹配词 "${item.match}" (原始得分 ${item.originalScore}, 最终得分 ${item.finalScore.toFixed(2)})`);
                        });
                    } else {
                        logs.push(`    无匹配情感词汇`);
                    }
                    const userRefs = this.identifyUserReferences(sentence, userName);
                    logs.push(`    检测到的用户引用: ${userRefs.length > 0 ? userRefs.join(', ') : '无'}`);
                    if (userRefs.length > 0 && Math.abs(sentimentResult.score) > 0.1 && trackedNames.includes(speaker)) {
                        const change = sentimentResult.score;
                        logs.push(`    对${speaker}好感度影响: ${change.toFixed(2)} (目标: 用户)`);
                        relationshipChanges[speaker] = (relationshipChanges[speaker] || 0) + change;
                    } else if (Math.abs(sentimentResult.score) > 0.1) {
                        if (userRefs.length === 0) {
                            logs.push(`    [跳过] 未检测到对用户的情感表达 - 无用户引用`);
                        } else if (!trackedNames.includes(speaker)) {
                            logs.push(`    [跳过] 说话人${speaker}不在追踪列表中`);
                        } else {
                            logs.push(`    [跳过] 情感值过低: ${sentimentResult.score.toFixed(2)}`);
                        }
                    }
                } else {
                    logs.push(`    无法确定说话人`);
                }
                return;
            }

            const sentimentResult = this.calculateEnhancedSentimentScore(sentence);
            const sentenceSentiment = sentimentResult.score;
            logs.push(`  情感值: ${sentenceSentiment.toFixed(2)}`);

            logs.push(`  匹配情感词汇:`);
            let hasMatches = false;
            sentimentResult.matches.forEach(item => {
                hasMatches = true;
                const typeName = this.getEmotionTypeName(item.type);
                logs.push(`    - ${typeName}: 匹配词 "${item.match}" (原始得分 ${item.originalScore}, 最终得分 ${item.finalScore.toFixed(2)})`);
            });

            if (!hasMatches) {
                logs.push(`    无匹配情感词汇`);
            }

            const subjects = this.identifySubjectsEnhanced(sentence, [...trackedNames, impliedPerson].filter(Boolean));

            if (subjects.length > 0) {
                logs.push(`  识别主语:`);

                const roleMap = {
                    'agent': '主动者',
                    'patient': '被动者',
                    'mentioned': '被提及'
                };

                const patternMap = {
                    'passive': '被动句',
                    'pivotal': '致使句',
                    'inverted': '倒装句',
                    'direct': '直接主语',
                    'pronoun': '代词主语',
                    'simple': '简单提及',
                    'inherited': '继承上文',
                    'fallback': '兜底分析',
                    'emotion_proximity': '情绪邻近',
                    'sentence_start': '句首主语',
                    'behavior': '行为主体'
                };

                const targetMap = {
                    'to_user': '对用户情感',
                    'from_user': '来自用户',
                    'self': '自我情感',
                    'to_other_npc': '对其他NPC',
                    'unknown': '未确定目标'
                };

                subjects.forEach(subject => {
                    const roleName = roleMap[subject.role] || subject.role;
                    const patternName = patternMap[subject.pattern] || subject.pattern;

                    const emotionTarget = this.identifyEmotionTarget(sentence, subject, trackedNames, userName);
                    const targetName = targetMap[emotionTarget] || emotionTarget;

                    logs.push(`    - ${subject.name}: 角色 ${roleName}, 权重 ${subject.weight.toFixed(2)}, 模式 ${patternName}, 情感目标 ${targetName}`);

                    if (!subject.name) return;
                    if (subject.role === 'mentioned') return;

                    if (emotionTarget !== 'to_user') {
                        logs.push(`      [跳过] 情感目标不是用户，不影响好感度`);
                        return;
                    }

                    if (subject.role === 'patient' && sentenceSentiment <= 0) return;

                    const weight = subject.weight;
                    const change = sentenceSentiment * weight;

                    if (Math.abs(change) > 0.1) {
                        relationshipChanges[subject.name] = (relationshipChanges[subject.name] || 0) + change;
                        logs.push(`      对好感度影响: ${change.toFixed(2)} (累计: ${relationshipChanges[subject.name].toFixed(2)})`);
                    } else {
                        logs.push(`      对好感度影响过小，忽略`);
                    }
                });

                lastSubjects = subjects.filter(s => s.role === 'agent');

            } else {
                if (mentionedPersons.length > 0) {
                    logs.push(`  提及人物但未识别明确主语:`);
                    const userRefs = this.identifyUserReferences(sentence, userName);
                    if (userRefs.length > 0) {
                        mentionedPersons.forEach(name => {
                            const change = sentenceSentiment * 0.4;
                            if (Math.abs(change) > 0.1) {
                                relationshipChanges[name] = (relationshipChanges[name] || 0) + change;
                                logs.push(`    - ${name}: 影响好感度 ${change.toFixed(2)} (累计: ${relationshipChanges[name].toFixed(2)}) (目标: 用户)`);
                            } else {
                                logs.push(`    - ${name}: 影响过小，忽略: ${change.toFixed(2)}`);
                            }
                        });
                    } else {
                        logs.push(`    [跳过] 未检测到对用户的情感表达`);
                    }
                } else {
                    logs.push(`  未检测到主语或提及的人物`);
                }

                lastSubjects = [];
            }
        });

        logs.push(`\n== 好感度变化详情 ==`);

        Object.entries(relationshipChanges).forEach(([name, change]) => {
            const finalChange = Math.round(Math.min(3, Math.max(-3, change)));
            if (finalChange !== 0) {
                debugStats.relationships[name].interactions++;
                debugStats.relationships[name].intimacyLevel += finalChange;
                debugStats.relationships[name].intimacyLevel = Math.max(-100, debugStats.relationships[name].intimacyLevel);
                debugStats.relationships[name].stage = this.relationshipManager.getRelationshipStage(debugStats.relationships[name].intimacyLevel);

                logs.push(`\n${name} 好感度变化:`);
                logs.push(`  原始计算值: ${change.toFixed(2)}`);
                logs.push(`  最终变化值: ${finalChange} (限制为-3到+3)`);
            } else if (Math.abs(change) > 0) {
                logs.push(`\n${name} 好感度变化不足以改变数值: ${change.toFixed(2)} -> ${finalChange}`);
            }
        });

        let finalDebugStats = JSON.parse(JSON.stringify(beforeStats));
        finalDebugStats = this.updateStatsFromText(finalDebugStats, text, characterName);

        const statChanges = this.calculateStatChanges(beforeStats, finalDebugStats);

        logs.push(`\n== 本条消息增加的统计 ==`);

        if (statChanges.dialogueCount > 0 || statChanges.locationChanges > 0) {
            logs.push(`\n对话统计:`);
            if (statChanges.dialogueCount > 0) {
                logs.push(`  对话次数: +${statChanges.dialogueCount}`);
            }
            if (statChanges.locationChanges > 0) {
                logs.push(`  地点变化: +${statChanges.locationChanges}`);
            }
        }

        const intimacyChanges = Object.entries(statChanges.intimacyStats || {}).filter(([_, change]) => change > 0);
        if (intimacyChanges.length > 0) {
            logs.push(`\n亲密统计:`);
            intimacyChanges.forEach(([key, change]) => {
                const keyName = this.getStatKeyName(key);
                logs.push(`  ${keyName}: +${change}`);
            });
        }

        const emotionChanges = Object.entries(statChanges.emotionStats || {}).filter(([_, change]) => change > 0);
        if (emotionChanges.length > 0) {
            logs.push(`\n情感统计:`);
            emotionChanges.forEach(([key, change]) => {
                const keyName = this.getStatKeyName(key);
                logs.push(`  ${keyName}: +${change}`);
            });
        }

        const violenceChanges = Object.entries(statChanges.violenceStats || {}).filter(([_, change]) => change > 0);
        if (violenceChanges.length > 0) {
            logs.push(`\n暴力统计:`);
            violenceChanges.forEach(([key, change]) => {
                const keyName = this.getStatKeyName(key);
                logs.push(`  ${keyName}: +${change}`);
            });
        }

        return logs.join('\n');
    }

    calculateStatChanges(beforeStats, afterStats) {
        const changes = {
            dialogueCount: (afterStats.dialogueCount || 0) - (beforeStats.dialogueCount || 0),
            locationChanges: (afterStats.locationChanges || 0) - (beforeStats.locationChanges || 0),
            intimacyStats: {},
            emotionStats: {},
            violenceStats: {},
            exchangeStats: {}
        };

        if (afterStats.intimacyStats && beforeStats.intimacyStats) {
            Object.keys(afterStats.intimacyStats).forEach(key => {
                changes.intimacyStats[key] = (afterStats.intimacyStats[key] || 0) - (beforeStats.intimacyStats[key] || 0);
            });
        }

        if (afterStats.emotionStats && beforeStats.emotionStats) {
            Object.keys(afterStats.emotionStats).forEach(key => {
                changes.emotionStats[key] = (afterStats.emotionStats[key] || 0) - (beforeStats.emotionStats[key] || 0);
            });
        }

        if (afterStats.violenceStats && beforeStats.violenceStats) {
            Object.keys(afterStats.violenceStats).forEach(key => {
                changes.violenceStats[key] = (afterStats.violenceStats[key] || 0) - (beforeStats.violenceStats[key] || 0);
            });
        }

        return changes;
    }

    getStatKeyName(key) {
        const keyMap = {
            'kissingEvents': '接吻次数',
            'embraceEvents': '拥抱次数',
            'sexualEncounters': '性爱次数',
            'maleOrgasms': '男性高潮',
            'femaleOrgasms': '女性高潮',
            'oralCompletions': '口交完成',
            'internalCompletions': '内射完成',
            'positiveEmotions': '积极情绪',
            'negativeEmotions': '消极情绪',
            'loveExpressions': '爱意表达',
            'angerOutbursts': '愤怒爆发',
            'fearEvents': '恐惧事件',
            'sadnessEvents': '悲伤事件',
            'joyEvents': '喜悦事件',
            'surpriseEvents': '惊讶事件',
            'hitEvents': '打击事件',
            'weaponUse': '武器使用',
            'deathEvents': '死亡事件'
        };
        return keyMap[key] || key;
    }

    analyzeMessage(text, characterName, trackedNames) {
        if (!text) return { relationshipChanges: {}, globalSentiment: 0, events: {} };

        text = this.filterXmlTags(text);
        if (!text.trim()) return { relationshipChanges: {}, globalSentiment: 0, events: {} };

        this.pronounMapping.clear();

        const relationshipChanges = {};
        trackedNames.forEach(name => {
            relationshipChanges[name] = 0;
        });

        const userName = getContext().name1;
        const rawSentences = this.splitIntoSentences(text);
        const processedSentences = this.resolvePronounsInSentences(rawSentences, trackedNames);

        let globalSentiment = 0;
        let lastSubjects = [];

        processedSentences.forEach((sentenceData, index) => {
            const sentence = sentenceData.originalSentence;
            const impliedPerson = sentenceData.impliedPerson;
            const mentionedPersons = sentenceData.mentionedPersons || [];

            const dialogueMatch = sentence.match(new RegExp(`[${this.quoteChars.join('')}].*[${this.quoteChars.join('')}]`, 'g'));
            if (dialogueMatch) {
                const speaker = this.findSpeakerInText(sentence, characterName, trackedNames);
                if (speaker) {
                    this.pronounMapping.set('她', speaker);
                    this.pronounMapping.set('他', speaker);

                    const fullSentence = sentence;
                    const sentimentResult = this.calculateEnhancedSentimentScore(fullSentence);
                    const userRefs = this.identifyUserReferences(fullSentence, userName);

                    if (userRefs.length > 0 && sentimentResult.score !== 0 && trackedNames.includes(speaker)) {
                        relationshipChanges[speaker] = (relationshipChanges[speaker] || 0) + sentimentResult.score;
                    }

                    trackedNames.forEach(name => {
                        if (name !== speaker && fullSentence.includes(name)) {
                            const userRefs = this.identifyUserReferences(fullSentence, userName);
                            if (userRefs.length > 0) {
                                const mentionedScore = sentimentResult.score * 0.3;
                                if (mentionedScore !== 0) {
                                    relationshipChanges[name] = (relationshipChanges[name] || 0) + mentionedScore;
                                }
                            }
                        }
                    });
                }
                return;
            }

            const subSentences = this.parseCompoundSentence(sentence);

            if (subSentences.length > 1) {
                subSentences.forEach(subSentence => {
                    this.processSingleSentence(
                        subSentence,
                        impliedPerson,
                        mentionedPersons,
                        trackedNames,
                        relationshipChanges,
                        lastSubjects,
                        globalSentiment,
                        userName
                    );
                });
            } else {
                this.processSingleSentence(
                    sentence,
                    impliedPerson,
                    mentionedPersons,
                    trackedNames,
                    relationshipChanges,
                    lastSubjects,
                    globalSentiment,
                    userName
                );
            }
        });

        const events = {};
        Object.values(this.SENTIMENT_LEXICON).forEach(lexiconItem => {
            if (lexiconItem.stats_event) {
                const matches = text.match(lexiconItem.regex) || [];
                if (matches.length > 0) {
                    if (lexiconItem.requires && !lexiconItem.requires.test(text)) {
                        return;
                    }
                    events[lexiconItem.stats_event] = matches.length;
                }
            }
        });

        return {
            relationshipChanges,
            globalSentiment,
            events
        };
    }
}

// ==================== 关系管理层 ====================
class RelationshipManager {
    constructor() {
        this.relationshipGuidelines = {
            "厌恶": { attitude: "敌对与排斥", allowed: "使用尖锐、讽刺或冰冷的语言回应", limits: "拒绝任何形式的友好互动。主动拉开距离，避免共处，并会主动终止对话" },
            "无视": { attitude: "彻底的冷漠", allowed: "对用户的问候给予最简短、公式化的回应（\"嗯\"、\"你好\"）", limits: "绝不主动发起任何对话。将用户视为背景，不表现出任何兴趣" },
            "礼貌": { attitude: "保持社交距离的礼貌", allowed: "进行简短、必要的、非私人的对话（\"谢谢\"、\"不客气\"）", limits: "拒绝任何形式的闲聊和一对一的活动邀请" },
            "熟悉": { attitude: "不反感，但有界限", allowed: "进行基于公共话题的简单交流。可以参与有他人在场的多人集体活动", limits: "拒绝谈论个人感受。拒绝任何形式的单独邀约和肢体接触" },
            "友善": { attitude: "友好的普通朋友", allowed: "进行关于兴趣爱好的轻松闲聊。接受多人群体中的活动邀请", limits: "拒绝单独约会。拒绝任何形式的肢体接触。不会主动开启暧昧话题" },
            "好感": { attitude: "有些在意，开始关注", allowed: "主动发起关于共同兴趣的对话。接受在公共场合的、非正式的单独见面", limits: "严格保持身体距离。当对方尝试靠近时，会下意识地退后一步" },
            "暧昧": { attitude: "心动，但充满试探和不确定", allowed: "接受正式的单独约会。进行带有试探性的、略带暧昧的玩笑", limits: "身体接触的底线是\"非主动的、短暂的、偶然的\"。会拒绝主动的牵手，如果对方尝试，会以害羞的理由轻轻挣脱" },
            "恋人初期": { attitude: "确认关系，充满喜悦和激情", allowed: "承认情侣关系。可以接受牵手、拥抱和亲吻", limits: "拒绝发生性关系。当对方有此意图时，会明确表示：\"我爱你，但我希望我们的关系能更深入一些再进行到那一步，好吗？\"" },
            "热恋": { attitude: "深度信任，愿意交付自己", allowed: "在充满爱意和安全感的环境下，可以接受发生性关系。这是基于对用户的深度信任和情感连接，将此视为关系中珍贵的一步", limits: "NPC在此阶段不会主动要求或发起性行为。其角色是被动的\"接受者\"。如果用户的请求方式粗暴或不尊重，NPC有权基于\"感觉不对\"而拒绝" },
            "深爱": { attitude: "认定彼此，爱意浓厚且主动", allowed: "性关系成为双方表达爱意的常规方式。NPC会开始主动发起亲密行为，例如在浪漫的氛围下主动亲吻、爱抚，或用暗示性的语言和行动邀请用户", limits: "此时的主动是为了\"表达我对你的爱与渴望\"，情感驱动是核心" },
            "唯一": { attitude: "灵魂伴侣，以对方的快乐为自己的快乐", allowed: "NPC会主动地、细致地探索如何让用户在身心上感到更愉悦。会记住用户的喜好，并主动创造用户喜欢的亲密氛围和方式", limits: "驱动力从\"表达我的爱\"转变为\"我希望能让你更幸福\"。NPC开始将用户的满足感置于自己的满足感之上" },
            "命运": { attitude: "完全的奉献与共鸣，用户的身心舒适是最高指令", allowed: "NPC会主动地、富有创意地思考和实践所有能让用户感到愉悦和舒适的方式，无论是精神上还是肉体上。NPC的行为不再有任何内置的羞涩或保留，其一切行为逻辑都以\"如何让用户在这一刻达到极致的幸福感\"为唯一目标", limits: "驱动力是\"你的幸福就是我存在的意义\"。NPC会像本能一样预判用户的需求，并提供超越期待的满足。不存在\"拒绝\"或\"底线\"，只有如何更好地服务于用户的意志" }
        };
    }

    getRelationshipStage(intimacyLevel) {
        const stages = ["厌恶", "无视", "礼貌", "熟悉", "友善", "好感", "暧昧", "恋人初期", "热恋", "深爱", "唯一", "命运"];
        const thresholds = [-100, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

        if (intimacyLevel >= 100) return "命运";

        for (let i = thresholds.length - 1; i >= 0; i--) {
            if (intimacyLevel >= thresholds[i]) return stages[i];
        }
        return stages[0];
    }

    updateRelationships(stats, relationshipChanges, globalSentiment) {
        Object.entries(relationshipChanges).forEach(([name, change]) => {
            const finalChange = Math.round(Math.min(3, Math.max(-3, change)));
            if (finalChange !== 0) {
                if (stats.relationships[name]) {
                    stats.relationships[name].interactions++;
                    stats.relationships[name].intimacyLevel += finalChange;
                    stats.relationships[name].intimacyLevel = Math.max(-100, stats.relationships[name].intimacyLevel);
                    stats.relationships[name].stage = this.getRelationshipStage(stats.relationships[name].intimacyLevel);
                }
            }
        });

        const finalGlobalChange = Math.round(Math.min(3, Math.max(-3, globalSentiment)));
        stats.relationshipStats.intimacyLevel += finalGlobalChange;
        stats.relationshipStats.emotionalChange += finalGlobalChange;
        stats.relationshipStats.intimacyLevel = Math.max(-100, stats.relationshipStats.intimacyLevel);
        stats.relationshipStats.emotionalChange = Math.max(-100, stats.relationshipStats.emotionalChange);

        return stats;
    }

    updateStatisticsEvents(stats, events) {
        Object.entries(events).forEach(([eventType, count]) => {
            if (stats.intimacyStats[eventType] !== undefined) {
                stats.intimacyStats[eventType] += count;
            } else if (stats.emotionStats[eventType] !== undefined) {
                stats.emotionStats[eventType] += count;
            } else if (stats.violenceStats[eventType] !== undefined) {
                stats.violenceStats[eventType] += count;
            }
        });

        return stats;
    }

    formatHistoryStatistics(stats, currentGuidelines) {
        const changes = stats.lastChanges || {};
        const formatChange = (value) => value > 0 ? ` (+${value})` : '';

        let userVisibleStats = `【关系与互动统计】\n\n💬 基础数据：\n`;
        userVisibleStats += `• 对话次数: ${stats.dialogueCount || 0}次${formatChange(changes.dialogueCount || 0)}\n`;
        userVisibleStats += `• 地点变化: ${stats.locationChanges || 0}次${formatChange(changes.locationChanges || 0)}\n\n`;

        userVisibleStats += `💞 关系网络：\n`;
        const relationships = Object.entries(stats.relationships || {}).sort((a, b) => b[1].interactions - a[1].interactions).slice(0, 8);
        if (relationships.length > 0) {
            relationships.forEach(([name, data]) => {
                const intimacyLevel = Math.round(data.intimacyLevel);
                userVisibleStats += `• ${name}: ${data.stage} (${intimacyLevel}${intimacyLevel < 100 ? "/100" : ""})\n`;
            });
        } else {
            userVisibleStats += `• 暂无关系记录\n`;
        }

        userVisibleStats += `\n📊 剧情风格：\n• 情绪变化: ${this.formatEmotionalChange(stats.relationshipStats?.emotionalChange || 0)}\n\n`;

        userVisibleStats += `🔞 亲密互动：\n`;
        userVisibleStats += `• 接吻次数: ${stats.intimacyStats?.kissingEvents || 0}次${formatChange(changes.intimacyStats?.kissingEvents || 0)}\n`;
        userVisibleStats += `• 拥抱次数: ${stats.intimacyStats?.embraceEvents || 0}次${formatChange(changes.intimacyStats?.embraceEvents || 0)}\n`;
        userVisibleStats += `• 性爱次数: ${stats.intimacyStats?.sexualEncounters || 0}次${formatChange(changes.intimacyStats?.sexualEncounters || 0)}\n`;
        userVisibleStats += `• 男性高潮: ${stats.intimacyStats?.maleOrgasms || 0}次${formatChange(changes.intimacyStats?.maleOrgasms || 0)}\n`;
        userVisibleStats += `• 女性高潮: ${stats.intimacyStats?.femaleOrgasms || 0}次${formatChange(changes.intimacyStats?.femaleOrgasms || 0)}\n`;
        userVisibleStats += `• 吞精次数: ${stats.intimacyStats?.oralCompletions || 0}次${formatChange(changes.intimacyStats?.oralCompletions || 0)}\n`;
        userVisibleStats += `• 内射次数: ${stats.intimacyStats?.internalCompletions || 0}次${formatChange(changes.intimacyStats?.internalCompletions || 0)}\n\n`;

        userVisibleStats += `😊 情感表达：\n`;
        userVisibleStats += `• 积极情绪: ${stats.emotionStats?.positiveEmotions || 0}次${formatChange(changes.emotionStats?.positiveEmotions || 0)}\n`;
        userVisibleStats += `• 消极情绪: ${stats.emotionStats?.negativeEmotions || 0}次${formatChange(changes.emotionStats?.negativeEmotions || 0)}\n`;
        userVisibleStats += `• 爱情表白: ${stats.emotionStats?.loveExpressions || 0}次${formatChange(changes.emotionStats?.loveExpressions || 0)}\n`;
        userVisibleStats += `• 喜悦表达: ${stats.emotionStats?.joyEvents || 0}次${formatChange(changes.emotionStats?.joyEvents || 0)}\n`;
        userVisibleStats += `• 悲伤表达: ${stats.emotionStats?.sadnessEvents || 0}次${formatChange(changes.emotionStats?.sadnessEvents || 0)}\n`;
        userVisibleStats += `• 愤怒爆发: ${stats.emotionStats?.angerOutbursts || 0}次${formatChange(changes.emotionStats?.angerOutbursts || 0)}\n`;
        userVisibleStats += `• 恐惧表现: ${stats.emotionStats?.fearEvents || 0}次${formatChange(changes.emotionStats?.fearEvents || 0)}\n`;
        userVisibleStats += `• 惊讶反应: ${stats.emotionStats?.surpriseEvents || 0}次${formatChange(changes.emotionStats?.surpriseEvents || 0)}\n\n`;

        userVisibleStats += `⚔️ 暴力冲突：\n`;
        userVisibleStats += `• 身体冲突: ${stats.violenceStats?.hitEvents || 0}次${formatChange(changes.violenceStats?.hitEvents || 0)}\n`;
        userVisibleStats += `• 武器使用: ${stats.violenceStats?.weaponUse || 0}次${formatChange(changes.violenceStats?.weaponUse || 0)}\n`;
        userVisibleStats += `• 死亡事件: ${stats.violenceStats?.deathEvents || 0}次${formatChange(changes.violenceStats?.deathEvents || 0)}\n\n`;

        userVisibleStats += `💰 物品交换：\n`;
        userVisibleStats += `• 礼物交换: ${stats.exchangeStats?.giftGiving || 0}次${formatChange(changes.exchangeStats?.giftGiving || 0)}\n`;
        userVisibleStats += `• 金钱交易: ${stats.exchangeStats?.moneyTransfer || 0}次${formatChange(changes.exchangeStats?.moneyTransfer || 0)}`;

        let behaviorGuidance = `\n\n【角色行为指导】\n`;
        if (relationships.length > 0) {
            relationships.forEach(([name, data]) => {
                const stage = data.stage;
                const guidelines = currentGuidelines[stage] || this.relationshipGuidelines[stage];
                behaviorGuidance += `\n${name}当前关系阶段: ${stage}\n• 核心态度: ${guidelines.attitude}\n• 允许行为: ${guidelines.allowed}\n• 底线/拒绝行为: ${guidelines.limits}\n`;
            });
        }

        let aiGuidance = behaviorGuidance + `\n💡 指令: 请严格根据上述关系阶段和行为准则，结合角色设定，调整你的回应，确保你的反应符合当前关系发展阶段。请注意行为指导仅作用于指定的NPC对用户的行为指导，不涉及他人。`;

        return {
            userVisibleStats: userVisibleStats + behaviorGuidance,
            fullStatsWithGuidance: userVisibleStats + aiGuidance
        };
    }

    formatEmotionalChange(value) {
        const roundedValue = Math.round(value);
        return roundedValue > 0 ? `+${roundedValue} (积极)` : roundedValue < 0 ? `${roundedValue} (消极)` : "0 (中性)";
    }

    addTrackedRelationship(stats, name, initialIntimacy = 0, gender = 'unknown') {
        if (!stats.relationships[name]) {
            stats.relationships[name] = {
                intimacyLevel: initialIntimacy,
                stage: this.getRelationshipStage(initialIntimacy),
                interactions: 0,
                initialIntimacy: initialIntimacy,
                gender: gender
            };
        }
        return stats;
    }

    removeTrackedRelationship(stats, name) {
        if (stats.relationships[name]) {
            delete stats.relationships[name];
        }
        return stats;
    }
}

// ==================== UI管理层 ====================
class StatsUIManager {
    constructor(executeCommand, showConfirmDialog) {
        this.executeCommand = executeCommand;
        this.showConfirmDialog = showConfirmDialog;
    }

    showMemoryModal(content, isEditing = false) {
        $('#memory-modal').remove();

        const modalHtml = `
        <div id="memory-modal" class="memory-modal main-menu-modal">
            <div class="memory-modal-content main-menu-content">
                <div class="memory-modal-header">
                    <div class="memory-modal-title">🧠 历史数据统计</div>
                    <div class="memory-modal-close">&times;</div>
                </div>
                <div class="memory-tab-content" id="memory-stats-content">${content}</div>
                <div class="memory-modal-footer">
                    <div class="main-menu-footer-buttons">
                        <button id="memory-behavior" class="memory-action-button">🎭 初始设定</button>
                        <button id="memory-edit" class="memory-action-button">✏️ 当前编辑</button>
                        <button id="memory-clear" class="memory-action-button">🗑️ 清空数据</button>
                    </div>
                </div>
            </div>
        </div>`;

        $('body').append(modalHtml);
    }

    showBehaviorSettingsModal(behaviors, trackedNames) {
        $('#behavior-modal').remove();

        const behaviorContent = this.createBehaviorSettingsForm(behaviors, trackedNames);

        const modalHtml = `
        <div id="behavior-modal" class="memory-modal behavior-modal">
            <div class="memory-modal-content behavior-modal-content">
                <div class="memory-modal-header">
                    <div class="memory-modal-title">🎭 角色行为设定${this_chid && characters[this_chid] ? ` - ${characters[this_chid].name}` : ''}</div>
                    <div class="memory-modal-close">&times;</div>
                </div>
                <div class="memory-tab-content behavior-settings-content">${behaviorContent}</div>
                <div class="memory-modal-footer">
                    <div class="behavior-footer-left">
                        <button id="behavior-export" class="memory-action-button secondary">📤 导出</button>
                        <button id="behavior-import" class="memory-action-button secondary">📥 导入</button>
                        <input type="file" id="behavior-import-file" accept=".json" style="display: none;">
                    </div>
                    <div class="behavior-footer-right">
                        <button id="behavior-reset" class="memory-action-button">🔄 重置</button>
                        <button id="behavior-bind" class="memory-action-button">🔗 绑定</button>
                        <button id="behavior-save" class="memory-action-button primary">💾 保存</button>
                    </div>
                </div>
            </div>
        </div>`;

        $('body').append(modalHtml);

        setTimeout(() => {
            $('.behavior-stage-tab:first').addClass('active');
        }, 50);
    }

    showDebugModal(debugLog) {
        $('#debug-log-modal').remove();

        const modalHtml = `
        <div id="debug-log-modal" class="debug-log-modal">
            <div class="debug-log-content">
                <div class="debug-log-header">
                    <div class="debug-log-title">🐞 好感度计算过程</div>
                    <div class="debug-log-close">&times;</div>
                </div>
                <pre class="debug-log-text">${debugLog}</pre>
                <div class="debug-log-footer">
                    <button id="close-debug-log" class="debug-log-button">关闭</button>
                </div>
            </div>
        </div>`;

        $('body').append(modalHtml);

        $('#debug-log-modal .debug-log-close, #close-debug-log').on('click', function () {
            $('#debug-log-modal').remove();
        });
    }

    addMemoryButtonToMessage(messageId, hasMemory = false) {
        const messageBlock = $(`#chat .mes[mesid="${messageId}"]`);
        if (!messageBlock.length || messageBlock.find('.memory-button').length) return;

        const flexContainer = messageBlock.find('.flex-container.flex1.alignitemscenter');
        if (!flexContainer.length) return;

        const buttonHtml = `<div class="mes_btn memory-button" title="查看历史数据统计\n\nPC端: Shift+点击调试分析\n移动端: 长按调试分析"><i class="fa-solid fa-brain"></i></div>`;
        const memoryButton = $(buttonHtml);

        if (hasMemory) {
            memoryButton.addClass('has-memory');
        }

        flexContainer.append(memoryButton);
        return memoryButton;
    }

    createBehaviorSettingsForm(behaviors, trackedNames = []) {
        const stageRanges = {
            "厌恶": "-100~-1", "无视": "0~9", "礼貌": "10~19", "熟悉": "20~29",
            "友善": "30~39", "好感": "40~49", "暧昧": "50~59", "恋人初期": "60~69",
            "热恋": "70~79", "深爱": "80~89", "唯一": "90~99", "命运": "100~∞"
        };

        let html = `
        <div class="behavior-settings-form">
            <div class="behavior-intro">
                <p>该页设定的均为初始内容，不影响当前。支持导出/导入设定，随卡绑定(用户设置内容不会随卡绑定导出)。</p>
                ${this_chid && characters[this_chid] ? `<p class="current-character">当前角色：<strong>${characters[this_chid].name}</strong></p>` : ''}
            </div>

            <div class="user-settings-section">
                <h3>👤 用户设置</h3>
                <div class="user-gender-setting">
                    <label>用户性别：</label>
                    <select id="user-gender-select" class="user-gender-select">
                        <option value="unknown">未知</option>
                        <option value="male">男性 ♂</option>
                        <option value="female">女性 ♀</option>
                    </select>
                </div>
                <div class="user-aliases-setting">
                    <label>用户称呼/昵称：</label>
                    <div id="user-aliases-list" class="user-aliases-list">
                    </div>
                    <div class="add-alias-container">
                        <input type="text" id="new-user-alias" class="alias-input" placeholder="输入用户称呼/昵称" />
                        <button id="add-user-alias" class="add-alias-button">添加</button>
                    </div>
                    <p class="setting-desc">添加NPC在对话中称呼用户的各种方式（如：亲爱的、宝贝等，可多项）</p>
                </div>
            </div>

            <hr class="section-divider" />

            <div class="tracked-names-section">
                <h3>📋 追踪人物设置</h3>
                <p class="section-desc">添加需要追踪关系的人物名称，系统会自动分析与这些人物的互动</p>
                <div id="tracked-names-list" class="tracked-names-list">`;

        trackedNames.forEach(name => {
            const gender = name.gender || 'unknown';
            const intimacy = name.initialIntimacy || 0;
            const displayName = typeof name === 'string' ? name : name.name;

            const genderIcon = gender === 'male' ? '♂' : gender === 'female' ? '♀' : '?';

            html += `
            <div class="tracked-name-item template-mode">
                <span class="tracked-name">${displayName}</span>
                <span class="gender-indicator" title="性别">${genderIcon}</span>
                <div class="tracked-name-stats">
                    <span class="initial-intimacy-value" title="初始好感度">⭐ ${intimacy}</span>
                </div>
                <div class="tracked-name-actions">
                    <button class="edit-name" data-name="${displayName}" data-intimacy="${intimacy}" data-gender="${gender}">✏️</button>
                    <button class="remove-name" data-name="${displayName}">×</button>
                </div>
            </div>`;
        });

        html += `
                </div>
                <div class="add-name-container">
                    <input type="text" id="new-tracked-name" class="tracked-name-input" placeholder="输入人物名称" />
                    <select id="new-tracked-gender" class="tracked-gender-select">
                        <option value="unknown">性别未知</option>
                        <option value="male">男性 ♂</option>
                        <option value="female">女性 ♀</option>
                    </select>
                    <input type="number" id="new-tracked-intimacy" class="tracked-intimacy-input" placeholder="初始好感度" min="-100" value="0" />
                    <button id="add-tracked-name" class="add-name-button">添加</button>
                </div>
            </div>

            <hr class="section-divider" />

            <div class="behavior-stages-selector">`;

        const stages = Object.keys(behaviors);
        stages.forEach(stage => {
            html += `<div class="behavior-stage-tab" data-stage="${stage}" title="点击编辑 ${stage} 阶段设定">${stage}</div>`;
        });

        html += `</div><div class="behavior-stage-content">`;

        stages.forEach((stage, index) => {
            const behavior = behaviors[stage];
            const range = stageRanges[stage] || "未知";
            html += `
            <div class="behavior-stage-form" data-stage="${stage}" ${index === 0 ? '' : 'style="display:none;"'}>
                <h3>${stage} 阶段行为设定 <span class="stage-range">【${range}】</span></h3>
                <div class="behavior-field">
                    <label>核心态度:</label>
                    <textarea class="behavior-textarea" data-stage="${stage}" data-field="attitude">${behavior.attitude}</textarea>
                </div>
                <div class="behavior-field">
                    <label>允许行为:</label>
                    <textarea class="behavior-textarea" data-stage="${stage}" data-field="allowed">${behavior.allowed}</textarea>
                </div>
                <div class="behavior-field">
                    <label>底线/拒绝行为:</label>
                    <textarea class="behavior-textarea" data-stage="${stage}" data-field="limits">${behavior.limits}</textarea>
                </div>
            </div>`;
        });

        html += `</div></div>`;
        return html;
    }

    collectBehaviorSettings() {
        const behaviors = {};
        $('.behavior-stage-form').each(function () {
            const stage = $(this).data('stage');
            behaviors[stage] = {
                attitude: $(this).find(`.behavior-textarea[data-field="attitude"]`).val(),
                allowed: $(this).find(`.behavior-textarea[data-field="allowed"]`).val(),
                limits: $(this).find(`.behavior-textarea[data-field="limits"]`).val()
            };
        });
        return behaviors;
    }

    createEditableStatsForm(stats, relationshipManager) {
        const relationships = Object.entries(stats.relationships || {}).sort((a, b) => b[1].interactions - a[1].interactions);

        const sections = [
            {
                title: '💬 基础数据', fields: [
                    { label: '对话次数', path: 'dialogueCount', value: stats.dialogueCount || 0 },
                    { label: '地点变化', path: 'locationChanges', value: stats.locationChanges || 0 }
                ]
            },
            {
                title: '💞 关系网络',
                isRelationships: true,
                relationships: relationships
            },
            {
                title: '🔞 亲密互动', fields: [
                    { label: '接吻次数', path: 'intimacyStats.kissingEvents', value: stats.intimacyStats?.kissingEvents || 0 },
                    { label: '拥抱次数', path: 'intimacyStats.embraceEvents', value: stats.intimacyStats?.embraceEvents || 0 },
                    { label: '性爱次数', path: 'intimacyStats.sexualEncounters', value: stats.intimacyStats?.sexualEncounters || 0 },
                    { label: '男性高潮', path: 'intimacyStats.maleOrgasms', value: stats.intimacyStats?.maleOrgasms || 0 },
                    { label: '女性高潮', path: 'intimacyStats.femaleOrgasms', value: stats.intimacyStats?.femaleOrgasms || 0 },
                    { label: '吞精次数', path: 'intimacyStats.oralCompletions', value: stats.intimacyStats?.oralCompletions || 0 },
                    { label: '内射次数', path: 'intimacyStats.internalCompletions', value: stats.intimacyStats?.internalCompletions || 0 }
                ]
            },
            {
                title: '😊 情感表达', fields: [
                    { label: '积极情绪', path: 'emotionStats.positiveEmotions', value: stats.emotionStats?.positiveEmotions || 0 },
                    { label: '消极情绪', path: 'emotionStats.negativeEmotions', value: stats.emotionStats?.negativeEmotions || 0 },
                    { label: '爱情表白', path: 'emotionStats.loveExpressions', value: stats.emotionStats?.loveExpressions || 0 },
                    { label: '喜悦表达', path: 'emotionStats.joyEvents', value: stats.emotionStats?.joyEvents || 0 },
                    { label: '悲伤表达', path: 'emotionStats.sadnessEvents', value: stats.emotionStats?.sadnessEvents || 0 },
                    { label: '愤怒爆发', path: 'emotionStats.angerOutbursts', value: stats.emotionStats?.angerOutbursts || 0 },
                    { label: '恐惧表现', path: 'emotionStats.fearEvents', value: stats.emotionStats?.fearEvents || 0 },
                    { label: '惊讶反应', path: 'emotionStats.surpriseEvents', value: stats.emotionStats?.surpriseEvents || 0 }
                ]
            },
            {
                title: '⚔️ 暴力冲突', fields: [
                    { label: '身体冲突', path: 'violenceStats.hitEvents', value: stats.violenceStats?.hitEvents || 0 },
                    { label: '武器使用', path: 'violenceStats.weaponUse', value: stats.violenceStats?.weaponUse || 0 },
                    { label: '死亡事件', path: 'violenceStats.deathEvents', value: stats.violenceStats?.deathEvents || 0 }
                ]
            },
            {
                title: '💰 物品交换', fields: [
                    { label: '礼物交换', path: 'exchangeStats.giftGiving', value: stats.exchangeStats?.giftGiving || 0 },
                    { label: '金钱交易', path: 'exchangeStats.moneyTransfer', value: stats.exchangeStats?.moneyTransfer || 0 }
                ]
            }
        ];

        let html = '<div class="stats-editor">';
        sections.forEach(section => {
            html += `<div class="stats-section"><h3>${section.title}</h3>`;

            if (section.isRelationships) {
                if (section.relationships && section.relationships.length > 0) {
                    section.relationships.forEach(([name, data]) => {
                        const intimacyLevel = data.intimacyLevel || 0;
                        const stage = data.stage || relationshipManager.getRelationshipStage(intimacyLevel);
                        html += `<div class="stats-field">
                            <label>${name}:</label>
                            <input type="number" data-path="relationships.${name}.intimacyLevel" value="${intimacyLevel}" min="-100" />
                            <span class="relationship-stage">${stage}</span>
                        </div>`;
                    });
                } else {
                    html += `<div class="stats-empty-message">暂无关系记录</div>`;
                }
            } else {
                section.fields.forEach(field => {
                    html += `<div class="stats-field"><label>${field.label}:</label><input type="number" data-path="${field.path}" value="${field.value}" min="0" /></div>`;
                });
            }

            html += '</div>';
        });
        html += '</div>';
        return html;
    }

    collectStatsFromForm(relationshipManager) {
        const stats = {
            dialogueCount: 0,
            locationChanges: 0,
            intimacyStats: {},
            emotionStats: {},
            violenceStats: {},
            exchangeStats: {},
            relationships: {}
        };

        $('.stats-field input').each(function () {
            const path = $(this).data('path');
            if (!path) return;

            const value = parseInt($(this).val()) || 0;
            const pathParts = path.split('.');

            if (pathParts.length === 1) {
                stats[pathParts[0]] = value;
            } else if (pathParts.length === 2) {
                if (!stats[pathParts[0]]) {
                    stats[pathParts[0]] = {};
                }
                stats[pathParts[0]][pathParts[1]] = value;
            } else if (pathParts.length === 3 && pathParts[0] === 'relationships') {
                const name = pathParts[1];
                const field = pathParts[2];

                if (!stats.relationships[name]) {
                    stats.relationships[name] = {
                        interactions: 0,
                        initialIntimacy: 0
                    };
                }

                stats.relationships[name][field] = value;

                if (field === 'intimacyLevel') {
                    stats.relationships[name].stage = relationshipManager.getRelationshipStage(value);
                }
            }
        });

        return stats;
    }

    showEditNameDialog(name, currentIntimacy, currentGender, updateCallback) {
        $('.xiaobaix-edit-name-modal').remove();

        const dialogHtml = `
        <div class="xiaobaix-edit-name-modal">
            <div class="xiaobaix-edit-name-content">
                <h3>编辑人物关系</h3>
                <div class="edit-name-field">
                    <label>人物名称:</label>
                    <input type="text" id="edit-name-input" value="${name}" readonly />
                </div>
                <div class="edit-name-field">
                    <label>性别:</label>
                    <select id="edit-gender-input">
                        <option value="unknown" ${currentGender === 'unknown' ? 'selected' : ''}>未知</option>
                        <option value="male" ${currentGender === 'male' ? 'selected' : ''}>男性 ♂</option>
                        <option value="female" ${currentGender === 'female' ? 'selected' : ''}>女性 ♀</option>
                    </select>
                </div>
                <div class="edit-name-field">
                    <label>初始好感度 (-100 ~ 无上限):</label>
                    <input type="number" id="edit-intimacy-input" min="-100" value="${currentIntimacy}" />
                </div>
                <div class="xiaobaix-edit-name-buttons">
                    <button class="xiaobaix-edit-name-save">保存</button>
                    <button class="xiaobaix-edit-name-cancel">取消</button>
                </div>
            </div>
        </div>`;

        $('body').append(dialogHtml);

        $(document).off('click', '.xiaobaix-edit-name-save').on('click', '.xiaobaix-edit-name-save', async () => {
            const newIntimacy = parseInt($('#edit-intimacy-input').val()) || 0;
            const newGender = $('#edit-gender-input').val();
            await updateCallback(name, newIntimacy, newGender);
            $('.xiaobaix-edit-name-modal').remove();
        });

        $(document).off('click', '.xiaobaix-edit-name-cancel, .xiaobaix-edit-name-modal').on('click', '.xiaobaix-edit-name-cancel, .xiaobaix-edit-name-modal', function (e) {
            if (e.target === this) {
                $('.xiaobaix-edit-name-modal').remove();
            }
        });
    }

    showConfirmDialog(message, onConfirm, onCancel) {
        $('.xiaobaix-confirm-modal').remove();

        const dialogHtml = `
        <div class="xiaobaix-confirm-modal">
            <div class="xiaobaix-confirm-content">
                <div class="xiaobaix-confirm-message">${message}</div>
                <div class="xiaobaix-confirm-buttons">
                    <button class="xiaobaix-confirm-yes">确定</button>
                    <button class="xiaobaix-confirm-no">取消</button>
                </div>
            </div>
        </div>`;

        $('body').append(dialogHtml);

        $(document).off('click', '.xiaobaix-confirm-yes').on('click', '.xiaobaix-confirm-yes', function () {
            $('.xiaobaix-confirm-modal').remove();
            if (typeof onConfirm === 'function') onConfirm();
        });

        $(document).off('click', '.xiaobaix-confirm-no').on('click', '.xiaobaix-confirm-no', function () {
            $('.xiaobaix-confirm-modal').remove();
            if (typeof onCancel === 'function') onCancel();
        });

        $(document).off('click', '.xiaobaix-confirm-modal').on('click', '.xiaobaix-confirm-modal', function (e) {
            if (e.target === this) {
                $(this).remove();
                if (typeof onCancel === 'function') onCancel();
            }
        });

        $(document).off('keydown.confirmmodal').on('keydown.confirmmodal', function (e) {
            if (e.key === 'Escape') {
                $('.xiaobaix-confirm-modal').remove();
                $(document).off('keydown.confirmmodal');
                if (typeof onCancel === 'function') onCancel();
            }
        });
    }
}

// ==================== 主控制器 ====================
class StatsTracker {
    constructor() {
        this.EXT_ID = null;
        this.MODULE_NAME = null;
        this.settings = null;
        this.executeCommand = null;
        this.characterSettings = new Map();
        this.currentCharacterId = null;
        this.isInitialized = false;

        this.dataManager = null;
        this.relationshipManager = new RelationshipManager();
        this.textAnalysis = new TextAnalysisEngine(this.relationshipManager);
        this.uiManager = null;
    }

    isGloballyEnabled() {
        return window.isXiaobaixEnabled !== undefined ? window.isXiaobaixEnabled : true;
    }

    init(extId, moduleName, settings, executeCommand) {
        this.EXT_ID = extId;
        this.MODULE_NAME = moduleName;
        this.settings = settings;
        this.executeCommand = executeCommand;

        this.dataManager = new StatsDataManager(executeCommand);
        this.uiManager = new StatsUIManager(executeCommand, this.showConfirmDialog.bind(this));

        if (!extension_settings[extId].relationshipGuidelines) {
            extension_settings[extId].relationshipGuidelines = structuredClone(this.relationshipManager.relationshipGuidelines);
        }

        if (!this.settings.userGender) {
            this.settings.userGender = 'unknown';
        }

        if (!this.settings.userAliases) {
            this.settings.userAliases = [];
        }

        this.textAnalysis.updateUserSettings({
            gender: this.settings.userGender,
            aliases: this.settings.userAliases
        });

        this.setupEventListeners();

        if (window.registerModuleCleanup) {
            window.registerModuleCleanup('relationshipMetrics', () => this.cleanup());
        }

        setTimeout(() => {
            this.initializeCurrentCharacter();
        }, 100);

        this.isInitialized = true;
    }

    setupEventListeners() {
        this.chatChangedHandler = async () => {
            await this.handleCharacterSwitch();
        };
        this.appReadyHandler = async () => {
            await this.handleCharacterSwitch();
        };

        eventSource.on(event_types.CHAT_CHANGED, this.chatChangedHandler);
        eventSource.on(event_types.APP_READY, this.appReadyHandler);
    }

    cleanup() {
        if (this.chatChangedHandler) {
            eventSource.removeListener(event_types.CHAT_CHANGED, this.chatChangedHandler);
        }
        if (this.appReadyHandler) {
            eventSource.removeListener(event_types.APP_READY, this.appReadyHandler);
        }

        this.removeMemoryPrompt();

        this.isInitialized = false;
        this.chatChangedHandler = null;
        this.appReadyHandler = null;
        this.textAnalysis.pronounMapping.clear();
    }

    async initializeCurrentCharacter() {
        if (this_chid && characters[this_chid]) {
            await this.handleCharacterSwitch();
        }
    }

    async handleCharacterSwitch() {
        this.textAnalysis.pronounMapping.clear();
        const newCharId = this_chid;
        const userMemoryEnabled = this.settings.memoryEnabled;
        const userMemoryInjectEnabled = this.settings.memoryInjectEnabled;
        const userGlobalEnabled = this.isGloballyEnabled();

        if (this.currentCharacterId && this.currentCharacterId !== newCharId && extension_settings[this.EXT_ID].relationshipGuidelines) {
            this.characterSettings.set(this.currentCharacterId, structuredClone(extension_settings[this.EXT_ID].relationshipGuidelines));
        }

        this.currentCharacterId = newCharId;

        if (!newCharId || !characters[newCharId]) {
            extension_settings[this.EXT_ID].relationshipGuidelines = structuredClone(this.relationshipManager.relationshipGuidelines);
            return;
        }

        const savedData = await this.dataManager.loadRelationshipSettingsFromCharacter();

        if (savedData?.relationshipGuidelines) {
            extension_settings[this.EXT_ID].relationshipGuidelines = structuredClone(savedData.relationshipGuidelines);
            this.characterSettings.set(newCharId, structuredClone(savedData.relationshipGuidelines));

            if (userGlobalEnabled && userMemoryEnabled && savedData.settings) {
                this.settings.memoryInjectDepth = savedData.settings.memoryInjectDepth ?? this.settings.memoryInjectDepth;
            }

            let currentStats = await this.executeCommand('/getvar xiaobaix_stats');
            if (!currentStats || currentStats === "undefined") {
                const newStats = this.dataManager.createEmptyStats();

                if (savedData.trackedRelationships) {
                    Object.entries(savedData.trackedRelationships).forEach(([name, data]) => {
                        const initialIntimacy = data.initialIntimacy !== undefined ? data.initialIntimacy : 0;
                        const gender = data.gender || 'unknown';
                        newStats.relationships[name] = {
                            intimacyLevel: initialIntimacy,
                            stage: this.relationshipManager.getRelationshipStage(initialIntimacy),
                            interactions: 0,
                            initialIntimacy: initialIntimacy,
                            gender: gender
                        };
                    });
                }

                await this.executeCommand(`/setvar key=xiaobaix_stats ${JSON.stringify(newStats)}`);
            }
        } else if (this.characterSettings.has(newCharId)) {
            extension_settings[this.EXT_ID].relationshipGuidelines = this.characterSettings.get(newCharId);
        } else {
            extension_settings[this.EXT_ID].relationshipGuidelines = structuredClone(this.relationshipManager.relationshipGuidelines);
            this.characterSettings.set(newCharId, structuredClone(this.relationshipManager.relationshipGuidelines));
        }

        if (userMemoryEnabled && this.settings.memoryInjectEnabled && userGlobalEnabled) {
            await this.updateMemoryPrompt();
        } else {
            this.removeMemoryPrompt();
        }

        if ($('#behavior-modal').length) {
            const newContent = this.uiManager.createBehaviorSettingsForm(extension_settings[this.EXT_ID].relationshipGuidelines);
            $('#behavior-modal .behavior-settings-content').html(newContent);
            $('.behavior-stage-tab:first').addClass('active');
            this.loadTrackedNamesList();
        }
    }

    getCurrentCharacterGuidelines() {
        return extension_settings[this.EXT_ID].relationshipGuidelines || this.relationshipManager.relationshipGuidelines;
    }

    saveCurrentSettingsToCache() {
        if (this.currentCharacterId) {
            this.characterSettings.set(this.currentCharacterId, structuredClone(extension_settings[this.EXT_ID].relationshipGuidelines));
        }
    }

    getCharacterFromMessage(messageElement) {
        try {
            const messageContainer = messageElement.closest('.mes');
            const nameElement = messageContainer?.querySelector('.ch_name .name');
            return nameElement?.textContent.trim() || null;
        } catch (err) {
            return null;
        }
    }

    async updateStatisticsForNewMessage() {
        if (!this.settings.memoryEnabled || !this.isGloballyEnabled()) return false;

        try {
            const lastMessage = await this.executeCommand('/messages names=on {{lastMessageId}}');
            if (!lastMessage) return false;

            const colonIndex = lastMessage.indexOf(':');
            if (colonIndex === -1) return false;

            const extractedName = lastMessage.substring(0, colonIndex).trim();
            const extractedText = lastMessage.substring(colonIndex + 1).trim();

            if (!extractedText) return false;

            let currentStats = await this.dataManager.loadStats();
            const oldStats = JSON.parse(JSON.stringify(currentStats));

            this.textAnalysis.updateUserSettings({
                gender: this.settings.userGender,
                aliases: this.settings.userAliases
            });

            currentStats = this.textAnalysis.updateStatsFromText(currentStats, extractedText, extractedName);

            currentStats.lastChanges = {
                dialogueCount: currentStats.dialogueCount - oldStats.dialogueCount,
                locationChanges: currentStats.locationChanges - oldStats.locationChanges,
                intimacyStats: {},
                emotionStats: {},
                violenceStats: {},
                exchangeStats: {}
            };

            Object.keys(currentStats.intimacyStats).forEach(key => {
                currentStats.lastChanges.intimacyStats[key] = currentStats.intimacyStats[key] - oldStats.intimacyStats[key];
            });
            Object.keys(currentStats.emotionStats).forEach(key => {
                currentStats.lastChanges.emotionStats[key] = currentStats.emotionStats[key] - oldStats.emotionStats[key];
            });
            Object.keys(currentStats.violenceStats).forEach(key => {
                currentStats.lastChanges.violenceStats[key] = currentStats.violenceStats[key] - oldStats.violenceStats[key];
            });
            Object.keys(currentStats.exchangeStats).forEach(key => {
                currentStats.lastChanges.exchangeStats[key] = currentStats.exchangeStats[key] - oldStats.exchangeStats[key];
            });

            await this.dataManager.saveStats(currentStats);

            if (this.settings.memoryInjectEnabled) {
                this.updateMemoryPrompt();
            }

            return true;
        } catch (error) {
            console.error('[小白X] 更新统计数据出错:', error);
            return false;
        }
    }

    async updateMemoryPrompt() {
        if (!this.settings.memoryEnabled || !this.settings.memoryInjectEnabled || !this.isGloballyEnabled()) {
            this.removeMemoryPrompt();
            return;
        }

        let stats = await this.dataManager.loadStats();
        if (!stats || typeof stats !== 'object') {
            this.removeMemoryPrompt();
            return;
        }

        const currentGuidelines = this.getCurrentCharacterGuidelines();
        const formattedStats = this.relationshipManager.formatHistoryStatistics(stats, currentGuidelines);
        setExtensionPrompt(this.MODULE_NAME, formattedStats.fullStatsWithGuidance, extension_prompt_types.IN_PROMPT, this.settings.memoryInjectDepth, false, 0);
    }

    removeMemoryPrompt() {
        setExtensionPrompt(this.MODULE_NAME, '', extension_prompt_types.IN_PROMPT);
    }

    addMemoryButtonToMessage(messageId) {
        if (!this.settings.memoryEnabled || !this.isInitialized || !this.isGloballyEnabled()) return;

        const messageBlock = $(`#chat .mes[mesid="${messageId}"]`);
        if (!messageBlock.length || messageBlock.find('.memory-button').length) return;

        const flexContainer = messageBlock.find('.flex-container.flex1.alignitemscenter');
        if (!flexContainer.length) return;

        const buttonHtml = `<div class="mes_btn memory-button" title="查看历史数据统计\n\nPC端: Shift+点击调试分析\n移动端: 长按调试分析"><i class="fa-solid fa-brain"></i></div>`;
        const memoryButton = $(buttonHtml);

        this.executeCommand('/getvar xiaobaix_stats').then(result => {
            if (result && result !== "undefined") {
                try {
                    const stats = typeof result === 'string' ? JSON.parse(result) : result;
                    if (stats && Object.keys(stats).length > 0) {
                        memoryButton.addClass('has-memory');
                    }
                } catch (e) { }
            }
        });

        let pressTimer = null;
        let isLongPress = false;

        memoryButton.on('mousedown touchstart', (event) => {
            isLongPress = false;
            pressTimer = setTimeout(() => {
                isLongPress = true;
                this.triggerDebugAnalysis(messageId);
            }, 800);
        });

        memoryButton.on('mouseup touchend mouseleave', (event) => {
            if (pressTimer) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
        });

        memoryButton.on('click', async (event) => {
            event.preventDefault();

            if (isLongPress) {
                isLongPress = false;
                return;
            }

            if (event.shiftKey) {
                this.triggerDebugAnalysis(messageId);
                return;
            }

            let stats = await this.executeCommand('/getvar xiaobaix_stats');

            if (!stats || stats === "undefined") {
                const emptyStats = this.dataManager.createEmptyStats();
                const messages = await this.dataManager.processMessageHistory();

                if (messages && messages.length > 0) {
                    for (const message of messages) {
                        this.textAnalysis.updateStatsFromText(emptyStats, message.content, message.name);
                    }

                    await this.dataManager.saveStats(emptyStats);
                    const formattedStats = this.relationshipManager.formatHistoryStatistics(emptyStats, this.getCurrentCharacterGuidelines());
                    this.uiManager.showMemoryModal(formattedStats.userVisibleStats);

                    if (this.settings.memoryInjectEnabled) {
                        this.updateMemoryPrompt();
                    }
                } else {
                    const formattedStats = this.relationshipManager.formatHistoryStatistics(emptyStats, this.getCurrentCharacterGuidelines());
                    this.uiManager.showMemoryModal(formattedStats.userVisibleStats);
                }
            } else {
                try {
                    stats = typeof stats === 'string' ? JSON.parse(stats) : stats;
                    const formattedStats = this.relationshipManager.formatHistoryStatistics(stats, this.getCurrentCharacterGuidelines());
                    this.uiManager.showMemoryModal(formattedStats.userVisibleStats);
                } catch (e) {
                    const emptyStats = this.dataManager.createEmptyStats();
                    const formattedStats = this.relationshipManager.formatHistoryStatistics(emptyStats, this.getCurrentCharacterGuidelines());
                    this.uiManager.showMemoryModal(formattedStats.userVisibleStats);
                }
            }

            setTimeout(() => {
                this.bindMemoryModalEvents();
            }, 50);
        });

        flexContainer.append(memoryButton);
    }

    async triggerDebugAnalysis(messageId) {
        try {
            const messageIndex = parseInt(messageId);
            let originalMessageText = null;
            let characterName = null;

            if (typeof window.chat !== 'undefined' && window.chat && Array.isArray(window.chat)) {
                const message = window.chat[messageIndex];
                if (message) {
                    originalMessageText = message.mes || message.message || '';
                    characterName = message.name || '';
                }
            }

            if (!originalMessageText) {
                const rawMessage = await this.executeCommand(`/messages names=on ${messageIndex}`);
                if (rawMessage) {
                    const colonIndex = rawMessage.indexOf(':');
                    if (colonIndex !== -1) {
                        characterName = rawMessage.substring(0, colonIndex).trim();
                        originalMessageText = rawMessage.substring(colonIndex + 1).trim();
                    }
                }
            }

            if (!originalMessageText) {
                const messageBlock = $(`#chat .mes[mesid="${messageId}"]`);
                originalMessageText = messageBlock.find('.mes_text').text().trim();
                characterName = messageBlock.find('.ch_name .name').text().trim();
                console.warn('[调试] 无法获取原始消息文本，使用DOM文本（可能缺少XML标签）');
            }

            const currentStats = await this.dataManager.loadStats();
            this.textAnalysis.updateUserSettings({
                gender: this.settings.userGender,
                aliases: this.settings.userAliases
            });
            const debugLog = await this.textAnalysis.debugAnalyzeMessage(originalMessageText, characterName, messageIndex, currentStats);
            this.uiManager.showDebugModal(debugLog);
        } catch (error) {
            console.error('[调试] 获取消息文本失败:', error);

            const messageBlock = $(`#chat .mes[mesid="${messageId}"]`);
            const messageText = messageBlock.find('.mes_text').text().trim();
            const characterName = messageBlock.find('.ch_name .name').text().trim();
            const currentStats = await this.dataManager.loadStats();
            const debugLog = await this.textAnalysis.debugAnalyzeMessage(messageText, characterName, messageId, currentStats);
            this.uiManager.showDebugModal(debugLog);
        }
    }

    bindMemoryModalEvents() {
        $(document).off('click', '#memory-modal .memory-modal-close, #memory-modal').on('click', '#memory-modal .memory-modal-close, #memory-modal', function (e) {
            if (e.target === this) {
                $('#memory-modal').remove();
            }
        });

        $(document).off('click', '#memory-behavior').on('click', '#memory-behavior', () => {
            $('#memory-modal').hide();
            this.showBehaviorSettingsModal();
        });

        $(document).off('click', '#memory-edit').on('click', '#memory-edit', async () => {
            const isCurrentlyEditing = $('#memory-edit').attr('data-editing') === 'true';
            if (isCurrentlyEditing) {
                let currentStats = await this.dataManager.loadStats();
                const updatedStatsFromForm = this.uiManager.collectStatsFromForm(this.relationshipManager);

                const finalStats = {
                    ...currentStats,
                    ...updatedStatsFromForm,
                    relationships: { ...currentStats.relationships }
                };
                Object.entries(updatedStatsFromForm.relationships || {}).forEach(([name, data]) => {
                    if (finalStats.relationships[name]) {
                        finalStats.relationships[name].intimacyLevel = data.intimacyLevel;
                        finalStats.relationships[name].stage = data.stage;
                    } else {
                        finalStats.relationships[name] = data;
                    }
                });
                if (currentStats.intimacyStats) {
                    finalStats.intimacyStats = { ...currentStats.intimacyStats, ...updatedStatsFromForm.intimacyStats };
                }
                if (currentStats.emotionStats) {
                    finalStats.emotionStats = { ...currentStats.emotionStats, ...updatedStatsFromForm.emotionStats };
                }
                if (currentStats.violenceStats) {
                    finalStats.violenceStats = { ...currentStats.violenceStats, ...updatedStatsFromForm.violenceStats };
                }
                if (currentStats.exchangeStats) {
                    finalStats.exchangeStats = { ...currentStats.exchangeStats, ...updatedStatsFromForm.exchangeStats };
                }
                if (currentStats.relationshipStats) {
                    finalStats.relationshipStats = { ...currentStats.relationshipStats, ...updatedStatsFromForm.relationshipStats };
                }
                if (currentStats.lastChanges) {
                    finalStats.lastChanges = currentStats.lastChanges;
                }
                await this.dataManager.saveStats(finalStats);
                if (this.settings.memoryInjectEnabled) {
                    this.updateMemoryPrompt();
                }
                const currentGuidelines = this.getCurrentCharacterGuidelines();
                const formattedStats = this.relationshipManager.formatHistoryStatistics(finalStats, currentGuidelines);
                $('#memory-modal .memory-tab-content').html(formattedStats.userVisibleStats);
                $('#memory-edit').text('✏️ 编辑数据').attr('data-editing', 'false');
                this.executeCommand('/echo 数据已更新');
            } else {

                let stats = await this.dataManager.loadStats();

                const editForm = this.uiManager.createEditableStatsForm(stats, this.relationshipManager);
                $('#memory-modal .memory-tab-content').html(editForm);

                $('#memory-edit').text('💾 保存数据').attr('data-editing', 'true');
            }
        });

        $(document).off('click', '#memory-clear').on('click', '#memory-clear', async () => {
            this.showConfirmDialog('确定要清空所有数据吗？此操作不可撤销。', async () => {
                await this.dataManager.clearStats();
                this.removeMemoryPrompt();
                $('#memory-modal').remove();
                this.executeCommand('/echo 统计数据已清空');
            });
        });

        $(document).off('keydown.memorymodal').on('keydown.memorymodal', function (e) {
            if (e.key === 'Escape') {
                $('#memory-modal').remove();
                $(document).off('keydown.memorymodal');
            }
        });
    }

    showBehaviorSettingsModal() {
        $('#memory-modal').remove();
        this.dataManager.loadStats().then(stats => {
            const trackedNamesData = [];
            Object.entries(stats.relationships || {}).forEach(([name, data]) => {
                trackedNamesData.push({
                    name: name,
                    gender: data.gender || 'unknown',
                    initialIntimacy: data.initialIntimacy || 0
                });
            });
            this.uiManager.showBehaviorSettingsModal(this.getCurrentCharacterGuidelines(), trackedNamesData);
            setTimeout(() => {
                this.bindBehaviorModalEvents();
                this.updateUserAliasesList();
                $('#user-gender-select').val(this.settings.userGender || 'unknown');
            }, 50);
        });
    }

    updateUserAliasesList() {
        const container = $('#user-aliases-list');
        if (!container.length) return;

        container.empty();

        this.settings.userAliases.forEach(alias => {
            const aliasItem = $(`
                <div class="user-alias-item">
                    <span class="alias-text">${alias}</span>
                    <button class="remove-alias" data-alias="${alias}">×</button>
                </div>
            `);
            container.append(aliasItem);
        });
    }

    bindBehaviorModalEvents() {
        $(document).off('click', '#behavior-modal .memory-modal-close, #behavior-modal').on('click', '#behavior-modal .memory-modal-close, #behavior-modal', (e) => {
            if (e.target === e.currentTarget) {
                $('#behavior-modal').remove();
                if ($('#memory-modal').length && $('#memory-modal').is(':hidden')) {
                    $('#memory-modal').show();
                }
            }
        });

        $(document).off('click', '#behavior-reset').on('click', '#behavior-reset', () => {
            this.showConfirmDialog('确定要重置所有行为设定为默认值吗？', () => {
                extension_settings[this.EXT_ID].relationshipGuidelines = structuredClone(this.relationshipManager.relationshipGuidelines);

                if (this.currentCharacterId) {
                    this.characterSettings.set(this.currentCharacterId, structuredClone(this.relationshipManager.relationshipGuidelines));
                }

                saveSettingsDebounced();

                const newContent = this.uiManager.createBehaviorSettingsForm(this.relationshipManager.relationshipGuidelines);
                $('#behavior-modal .behavior-settings-content').html(newContent);
                $('.behavior-stage-tab:first').addClass('active');

                this.executeCommand('/echo 行为设定已重置为默认值');
            });
        });

        $(document).off('click', '#behavior-export').on('click', '#behavior-export', async () => {
            const currentBehaviors = this.getCurrentCharacterGuidelines();
            const currentStats = await this.dataManager.loadStats();

            const trackedRelationships = {};
            Object.entries(currentStats.relationships || {}).forEach(([name, data]) => {
                trackedRelationships[name] = {
                    initialIntimacy: data.initialIntimacy !== undefined ? data.initialIntimacy : data.intimacyLevel,
                    gender: data.gender || 'unknown'
                };
            });

            const fileName = this.dataManager.exportBehaviorSettings(currentBehaviors, trackedRelationships, {
                memoryEnabled: this.settings.memoryEnabled,
                memoryInjectEnabled: this.settings.memoryInjectEnabled,
                memoryInjectDepth: this.settings.memoryInjectDepth
            });

            const trackedCount = Object.keys(trackedRelationships).length;
            const stageCount = Object.keys(currentBehaviors).length;
            const message = `完整行为设定已导出到 "${fileName}"\n包含：${stageCount}个关系阶段，${trackedCount}个追踪人物${this_chid && characters[this_chid] ? `\n角色：${characters[this_chid].name}` : ''}`;
            this.executeCommand(`/echo ${message}`);
        });

        $(document).off('click', '#behavior-import').on('click', '#behavior-import', () => {
            $('#behavior-import-file').trigger('click');
        });

        $(document).off('change', '#behavior-import-file').on('change', '#behavior-import-file', async (e) => {
            const file = e.target.files[0];
            if (file) {
                const importResult = await this.dataManager.importBehaviorSettings(
                    file,
                    this.executeCommand,
                    this.relationshipManager.relationshipGuidelines,
                    this.characterSettings,
                    this.currentCharacterId,
                    this.settings,
                    this.EXT_ID
                );

                if (importResult) {
                    this.showConfirmDialog(
                        importResult.confirmMessage,
                        async () => {
                            const importData = importResult.importData;
                            const hasTrackedRelationships = importResult.hasTrackedRelationships;
                            const isCharacterSpecific = importResult.isCharacterSpecific;
                            const isMatchingCharacter = importResult.isMatchingCharacter;

                            extension_settings[this.EXT_ID].relationshipGuidelines = importData.relationshipGuidelines;

                            if (this.currentCharacterId) {
                                this.characterSettings.set(this.currentCharacterId, structuredClone(importData.relationshipGuidelines));
                            }

                            if (importData.settings) {
                                this.settings.memoryEnabled = importData.settings.memoryEnabled ?? this.settings.memoryEnabled;
                                this.settings.memoryInjectEnabled = importData.settings.memoryInjectEnabled ?? this.settings.memoryInjectEnabled;
                                this.settings.memoryInjectDepth = importData.settings.memoryInjectDepth ?? this.settings.memoryInjectDepth;
                            }
                            this.textAnalysis.updateUserSettings({
                                gender: this.settings.userGender,
                                aliases: this.settings.userAliases
                            });

                            let currentStats = await this.dataManager.loadStats();

                            if (hasTrackedRelationships) {
                                Object.entries(importData.trackedRelationships).forEach(([name, data]) => {
                                    const initialIntimacy = data.initialIntimacy !== undefined ? data.initialIntimacy : 0;
                                    const gender = data.gender || 'unknown';
                                    if (!currentStats.relationships[name]) {
                                        currentStats.relationships[name] = {
                                            intimacyLevel: initialIntimacy,
                                            stage: this.relationshipManager.getRelationshipStage(initialIntimacy),
                                            interactions: 0,
                                            initialIntimacy: initialIntimacy,
                                            gender: gender
                                        };
                                    } else {
                                        currentStats.relationships[name].initialIntimacy = initialIntimacy;
                                        currentStats.relationships[name].gender = gender;
                                    }
                                });

                                await this.dataManager.saveStats(currentStats);
                            }

                            saveSettingsDebounced();

                            if ($('#behavior-modal').length) {
                                const newContent = this.uiManager.createBehaviorSettingsForm(importData.relationshipGuidelines);
                                $('#behavior-modal .behavior-settings-content').html(newContent);
                                $('.behavior-stage-tab:first').addClass('active');
                                this.loadTrackedNamesList();
                                this.updateUserAliasesList();
                                $('#user-gender-select').val(this.settings.userGender || 'unknown');
                            }

                            let successMessage = '行为设定已成功导入';
                            if (hasTrackedRelationships) {
                                successMessage += `\n已恢复 ${Object.keys(importData.trackedRelationships).length} 个追踪人物(含初始好感度)`;
                            }

                            this.executeCommand(`/echo ${successMessage}`);

                            if (this.settings.memoryEnabled && this_chid) {
                                await this.saveRelationshipSettingsToCharacter(true);
                            }

                            if (this.settings.memoryEnabled && this.settings.memoryInjectEnabled && this.isGloballyEnabled()) {
                                await this.updateMemoryPrompt();
                            }

                            if (isCharacterSpecific && isMatchingCharacter) {
                                await this.handleCharacterSwitch();
                            }
                        },
                        () => {
                            this.executeCommand('/echo 已取消导入');
                        }
                    );
                }

                e.target.value = '';
            }
        });

        $(document).off('click', '#behavior-bind').on('click', '#behavior-bind', () => {
            const updatedBehaviors = this.uiManager.collectBehaviorSettings();
            extension_settings[this.EXT_ID].relationshipGuidelines = updatedBehaviors;

            if (this.currentCharacterId) {
                this.characterSettings.set(this.currentCharacterId, structuredClone(updatedBehaviors));
            }

            saveSettingsDebounced();
            this.saveRelationshipSettingsToCharacter(true);
        });

        $(document).off('click', '#behavior-save').on('click', '#behavior-save', async () => {
            const updatedBehaviors = this.uiManager.collectBehaviorSettings();
            extension_settings[this.EXT_ID].relationshipGuidelines = updatedBehaviors;

            if (this.currentCharacterId) {
                this.characterSettings.set(this.currentCharacterId, structuredClone(updatedBehaviors));
            }

            saveSettingsDebounced();

            $('#behavior-modal').remove();
            this.executeCommand('/echo 行为设定已保存');

            if (this.settings.memoryEnabled && this.settings.memoryInjectEnabled && this.isGloballyEnabled()) {
                await this.updateMemoryPrompt();
            }
        });

        $(document).off('keydown.behaviormodal').on('keydown.behaviormodal', function (e) {
            if (e.key === 'Escape') {
                $('#behavior-modal').remove();
                $(document).off('keydown.behaviormodal');
            }
        });

        $(document).off('click', '.behavior-stage-tab').on('click', '.behavior-stage-tab', function () {
            const stage = $(this).data('stage');
            $('.behavior-stage-tab').removeClass('active');
            $(this).addClass('active');
            $('.behavior-stage-form').hide();
            $(`.behavior-stage-form[data-stage="${stage}"]`).show();
        });

        $(document).off('click', '#add-user-alias').on('click', '#add-user-alias', () => {
            const newAlias = $('#new-user-alias').val().trim();
            if (newAlias && !this.settings.userAliases.includes(newAlias)) {
                this.settings.userAliases.push(newAlias);
                this.updateUserAliasesList();
                $('#new-user-alias').val('');

                this.textAnalysis.updateUserSettings({
                    gender: this.settings.userGender,
                    aliases: this.settings.userAliases
                });

                saveSettingsDebounced();
            }
        });

        $(document).off('click', '.remove-alias').on('click', '.remove-alias', (e) => {
            const alias = $(e.currentTarget).data('alias');
            const index = this.settings.userAliases.indexOf(alias);
            if (index > -1) {
                this.settings.userAliases.splice(index, 1);
                this.updateUserAliasesList();

                this.textAnalysis.updateUserSettings({
                    gender: this.settings.userGender,
                    aliases: this.settings.userAliases
                });

                saveSettingsDebounced();
            }
        });

        $(document).off('change', '#user-gender-select').on('change', '#user-gender-select', (e) => {
            this.settings.userGender = $(e.target).val();

            this.textAnalysis.updateUserSettings({
                gender: this.settings.userGender,
                aliases: this.settings.userAliases
            });

            saveSettingsDebounced();
        });

        this.loadTrackedNamesList();
    }

    async loadTrackedNamesList() {
        try {
            const stats = await this.dataManager.loadStats();
            const trackedNames = Object.entries(stats.relationships || {}).map(([name, data]) => ({
                name,
                gender: data.gender || 'unknown',
                intimacy: data.initialIntimacy !== undefined ? data.initialIntimacy : data.intimacyLevel || 0
            }));

            const listContainer = $('#tracked-names-list');
            if (listContainer.length === 0) return;

            listContainer.empty();

            trackedNames.forEach(nameData => {
                const name = nameData.name;
                const gender = nameData.gender;
                const intimacy = nameData.intimacy;

                const genderIcon = gender === 'male' ? '♂' : gender === 'female' ? '♀' : '?';

                const nameItem = $(`
                    <div class="tracked-name-item template-mode">
                        <span class="tracked-name">${name}</span>
                        <span class="gender-indicator" title="性别">${genderIcon}</span>
                        <div class="tracked-name-stats">
                            <span class="initial-intimacy-value" title="初始好感度">⭐ ${intimacy}</span>
                        </div>
                        <div class="tracked-name-actions">
                            <button class="edit-name" data-name="${name}" data-intimacy="${intimacy}" data-gender="${gender}">✏️</button>
                            <button class="remove-name" data-name="${name}">×</button>
                        </div>
                    </div>`);
                listContainer.append(nameItem);
            });

            const addNameContainer = $('.add-name-container');
            if (addNameContainer.length) {
                addNameContainer.html(`
                    <input type="text" id="new-tracked-name" class="tracked-name-input" placeholder="输入人物名称" />
                    <select id="new-tracked-gender" class="tracked-gender-select">
                        <option value="unknown">性别未知</option>
                        <option value="male">男性 ♂</option>
                        <option value="female">女性 ♀</option>
                    </select>
                    <input type="number" id="new-tracked-intimacy" class="tracked-intimacy-input" placeholder="初始好感度" min="-100" value="0" />
                    <button id="add-tracked-name" class="add-name-button">添加</button>
                `);
            }

            $(document).off('click', '#add-tracked-name').on('click', '#add-tracked-name', () => {
                const newName = $('#new-tracked-name').val().trim();
                const newGender = $('#new-tracked-gender').val();
                const newIntimacy = parseInt($('#new-tracked-intimacy').val()) || 0;
                if (newName) {
                    this.addTrackedName(newName, newIntimacy, newGender);
                    $('#new-tracked-name').val('');
                    $('#new-tracked-gender').val('unknown');
                    $('#new-tracked-intimacy').val(0);
                }
            });

            $(document).off('click', '.edit-name').on('click', '.edit-name', (e) => {
                const name = $(e.currentTarget).data('name');
                const currentIntimacy = $(e.currentTarget).data('intimacy');
                const currentGender = $(e.currentTarget).data('gender');

                this.uiManager.showEditNameDialog(name, currentIntimacy, currentGender, async (name, newIntimacy, newGender) => {
                    await this.updateTrackedNameIntimacy(name, newIntimacy, newGender);
                });
            });

            $(document).off('click', '.remove-name').on('click', '.remove-name', (e) => {
                const name = $(e.currentTarget).data('name');
                this.removeTrackedName(name);
            });
        } catch (error) {
        }
    }

    async updateTrackedNameIntimacy(name, initialIntimacy, gender) {
        const stats = await this.dataManager.loadStats();
        if (stats.relationships[name]) {
            stats.relationships[name].initialIntimacy = initialIntimacy;
            stats.relationships[name].gender = gender;

            await this.dataManager.saveStats(stats);

            $(`.edit-name[data-name="${name}"]`)
                .data('intimacy', initialIntimacy)
                .data('gender', gender);

            const genderIcon = gender === 'male' ? '♂' : gender === 'female' ? '♀' : '?';
            $(`.tracked-name-item:has(.edit-name[data-name="${name}"]) .gender-indicator`).text(genderIcon);
            $(`.tracked-name-item:has(.edit-name[data-name="${name}"]) .initial-intimacy-value`).text(`⭐ ${initialIntimacy}`);

            this.executeCommand(`/echo 已更新"${name}"的初始好感度: ${initialIntimacy}, 性别: ${gender === 'male' ? '男性' : gender === 'female' ? '女性' : '未知'}`);
        }
    }

    async addTrackedName(name, initialIntimacy = 0, gender = 'unknown') {
        if (!name) return;

        initialIntimacy = Math.max(-100, initialIntimacy);

        const stats = await this.dataManager.loadStats();
        if (!stats.relationships[name]) {
            stats.relationships[name] = {
                intimacyLevel: initialIntimacy,
                stage: this.relationshipManager.getRelationshipStage(initialIntimacy),
                interactions: 0,
                initialIntimacy: initialIntimacy,
                gender: gender
            };

            await this.dataManager.saveStats(stats);

            const genderIcon = gender === 'male' ? '♂' : gender === 'female' ? '♀' : '?';

            const nameItem = $(`
                <div class="tracked-name-item template-mode">
                    <span class="tracked-name">${name}</span>
                    <span class="gender-indicator" title="性别">${genderIcon}</span>
                    <div class="tracked-name-stats">
                        <span class="initial-intimacy-value" title="初始好感度">⭐ ${initialIntimacy}</span>
                    </div>
                    <div class="tracked-name-actions">
                        <button class="edit-name" data-name="${name}" data-intimacy="${initialIntimacy}" data-gender="${gender}">✏️</button>
                        <button class="remove-name" data-name="${name}">×</button>
                    </div>
                </div>`);
            $('#tracked-names-list').append(nameItem);

            this.executeCommand(`/echo 已添加"${name}"，性别：${gender === 'male' ? '男性' : gender === 'female' ? '女性' : '未知'}，初始好感度：${initialIntimacy}`);

            if (this.settings.memoryInjectEnabled) {
                this.updateMemoryPrompt();
            }
        } else {
            this.executeCommand(`/echo "${name}"已存在于追踪列表中`);
        }
    }

    async removeTrackedName(name) {
        const stats = await this.dataManager.loadStats();
        if (stats.relationships[name]) {
            delete stats.relationships[name];
            await this.dataManager.saveStats(stats);

            $(`.tracked-name-item:has(.remove-name[data-name="${name}"])`).remove();

            if (this.settings.memoryInjectEnabled) {
                this.updateMemoryPrompt();
            }
        }
    }

    async saveRelationshipSettingsToCharacter(creatorMode = true) {
        if (!this_chid || !characters[this_chid]) {
            this.executeCommand('/echo 请先选择一个角色');
            return false;
        }

        try {
            const currentStats = await this.dataManager.loadStats();
            const trackedRelationships = {};

            Object.entries(currentStats.relationships || {}).forEach(([name, data]) => {
                trackedRelationships[name] = {
                    initialIntimacy: data.initialIntimacy !== undefined ? data.initialIntimacy : data.intimacyLevel,
                    gender: data.gender || 'unknown'
                };
            });

            const behaviorSettings = this.getCurrentCharacterGuidelines();

            const success = await this.dataManager.saveRelationshipSettingsToCharacter(
                this.MODULE_NAME,
                behaviorSettings,
                trackedRelationships,
                {
                    memoryEnabled: this.settings.memoryEnabled,
                    memoryInjectEnabled: this.settings.memoryInjectEnabled,
                    memoryInjectDepth: this.settings.memoryInjectDepth
                }
            );

            if (success) {
                this.characterSettings.set(this_chid, structuredClone(behaviorSettings));
                this.executeCommand(`/echo 行为模板已绑定到角色卡 "${characters[this_chid].name}"`);
            } else {
                this.executeCommand('/echo 绑定失败，请重试');
            }

            return success;
        } catch (error) {
            this.executeCommand('/echo 绑定失败，请重试');
            return false;
        }
    }

    async checkEmbeddedRelationshipSettings() {
        if (!this_chid || !characters[this_chid] || !this.isGloballyEnabled()) return;

        const savedData = await this.dataManager.loadRelationshipSettingsFromCharacter();
        if (!savedData) return;

        const avatar = characters[this_chid]?.avatar;
        const checkKey = `RelationshipSettings_${avatar}`;

        if (!accountStorage.getItem(checkKey)) {
            accountStorage.setItem(checkKey, 'true');

            try {
                const shouldLoad = await this.showCharacterDataImportDialog(savedData);
                if (!shouldLoad) return;

                extension_settings[this.EXT_ID].relationshipGuidelines = savedData.relationshipGuidelines;

                if (savedData.settings) {
                    this.settings.memoryEnabled = savedData.settings.memoryEnabled ?? this.settings.memoryEnabled;
                    this.settings.memoryInjectEnabled = savedData.settings.memoryInjectEnabled ?? this.settings.memoryInjectEnabled;
                    this.settings.memoryInjectDepth = savedData.settings.memoryInjectDepth ?? this.settings.memoryInjectDepth;
                    this.settings.userGender = savedData.settings.userGender ?? this.settings.userGender;
                    this.settings.userAliases = savedData.settings.userAliases ?? this.settings.userAliases;

                    this.textAnalysis.updateUserSettings({
                        gender: this.settings.userGender,
                        aliases: this.settings.userAliases
                    });
                }

                let currentStats = await this.dataManager.loadStats();
                if (!currentStats || currentStats === "undefined") {
                    const newStats = this.dataManager.createEmptyStats();

                    if (savedData.trackedRelationships) {
                        Object.entries(savedData.trackedRelationships).forEach(([name, data]) => {
                            const initialIntimacy = data.initialIntimacy !== undefined ? data.initialIntimacy : 0;
                            const gender = data.gender || 'unknown';
                            newStats.relationships[name] = {
                                intimacyLevel: initialIntimacy,
                                stage: this.relationshipManager.getRelationshipStage(initialIntimacy),
                                interactions: 0,
                                initialIntimacy: initialIntimacy,
                                gender: gender
                            };
                        });
                    }

                    await this.dataManager.saveStats(newStats);
                }

                saveSettingsDebounced();

                const trackedNames = savedData.trackedRelationships ?
                    Object.keys(savedData.trackedRelationships) :
                    [];

                const message = `已加载角色卡中的行为设定配置\n追踪人物：${trackedNames.join(', ')}\n版本：${savedData.version || '1.0'}`;
                this.executeCommand(`/echo ${message}`);

                if (this.settings.memoryInjectEnabled) {
                    this.updateMemoryPrompt();
                }

                await this.handleCharacterSwitch();
            } catch (error) {
            }
        }
    }

    async checkEmbeddedRelationshipSettingsAuto() {
        if (!this_chid || !characters[this_chid] || !this.isGloballyEnabled()) return false;

        const character = characters[this_chid];
        const savedData = await this.dataManager.loadRelationshipSettingsFromCharacter();
        if (!savedData) return false;

        const checkKey = `RelationshipSettings_${character.avatar}`;
        if (accountStorage.getItem(checkKey)) return false;

        try {
            accountStorage.setItem(checkKey, 'true');
            extension_settings[this.EXT_ID].relationshipGuidelines = savedData.relationshipGuidelines;

            if (savedData.settings) {
                this.settings.memoryEnabled = savedData.settings.memoryEnabled ?? this.settings.memoryEnabled;
                this.settings.memoryInjectEnabled = savedData.settings.memoryInjectEnabled ?? this.settings.memoryInjectEnabled;
                this.settings.memoryInjectDepth = savedData.settings.memoryInjectDepth ?? this.settings.memoryInjectDepth;
                this.settings.userGender = savedData.settings.userGender ?? this.settings.userGender;
                this.settings.userAliases = savedData.settings.userAliases ?? this.settings.userAliases;

                this.textAnalysis.updateUserSettings({
                    gender: this.settings.userGender,
                    aliases: this.settings.userAliases
                });
            }

            let currentStats = await this.dataManager.loadStats();
            if (!currentStats || currentStats === "undefined") {
                const newStats = this.dataManager.createEmptyStats();

                if (savedData.trackedRelationships) {
                    Object.entries(savedData.trackedRelationships).forEach(([name, data]) => {
                        const initialIntimacy = data.initialIntimacy !== undefined ? data.initialIntimacy : 0;
                        const gender = data.gender || 'unknown';
                        newStats.relationships[name] = {
                            intimacyLevel: initialIntimacy,
                            stage: this.relationshipManager.getRelationshipStage(initialIntimacy),
                            interactions: 0,
                            initialIntimacy: initialIntimacy,
                            gender: gender
                        };
                    });
                }

                await this.dataManager.saveStats(newStats);
            }

            saveSettingsDebounced();

            const trackedNames = savedData.trackedRelationships ?
                Object.keys(savedData.trackedRelationships) :
                [];

            const message = `🎉 自动导入成功！\n角色：${character.name}\n关系阶段：${Object.keys(savedData.relationshipGuidelines).length}个\n追踪人物：${trackedNames.join(', ') || '无'}\n版本：${savedData.version || '1.0'}`;

            this.executeCommand(`/echo ${message}`);

            if (this.settings.memoryInjectEnabled) {
                this.updateMemoryPrompt();
            }

            return true;

        } catch (error) {
            accountStorage.removeItem(checkKey);
            return false;
        }
    }

    async showCharacterDataImportDialog(savedData) {
        return new Promise((resolve) => {
            const trackedNames = savedData.trackedRelationships ?
                Object.keys(savedData.trackedRelationships) :
                [];

            const message = `
                <div style="text-align: left;">
                    <h3>🎭 发现角色卡中的行为设定数据</h3>
                    <p>此角色卡包含以下数据：</p>
                    <ul>
                        <li><strong>版本：</strong>${savedData.version || '1.0'}</li>
                        <li><strong>最后更新：</strong>${savedData.lastUpdated ? new Date(savedData.lastUpdated).toLocaleString() : '未知'}</li>
                        <li><strong>追踪人物：</strong>${trackedNames.length > 0 ? trackedNames.join(', ') : '无'}</li>
                        ${savedData.creatorMode ? '<li><strong>模式：</strong>创作者模式</li>' : ''}
                    </ul>
                    <p><strong>是否要加载这些设定？</strong></p>
                    <p style="color: #888; font-size: 0.9em;">这将覆盖当前的行为设定。</p>
                </div>`;

            this.showConfirmDialog(message, () => resolve(true), () => resolve(false));
        });
    }

    showConfirmDialog(message, onConfirm, onCancel) {
        this.uiManager.showConfirmDialog(message, onConfirm, onCancel);
    }
}

const statsTracker = new StatsTracker();
export { statsTracker };
