import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';

export const VIEW_TYPE_TIMESAVER_STATS = 'time-saver-stats-view';

export interface StatsResult {
	mode: 'current' | 'all' | 'daily';
	totalMinutes: number;
	byTag: Record<string, number>;
	lines: string[];
	notesWithTasks: number;
	lastComputeTime: string;
	sourceFile?: string;
	byDate?: { date: string; minutes: number; byTag: Record<string, number> }[];
}

let i18n: (k: string) => string = (k) => k;
export function setPanelI18n(fn: (k: string) => string) {
	i18n = fn;
}

export interface PanelActions {
	computeCurrent: () => void;
	computeAll: () => void;
	computeDaily: () => void;
	exportToNote: () => void;
	removeStats?: () => void;
}

let panelActions: PanelActions | null = null;
export function setPanelActions(a: PanelActions) {
	panelActions = a;
}

function fmtReport(min: number): string {
	const h = Math.floor(min / 60);
	const m = min % 60;
	return `${h}h ${m}m`;
}

export class StatsPanelView extends ItemView {
	data: StatsResult | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType() {
		return VIEW_TYPE_TIMESAVER_STATS;
	}

	getDisplayText() {
		return 'TimeSaver';
	}

	getIcon() {
		return 'bar-chart-2';
	}

	setData(d: StatsResult) {
		this.data = d;
		this.render();
	}

	async onOpen() {
		this.render();
	}

	async onClose() {
		// nothing to clean up
	}

	render() {
		const c = this.contentEl;
		c.empty();
		c.addClass('ts-panel');

		const header = c.createDiv({ cls: 'ts-header' });
		header.createEl('span', { text: i18n('panelTitle'), cls: 'ts-title' });

		if (!this.data) {
			c.createEl('p', { text: i18n('panelEmpty'), cls: 'ts-empty' });
			const emptyBar = c.createDiv({ cls: 'ts-actions' });
			const mkEmpty = (label: string, cb: () => void) => {
				const b = emptyBar.createEl('button', { text: label, cls: 'mod-cta' });
				b.addEventListener('click', cb);
				return b;
			};
			mkEmpty(i18n('computeCurrentShort'), () => panelActions?.computeCurrent());
			mkEmpty(i18n('computeDailyShort'), () => panelActions?.computeDaily());
			mkEmpty(i18n('computeAllShort'), () => panelActions?.computeAll());
			return;
		}

		const d = this.data;

		// 数据来源标示：current 显示具体文件名，all/daily 显示聚合范围，避免与聚焦文件错位
		const source = c.createDiv({ cls: 'ts-source' });
		if (d.mode === 'current') {
			source.createEl('span', { text: '📄', cls: 'ts-source-icon' });
			source.createEl('span', { text: d.sourceFile || i18n('sourceUnknown'), cls: 'ts-source-name' });
		} else if (d.mode === 'daily') {
			source.createEl('span', { text: i18n('aggregateDailyNotes'), cls: 'ts-source-name' });
		} else {
			source.createEl('span', { text: i18n('allNotes'), cls: 'ts-source-name' });
		}

		// 总览卡片
		const summary = c.createDiv({ cls: 'ts-summary' });
		if (d.mode === 'daily') {
			summary.createEl('div', { text: fmtReport(d.totalMinutes), cls: 'ts-total' });
			summary.createEl('div', { text: `${i18n('notesCount')}: ${d.notesWithTasks}`, cls: 'ts-meta' });
			summary.createEl('div', { text: i18n('dailyNotesOnly'), cls: 'ts-hint' });
		} else if (d.mode === 'all') {
			summary.createEl('div', { text: i18n('crossNoteStats'), cls: 'ts-total' });
			summary.createEl('div', { text: `${i18n('notesCount')}: ${d.notesWithTasks}`, cls: 'ts-meta' });
		} else {
			summary.createEl('div', { text: fmtReport(d.totalMinutes), cls: 'ts-total' });
			summary.createEl('div', { text: `${i18n('notesCount')}: ${d.notesWithTasks}`, cls: 'ts-meta' });
		}

		// 按日期（daily 模式）
		if (d.mode === 'daily' && (d.byDate || []).length > 0) {
			const sec = c.createDiv({ cls: 'ts-section' });
			sec.createEl('div', { text: i18n('byDate'), cls: 'ts-section-title' });
			const ul = sec.createEl('ul', { cls: 'ts-list' });
			(d.byDate || []).forEach((g) => {
				const li = ul.createEl('li', { cls: 'ts-list-item' });
				li.createEl('span', { text: `${g.date} · ${fmtReport(g.minutes)}`, cls: 'ts-date' });
				const tags = Object.entries(g.byTag)
					.sort((a, b) => b[1] - a[1])
					.map(([t, v]) => `#${t} ${fmtReport(v)}`)
					.join(', ');
				if (tags) li.createEl('span', { text: tags, cls: 'ts-date-tags' });
			});
		}

		// 按任务明细
		if (d.lines.length > 0) {
			const sec = c.createDiv({ cls: 'ts-section' });
			sec.createEl('div', { text: i18n('byTask'), cls: 'ts-section-title' });
			const ul = sec.createEl('ul', { cls: 'ts-list' });
			d.lines.forEach((ln) => {
				ul.createEl('li', { text: ln.trim(), cls: 'ts-list-item ts-line' });
			});
		}

		// 按标签
		if (d.mode !== 'daily' && Object.keys(d.byTag).length > 0) {
			const sec = c.createDiv({ cls: 'ts-section' });
			sec.createEl('div', { text: i18n('byTag'), cls: 'ts-section-title' });
			const tagsEl = sec.createEl('div', { cls: 'ts-tags' });
			Object.entries(d.byTag)
				.sort((a, b) => b[1] - a[1])
				.forEach(([t, v]) => {
					tagsEl.createEl('span', { text: `#${t} ${fmtReport(v)}`, cls: 'ts-tag' });
				});
		}

		// 最后统计时间
		c.createEl('div', { text: `${i18n('lastComputeTime')}: ${d.lastComputeTime}`, cls: 'ts-footer' });

		// 操作按钮
		const bar = c.createDiv({ cls: 'ts-actions' });
		const mkBtn = (label: string, cb: () => void, variant?: 'warning') => {
			const b = bar.createEl('button', { text: label, cls: 'mod-cta' });
			if (variant === 'warning') { b.removeClass('mod-cta'); b.addClass('mod-warning'); }
			b.addEventListener('click', cb);
			return b;
		};
		mkBtn(i18n('refreshPanel'), () => {
			if (d.mode === 'daily') panelActions?.computeDaily();
			else if (d.mode === 'all') panelActions?.computeAll();
			else panelActions?.computeCurrent();
		});
		mkBtn(i18n('copyAll'), () => this.copyAll());
		mkBtn(i18n('exportStatsToNote'), () => panelActions?.exportToNote());
		mkBtn(i18n('removeStatsFromNote'), () => panelActions?.removeStats?.(), 'warning');
	}

	buildReport(): string {
		if (!this.data) return '';
		return buildStatsReport(this.data, i18n);
	}

	async copyAll() {
		const text = this.buildReport();
		try {
			await navigator.clipboard.writeText(text);
			new Notice(i18n('copySuccess'));
		} catch {
			new Notice(i18n('copyFail'));
		}
	}
}

// 由 StatsResult 生成可复制的文本报告（面板「复制全部」与状态栏「复制统计结果」共用，保证一致）
export function buildStatsReport(d: StatsResult, t: (k: string) => string): string {
	const lines = [t('panelTitle'), '==='];
	if (d.mode === 'daily') {
		// 跨日期聚合：仅 daily-notes，明确标示范围
		lines.push(t('dailyNotesOnly'));
		lines.push(`${t('totalTimeInCurrentNote')}: ${fmtReport(d.totalMinutes)} · ${t('notesCount')}: ${d.notesWithTasks}`);
		(d.byDate || []).forEach((g) => {
			const tags = Object.entries(g.byTag)
				.sort((a, b) => b[1] - a[1])
				.map(([tag, v]) => `#${tag} ${fmtReport(v)}`)
				.join(', ');
			lines.push(`  ${g.date}: ${fmtReport(g.minutes)}${tags ? ` (${tags})` : ''}`);
		});
	} else if (d.mode === 'all') {
		// 跨笔记只展示分布（笔记数 + 按标签），不展示无日期锚点的「总时长」累加数字
		lines.push(`${t('crossNoteStats')} · ${t('notesCount')}: ${d.notesWithTasks}`);
	} else {
		if (d.sourceFile) lines.push(`${t('sourceFile')}: ${d.sourceFile}`);
		lines.push(`${t('totalTimeInCurrentNote')}: ${fmtReport(d.totalMinutes)}`);
		if (d.lines.length > 0) {
			lines.push(`${t('byTask')}:`);
			d.lines.forEach((ln) => lines.push(`  ${ln.trim()}`));
		}
	}
	if (Object.keys(d.byTag).length > 0) {
		lines.push(
			`${t('byTag')}: ` +
				Object.entries(d.byTag)
					.sort((a, b) => b[1] - a[1])
					.map(([tag, v]) => `#${tag} ${fmtReport(v)}`)
					.join(', ')
		);
	}
	lines.push(`${t('lastComputeTime')}: ${d.lastComputeTime}`);
	return lines.join('\n');
}
