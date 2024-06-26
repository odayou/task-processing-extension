import { Editor, Plugin, Notice, Menu, MenuItem } from 'obsidian';

interface TimeSaverPluginSettings {
	autoCompute: string;
}

const DEFAULT_SETTINGS: TimeSaverPluginSettings = {
	autoCompute: 'default'
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
	let notice = "### 时间花费统计\n---\n";
	// const file = this.app.workspace.getActiveFile();

	const data = editor.getValue();
	let allSum = 0;
	// @ts-ignore
	data.split("\n").forEach((row: {
		match: (arg0: RegExp) => null;
		replaceAll: (arg0: RegExp, arg1: string) => any;
	}) => {
		if (row.match(taskExp) == null) {
			return;
		}
		const extractedWithoutCodeblocks = row.replaceAll(taskExp, "");
		const [taskName, totalSumInMinutes] = computeTaskTime(extractedWithoutCodeblocks)
		allSum += isNaN(totalSumInMinutes) ? 0 : totalSumInMinutes;
		notice += `${taskName}: ${minutesToHours(totalSumInMinutes)}小时\n`;
	})
	notice += `\n\n---\n花费总时长:${minutesToHours(allSum)}小时\n\n最后统计时间: ${new Date().toLocaleString()}\n\n---\n`;
	editor.replaceRange(notice, editor.getCursor());
}
const taskExp = /\s*(-|\*)\s+\[(\s|\w)\]\s+/g

export default class TimeSaverPlugin extends Plugin {

	settings: TimeSaverPluginSettings;
	async onload() {

		/**
		 * 注册编辑器右键监听事件
		 */
		this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, view) => {
			addContextMenu(menu, editor);
		}));
		this.addCommand({
			id: "compute-total-time",
			name: "Coumpute total time",
			editorCallback: (editor: Editor) => {
				computeTotalTime(editor);
			}
		});

		this.addCommand({
			id: "copy-url-and-txt",
			name: "Copy markdown link info",
			editorCallback: (editor: Editor) => {
				copyMarkDownLinkTextAndInfo(editor)
			}
		});

		this.addCommand({
			id: "insert-task-not-finished",
			name: "Insert unFinished task",
			editorCallback: (editor) => {
				insertTaskNotFinished(editor);
			}
		});

		this.addCommand({
			id: "insert-task-finished",
			name: "Insert finished task",
			editorCallback: (editor) => {
				insertTaskFinished(editor);
			}
		});

		this.addCommand({
			id: "insert-clock-time",
			name: "Insert the current clock time",
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

function computeTaskTime(taskEventData: string) : any[] {
	const data = taskEventData.split(" ");
	const taskName = data[0];
	let totalSumInMinutes = 0;
	data.forEach((item, index) => {
		if (index === 0) {
			return;
		}
		const clocks = item.split("-");
		if (clocks.length != 2) {
			return;
		}
		const diffInMinutes = clockDiffMinutes(clocks[0], clocks[1]);
		totalSumInMinutes += isNaN(diffInMinutes) ? 0 : diffInMinutes;
	})
	return [taskName, totalSumInMinutes]
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
			menuItem.setTitle("复制markdown链接");
			menuItem.setIcon("copy");
			menuItem.onClick(() => {
				copyMarkDownLinkTextAndInfoFromText(markdownLinkFromActiveText)
			});
		});
	}
	menu.addItem((menuItem) => {
		menuItem.setTitle("插入待办");
		menuItem.setIcon("square");
		menuItem.onClick(() => {
			insertTaskNotFinished(editor)
		});
	});
	menu.addItem((menuItem) => {
		menuItem.setTitle("插入已办");
		menuItem.setIcon("check-square");
		menuItem.onClick(() => {
			insertTaskFinished(editor)
		});
	});

	menu.addItem((menuItem) => {
		menuItem.setTitle("计算时间花费");
		menuItem.setIcon("calculator");
		menuItem.onClick(() => {
			computeTotalTime(editor)
		});
	});
	menu.addItem((menuItem) => {
		menuItem.setTitle("插入当前时刻");
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
		new Notice("没有markdown链接");
		return null;
	}

	// 复制markdown链接中的文本和url到剪切板
	let promise = navigator.clipboard.writeText(linkInfo.text + " " + linkInfo.url);
	promise.then(
		() => {
			new Notice("已复制到剪切板");
		},
		() => {
			new Notice("复制到剪切板失败");
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
