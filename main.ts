import { Editor, Plugin, Notice, Menu, MenuItem, App, PluginSettingTab, Setting } from 'obsidian';
import en from './locales/en.json';
import zh_CN from './locales/zh_CN.json';

const languages = {
    en,
    zh_CN
};
type LanguageKey = keyof typeof languages;

let currentLanguage = getInitialLanguage({} as TimeSaverPluginSettings); // 默认语言

interface TimeSaverPluginSettings {
	autoCompute: string;
	language: string; // 新增语言设置
}

const DEFAULT_SETTINGS: TimeSaverPluginSettings = {
	autoCompute: 'disabled',
	language: getInitialLanguage({} as TimeSaverPluginSettings),
}

async function loadLanguage(lang: string) {
    currentLanguage = lang;
    // 加载对应的语言资源
    return languages[lang];
}

async function changeLanguage(lang: string) {
	await loadLanguage(lang);
	// 更新界面，重新渲染菜单等
	this.app.workspace.trigger('app-menu-rebuild');
}

// 获取多语言文本languages[currentLanguage]
function lang(key: string) {
	return languages[currentLanguage as LanguageKey][key] || key;
}

function insertTaskNotFinished(editor: Editor) {
	editor.replaceSelection("- [ ] ");
}

function insertTaskFinished(editor: Editor) {
	editor.replaceSelection("- [x] ");
}

function insertClockTime(editor: Editor) {
	const date = new Date();
	// const year = date.getFullYear();
	// const month = (date.getMonth() + 1).toString().padStart(2, '0');
	// const day = date.getDate().toString().padStart(2, '0');
	const hour = date.getHours().toString().padStart(2, '0');
	const minute = date.getMinutes().toString().padStart(2, '0');
	editor.replaceSelection(`${hour}:${minute}`);
}

function computeTotalTime(editor: Editor) {
	let notice = `### ${lang("timeSpentAnalysis")}\n---\n`;
    const data = editor.getValue();
    let allSum = 0;
    
    data.split("\n").forEach((row: any) => {
        // 提取缩进（匹配行首的空白字符）
        const indent = row.match(/^(\s*)/)[0] || '';
        
        if (row.match(taskExp) == null) return;

        const extracted = row.replaceAll(taskExp, "");
        const [taskName, totalSum] = computeTaskTime(extracted);
        
        allSum += isNaN(totalSum) ? 0 : totalSum;
        notice += `${indent}${taskName}: ${formatMinutes(totalSum)}\n`; // 保留缩进
    });

    notice += `\n---\n${lang("totalTime")}: ${formatMinutes(allSum)}\n${lang("lastComputeTime")}: ${new Date().toLocaleString()}\n\n---\n`;
    editor.replaceRange(notice, editor.getCursor());
}
const taskExp = /\s*(-|\*)\s+\[(\s|\w)\]\s+/g
const timePattern = /\b(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})\b/g;

class TimeSaverSettingTab extends PluginSettingTab {
    plugin: TimeSaverPlugin;

    constructor(app: App, plugin: TimeSaverPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        // 添加语言设置
        new Setting(containerEl)
            .setName('Language')
            .setDesc('Select the plugin language')
            .addDropdown((dropdown) => {
                dropdown
                    .addOption('en', 'English')
                    .addOption('zh_CN', '中文')
                    .setValue(this.plugin.settings.language)
                    .onChange(async (value) => {
                        this.plugin.settings.language = value;
                        await this.plugin.saveSettings();
                        await changeLanguage(value);
                    });
            });

        // 添加自动计算设置
        new Setting(containerEl)
            .setName('Auto Compute')
            .setDesc('Enable or disable auto computation of task times')
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.settings.autoCompute === 'enabled')
                    .onChange(async (value) => {
                        this.plugin.settings.autoCompute = value ? 'enabled' : 'disabled';
                        await this.plugin.saveSettings();
                    });
            });
    }
}
export default class TimeSaverPlugin extends Plugin {

	settings: TimeSaverPluginSettings;
	async onload() {

		await this.loadSettings();
		// 注册设置页面
		this.addSettingTab(new TimeSaverSettingTab(this.app, this));
        await changeLanguage(this.settings.language || 'en'); // 根据设置加载语言

		/**
		 * 注册编辑器右键监听事件
		 */
		this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, view) => {
			addContextMenu(menu, editor);
		}));
		this.addCommand({
			id: "compute-total-time",
			name: lang("computeTotalTime"),
			editorCallback: (editor: Editor) => {
				computeTotalTime(editor);
			}
		});

		this.addCommand({
			id: "copy-url-and-txt",
			name: lang("copyMarkdownLinkInfo"),
			editorCallback: (editor: Editor) => {
				copyMarkDownLinkTextAndInfo(editor)
			}
		});

		this.addCommand({
			id: "insert-task-not-finished",
			name: lang("insertTaskNotFinished"),
			editorCallback: (editor) => {
				insertTaskNotFinished(editor);
			}
		});

		this.addCommand({
			id: "insert-task-finished",
			name: lang("insertTaskFinished"),
			editorCallback: (editor) => {
				insertTaskFinished(editor);
			}
		});

		this.addCommand({
			id: "insert-clock-time",
			name: lang("insertClockTime"),
			editorCallback: (editor) => {
				insertClockTime(editor);
			}
		});
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

}

function getInitialLanguage(pluginSettings: TimeSaverPluginSettings): string {
    // 优先级 1: 插件设置
    if (pluginSettings.language) {
        return pluginSettings.language;
    }

    // 优先级 2: Obsidian 设置
    const obsidianLanguage = (app as any).vault.config?.locale;
    const lang = obsidianLanguage || navigator.language || 'en';
	return lang.startsWith('zh') ? 'zh_CN' : 'en';
}

function computeTaskTime(taskEventData: string) : any[] {
	// 提取所有时间段（兼容前后位置）
    const timeSlots = [];
    let match;
    while ((match = timePattern.exec(taskEventData)) !== null) {
        timeSlots.push(match[0]);
    }

    // 提取任务名称（排除时间部分）
    const taskName = taskEventData.replace(timePattern, '').trim();
    
    // 时间计算逻辑
    let totalSumInMinutes = 0;
    timeSlots.forEach(item => {
        const clocks = item.split("-");
        const diff = clockDiffMinutes(clocks[0], clocks[1]);
        totalSumInMinutes += isNaN(diff) ? 0 : diff;
    });
    
    return [taskName, totalSumInMinutes];
}

function formatMinutes(minutes: number): string {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m (${minutesToHours(minutes)} ${lang('hours')})`;
}

function clockToTime(clockString: string): Date {
	const now = new Date();
	const [hours, minutes] = clockString.split(":");
	return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(hours), Number(minutes));
}

function clockDiffMinutes(before: string, after: string) {
	// 计算 "10:25"， "12:25" 这种时间相差多少小时，精确到小数点后1位数， 如果字符串中没有日期，则默认日期为当天，有日期则按照日期计算
	const befeoreTime = clockToTime(before);
	const afterTime = clockToTime(after);
	const diff = afterTime.getTime() - befeoreTime.getTime();
	const diffInMinutes = Math.round(diff / 1000 / 60);
	return diffInMinutes;
}

function minutesToHours(minutes: number, toFixed = 2) {
	// 分钟数转换为小时数，精确到小数点后两位
	const diffInHours = (minutes / 60).toFixed(toFixed);
	return diffInHours;
}

function isMarkdownUrl(str: String) {
	return str.match(/!\[[^\]]*\]\(([^)]+)\)/) == null
}

function getMarkdownUrlInfo(str: String) {
	/// 定义正则表达式
	const regex = /\[([^\]]+)\]\(([^)]+)\)/;

// 使用正则表达式匹配
	const match = str.match(regex);
	if (match) {
		const text = match[1]; // 获取链接文本
		const url = match[2]; // 获取链接 URL

		return {
			url,
			text
		}
	} else {
		return {
			url: '',
			text: ''
		}
	}
}

function isMouseHoverOnMarkdownLink(line: string, cursorPosition: number): boolean {
	const linkRegex = /\[.*?\]\((.*?)\)/g;
	let match;

	while ((match = linkRegex.exec(line)) !== null) {
		if (match.index <= cursorPosition && cursorPosition <= match.index + match[0].length) {
			return true;
		}
	}

	return false;
}

/**
 * 获取当前光标下的markdown链接
 * @param line
 * @param cursorPosition
 */
function getMarkdownLink(line: string, cursorPosition: number): string | null {
	const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
	let match;

	while ((match = linkRegex.exec(line)) !== null) {
		if (match.index <= cursorPosition && cursorPosition <= match.index + match[0].length) {
			return match[0]; // 返回整个Markdown链接部分
		}
	}

	return null; // 如果光标不在Markdown链接内，则返回null
}

/**
 * Add context menu for markdown link.
 * @param menu
 * @param editor
 */
function addContextMenu(menu: Menu, editor: Editor) {
	const markdownLinkFromActiveText = getMarkdownLinkFromCursorPoint(editor);
	if (markdownLinkFromActiveText) {
		menu.addItem((menuItem) => {
			menuItem.setTitle(lang("copyMarkdownLinkInfo"));
			menuItem.setIcon("copy");
			menuItem.onClick(() => {
				copyMarkDownLinkTextAndInfoFromText(markdownLinkFromActiveText)
			});
		});
	}
	menu.addItem((menuItem) => {
		menuItem.setTitle(lang("insertTaskNotFinished"));
		menuItem.setIcon("square");
		menuItem.onClick(() => {
			insertTaskNotFinished(editor)
		});
	});
	menu.addItem((menuItem) => {
		menuItem.setTitle(lang("insertTaskFinished"));
		menuItem.setIcon("check-square");
		menuItem.onClick(() => {
			insertTaskFinished(editor)
		});
	});

	menu.addItem((menuItem) => {
		menuItem.setTitle(lang("computeTotalTime"));
		menuItem.setIcon("calculator");
		menuItem.onClick(() => {
			computeTotalTime(editor)
		});
	});
	menu.addItem((menuItem) => {
		menuItem.setTitle(lang("insertClockTime"));
		menuItem.setIcon("timer");
		menuItem.onClick(() => {
			insertClockTime(editor)
		});
	});
}

/**
 * 从文本中复制markdown链接的文本和url到剪切板
 * @param editor
 */
function copyMarkDownLinkTextAndInfo(editor: Editor) {
	const markdownLinkFromActiveText= getMarkdownLinkFromCursorPoint(editor);

	copyMarkDownLinkTextAndInfoFromText(markdownLinkFromActiveText)
}

/**
 * 从文本中复制markdown链接的文本和url到剪切板
 * @param linkInfo
 */
function copyMarkDownLinkTextAndInfoFromText(linkInfo: any) {
	if (linkInfo == null) {
		// new Notice("没有markdown链接");
		new Notice(lang("noMarkdownLink"));
		return null;
	}

	// 复制markdown链接中的文本和url到剪切板
	let promise = navigator.clipboard.writeText(linkInfo.text + " " + linkInfo.url);
	promise.then(
		() => {
			new Notice(lang("copySuccess"));
		},
		() => {
			new Notice(lang("copyFailed"));
		}
	)
}

/**
 * 从光标位置获取markdown链接信息
 * @param editor
 */
function getMarkdownLinkFromCursorPoint(editor: Editor) {
	const cursor = editor.getCursor();
	const line = editor.getLine(cursor.line);

	const markdownLink = getMarkdownLink(line, cursor.ch);
	if (markdownLink == null) {
		// new Notice("没有markdown链接");
		return null;
	}

	// 复制markdown链接中的文本和url到剪切板
	return getMarkdownUrlInfo(markdownLink);
}
