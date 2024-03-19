import { Editor, Plugin } from 'obsidian';

// Remember to rename these classes and interfaces!

interface MyPluginSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: 'default'
}

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	async onload() {
		const taskExp = /\s*(-|\*)\s+\[(\s|\w)\]\s+/g
		this.addCommand({
			id: "compute-total-time",
			name: "Coumpute total time",
			editorCallback: (editor: Editor) => {

				let notice = "### 时间花费统计\n---\n";
				// const file = this.app.workspace.getActiveFile();

				const data = editor.getValue();
				let allSum = 0;
				data.split("\n").forEach((row: { match: (arg0: RegExp) => null; replaceAll: (arg0: RegExp, arg1: string) => any; }) => {
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
		});

		this.addCommand({
			id: "insert-task-not-finished",
			name: "Insert unFinished task",
			editorCallback: (editor) => {
				editor.replaceSelection("- [ ] ");
			}
		});

		this.addCommand({
			id: "insert-task-finished",
			name: "Insert finished task",
			editorCallback: (editor) => {
				editor.replaceSelection("- [x] ");
			}
		});

		this.addCommand({
			id: "insert-clock-time",
			name: "Insert the current clock time",
			editorCallback: (editor) => {
				const date = new Date();
				// const year = date.getFullYear();  
				// const month = (date.getMonth() + 1).toString().padStart(2, '0');  
				// const day = date.getDate().toString().padStart(2, '0');
				const hour = date.getHours().toString().padStart(2, '0');
				const minute = date.getMinutes().toString().padStart(2, '0');
				editor.replaceSelection(`${hour}:${minute}`);
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
