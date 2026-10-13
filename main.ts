import { Editor, Plugin, Notice, Menu, App, PluginSettingTab, Setting, MarkdownView, TFile, Platform, EventRef } from 'obsidian';
import { StatsPanelView, VIEW_TYPE_TIMESAVER_STATS, StatsResult, setPanelI18n, setPanelActions, buildStatsReport } from './src/StatsPanelView';
import en from './locales/en.json';
import zh_CN from './locales/zh_CN.json';
import { createImageResizeExtension, setImageResizeHandleLabels, setImageResizeInset } from './src/imageResize';

const languages = {
    en,
    zh_CN
};
type LanguageKey = keyof typeof languages;

// 持有插件实例，供独立函数读取 settings / app
let pluginRef: TimeSaverPlugin;
let currentLanguage = getInitialLanguage(); // 默认语言
let statusBarEl: HTMLElement | null = null;
let lastStats: StatsResult | null = null;
let lastStatsFile: string | null = null; // lastStats 所属的笔记路径（用于切换聚焦文件时判断是否需要重算）
// 会话内已计算笔记的耗时累计（按文件路径），用于状态栏「全部」与跨笔记增量汇总
const noteTotals = new Map<string, number>();

type Scope = 'all' | 'folder';

interface TimeSaverPluginSettings {
	language: string; // 语言设置
	scope: Scope; // 跨笔记聚合范围：all=所有笔记，folder=指定文件夹
	folder: string; // 指定文件夹路径（仅当 scope=folder 时生效）
	syncToFrontmatter: boolean; // 是否把统计结果写入每条笔记的 YAML frontmatter
	showStatusBar: boolean; // 是否在状态栏显示耗时摘要（当前笔记 + 全部笔记总量）
	showContextMenu: boolean; // 是否在右键菜单显示「统计」类命令（默认关闭，避免冗余）
	enableInsertTask: boolean; // 右键菜单「插入任务」命令开关（默认开）
	enableInsertTime: boolean; // 右键菜单「插入时间」命令开关（默认开）
	enableCopyLink: boolean; // 右键菜单「复制链接」命令开关（默认开）
	panelDefaultOpen: boolean; // 启动时是否自动打开面板
	imageResizeInset: number; // 图片缩放手柄距图片边缘的距离（像素）
}

const DEFAULT_SETTINGS: TimeSaverPluginSettings = {
	language: getInitialLanguage(),
	scope: 'all',
	folder: '',
	syncToFrontmatter: false,
	showStatusBar: true,
	showContextMenu: false,
	enableInsertTask: true,
	enableInsertTime: true,
	enableCopyLink: true,
	panelDefaultOpen: false,
	imageResizeInset: 36,
}

async function loadLanguage(lang: string) {
    currentLanguage = lang;
    // 加载对应的语言资源
    return languages[lang as LanguageKey];
}

async function changeLanguage(language: string, app: App) {
	await loadLanguage(language);
	setImageResizeHandleLabels({
		'top-left': lang("imageResizeHandleTopLeft"),
		'top-right': lang("imageResizeHandleTopRight"),
		'bottom-left': lang("imageResizeHandleBottomLeft"),
		'bottom-right': lang("imageResizeHandleBottomRight")
	});
	// 更新界面，重新渲染菜单等
	app.workspace.trigger('app-menu-rebuild');
}

// 获取多语言文本languages[currentLanguage]
function lang(key: string) {
	const dict = languages[currentLanguage as LanguageKey] as Record<string, string>;
	return dict[key] || key;
}

// 统计区哨兵：包裹在 HTML 注释中，便于原地查找与替换，且不会污染正文渲染
const STATS_START = '<!-- time-saver stats start -->';
const STATS_END = '<!-- time-saver stats end -->';

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 判断某行是否为任务行（独立正则，避免全局正则 lastIndex 副作用）
function isTaskLine(row: string): boolean {
	return /^\s*(-|\*)\s+\[(\s|\w)\]\s+/.test(row);
}

function debounce<TArgs extends unknown[]>(fn: (...args: TArgs) => void, ms: number): (...args: TArgs) => void {
	let timer: number | undefined;
	return (...args: TArgs) => {
		window.clearTimeout(timer);
		timer = window.setTimeout(() => fn(...args), ms);
	};
}

function reportAsyncError(operation: string, error: unknown): void {
	console.error(`[TimeSaver] ${operation} failed`, error);
	const details = error instanceof Error ? error.message : String(error);
	new Notice(lang('operationFailed')
		.replace('{{operation}}', operation)
		.replace('{{error}}', details), 8000);
}

function runAsync(operation: string, task: () => Promise<unknown>): void {
	void task().catch((error: unknown) => reportAsyncError(operation, error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumberRecord(value: unknown): value is Record<string, number> {
	return isRecord(value) && Object.values(value).every((item) => typeof item === 'number');
}

function getTimeSaverFrontmatter(app: App, file: TFile): Record<string, unknown> | null {
	const value: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.['time-saver'];
	return isRecord(value) ? value : null;
}

function insertTaskNotFinished(editor: Editor): void {
	editor.replaceSelection("- [ ] ");
}

function insertTaskFinished(editor: Editor): void {
	editor.replaceSelection("- [x] ");
}

function insertClockTime(editor: Editor): void {
	const date = new Date();
	const hour = date.getHours().toString().padStart(2, '0');
	const minute = date.getMinutes().toString().padStart(2, '0');
	editor.replaceSelection(`${hour}:${minute}`);
}

const taskExp = /\s*(-|\*)\s+\[(\s|\w)\]\s+/g
// 支持多种时刻表达：
//   - 09:00 - 11:30                      （无日期，沿用今天）
//   - 2026-08-28 09:00:00 - 11:30:00     （带日期 + 秒，end 省略日期则继承 start）
//   - 2026/08/28 9:00 - 11:00            （斜杠、无秒）
// 日期支持「西式 - / 」与「中文 年月日」分隔符；日期与时间之间允许 0 个或多个空白（可直连）
// en-dash(–) 与连字符(-) 均可作分隔符
const DATE_PART = '(?:(\\d{4})[-/年](\\d{1,2})[-/月](\\d{1,2})日?\\s*)?';
const TIME_PART = '(\\d{1,2}):(\\d{2})(?::(\\d{2}))?';
const POINT_PART = DATE_PART + TIME_PART;
const timePattern = new RegExp('\\b' + POINT_PART + '\\s*[\\u2013-]\\s*' + POINT_PART + '\\b', 'g');

// 从任务行中提取 #tag（支持中英文与连字符）
function extractTags(row: string): string[] {
    const tags: string[] = [];
    const re = /#([\w\u4e00-\u9fa5-]+)/g;
    let m;
    while ((m = re.exec(row)) !== null) {
        tags.push(m[1]);
    }
    return tags;
}

// 扫描内容：返回总分钟数、按 #tag 聚合、以及按行明细
function scanContent(content: string): { totalMinutes: number; byTag: Record<string, number>; lines: string[] } {
    let totalMinutes = 0;
    const byTag: Record<string, number> = {};
    const lines: string[] = [];
    content.split("\n").forEach((row: string) => {
        const indent = row.match(/^(\s*)/)?.[0] ?? '';
        if (!isTaskLine(row)) return;
        const extracted = row.replaceAll(taskExp, "");
        const [taskName, totalSum] = computeTaskTime(extracted);
        const mins = isNaN(totalSum) ? 0 : totalSum;
        totalMinutes += mins;
        if (mins > 0) {
            lines.push(`${indent}${taskName}: ${formatMinutes(mins)}`);
        }
        extractTags(row).forEach(t => {
            byTag[t] = (byTag[t] || 0) + mins;
        });
    });
    return { totalMinutes, byTag, lines };
}

// 把统计结果写入笔记 YAML frontmatter（供 Dataview / Bases 查询）
async function writeFrontmatter(app: App, file: TFile, totalMinutes: number, byTag: Record<string, number>) {
    await app.fileManager.processFrontMatter(file, (fm) => {
        if (totalMinutes > 0 || Object.keys(byTag).length > 0) {
            fm['time-saver'] = { total_minutes: totalMinutes, by_tag: byTag };
        } else {
            delete fm['time-saver'];
        }
    });
}

// 取一个可用的 Markdown 编辑器：优先活动视图，否则取任意一个已打开的 Markdown leaf
// （解决面板按钮触发时面板成为活动 leaf、getActiveViewOfType 取不到编辑器的问题）
function getMarkdownEditor(app: App): Editor | null {
    const active = app.workspace.getActiveViewOfType(MarkdownView);
    if (active) return active.editor;
    const leaf = app.workspace.getLeavesOfType('markdown')[0];
    if (leaf && leaf.view instanceof MarkdownView) return leaf.view.editor;
    return null;
}

// 当前笔记：计算 → 写面板 + (可选)frontmatter，不再自动插入文档正文
async function computeCurrentNote(editor: Editor, app?: App, silent = false): Promise<void> {
    const { totalMinutes, byTag, lines } = scanContent(editor.getValue());
    lastStats = {
        mode: 'current',
        totalMinutes,
        byTag,
        lines,
        notesWithTasks: totalMinutes > 0 ? 1 : 0,
        lastComputeTime: new Date().toLocaleString(),
        sourceFile: app?.workspace.getActiveFile()?.name
    };
    pushStatsToPanel();
    if (app && pluginRef?.settings.syncToFrontmatter) {
        const file = app.workspace.getActiveFile();
        if (file) await writeFrontmatter(app, file, totalMinutes, byTag);
    }
    if (app) {
        const f = app.workspace.getActiveFile();
        if (f) { noteTotals.set(f.path, totalMinutes); lastStatsFile = f.path; }
    }
    refreshStatusBar();
    if (!silent) new Notice(lang("totalTimeInCurrentNoteIs").replace("{{totalTime}}", formatMinutes(totalMinutes)), 4000);
}

// 计算「当前笔记」：基于当前活动文件，不再依赖具体编辑器/视图模式。
// 内容来源优先级：活动 Markdown 视图的 live editor（含未保存改动）→ 文件缓存 cachedRead。
// 非 Markdown 文件（Canvas/Excalidraw/PDF 等）给出明确提示，不再误报「请打开 Markdown 文件」。
async function computeActiveNote(app: App, silent = false) {
    const file = app.workspace.getActiveFile();
    if (!file) { new Notice(lang("noActiveFile")); return; }
    if (file.extension !== 'md') { new Notice(lang("notMarkdownFile")); return; }
    const mdView = app.workspace.getActiveViewOfType(MarkdownView);
    const content = mdView ? mdView.editor.getValue() : await app.vault.cachedRead(file);
    const { totalMinutes, byTag, lines } = scanContent(content);
    lastStats = {
        mode: 'current',
        totalMinutes,
        byTag,
        lines,
        notesWithTasks: totalMinutes > 0 ? 1 : 0,
        lastComputeTime: new Date().toLocaleString(),
        sourceFile: file.name
    };
    pushStatsToPanel();
    // frontmatter 同步：开启 syncToFrontmatter 时写入，保证 Dataview/Bases 查询实时刷新。
    // 例外：用户经「移除统计」显式 opted-out（frontmatter 标记 disabled:true）后，静默自动计算尊重其意愿、不再写回；
    // 手动触发（silent=false，如点计算/导出）始终写入，即用即恢复。
    if (pluginRef?.settings.syncToFrontmatter) {
        const existing = getTimeSaverFrontmatter(app, file);
        const optedOut = existing?.disabled === true;
        if (!(silent && optedOut)) await writeFrontmatter(app, file, totalMinutes, byTag);
    }
    noteTotals.set(file.path, totalMinutes);
    lastStatsFile = file.path;
    refreshStatusBar();
    if (!silent) new Notice(lang("totalTimeInCurrentNoteIs").replace("{{totalTime}}", formatMinutes(totalMinutes)), 4000);
}

// 显式「导出到笔记」：插入/更新哨兵统计块（原默认行为，现改为手动触发，保留最高可复制性 + 向后兼容）
async function exportStatsToNote(editor: Editor, app?: App): Promise<void> {
    const { totalMinutes, byTag, lines } = scanContent(editor.getValue());
    const body = [
        `### ${lang("timeSpentAnalysis")}`,
        "---",
        ...lines,
        "---",
        `${lang("totalTime")}: ${formatMinutes(totalMinutes)}`,
        `${lang("lastComputeTime")}: ${new Date().toLocaleString()}`,
        "---"
    ].join("\n");

    const block = `${STATS_START}\n${body}\n${STATS_END}`;

    const full = editor.getValue();
    const re = new RegExp(escapeRegex(STATS_START) + "[\\s\\S]*?" + escapeRegex(STATS_END));
    const m = re.exec(full);
    if (m) {
        // 已存在统计区 → 原地替换，避免重复堆叠
        const start = editor.offsetToPos(m.index);
        const end = editor.offsetToPos(m.index + m[0].length);
        editor.replaceRange(block, start, end);
    } else {
        // 首次 → 在光标处插入
        editor.replaceRange("\n" + block + "\n", editor.getCursor());
    }

    if (app && pluginRef?.settings.syncToFrontmatter) {
        const file = app.workspace.getActiveFile();
        if (file) await writeFrontmatter(app, file, totalMinutes, byTag);
    }
    new Notice(lang("exportStatsToNote"), 3000);
}

// 移除本笔记中由本插件写入的「侵入内容」：正文统计块（哨兵注释包裹）+ frontmatter 的 time-saver 字段。
// 不影响用户自己写的任务/时间文本——那些无哨兵包裹，不在此清理范围。
async function removeStatsFromNote(editor: Editor, app?: App) {
    // 1. 删除正文中的统计块（含包裹注释与尾随空行，避免残留空白）
    const full = editor.getValue();
    const re = new RegExp(escapeRegex(STATS_START) + "[\\s\\S]*?" + escapeRegex(STATS_END) + "\\s*");
    const m = re.exec(full);
    if (m) {
        const start = editor.offsetToPos(m.index);
        const end = editor.offsetToPos(m.index + m[0].length);
        editor.replaceRange("", start, end);
    }
    if (app) {
        const file = app.workspace.getActiveFile();
        if (file) {
            // 2. 标记 frontmatter 的 time-saver 为 disabled（而非删除）：作为「用户显式移除」的持久信号，
            //    使静默自动计算（保存/失焦/切换）尊重其意愿、不再把统计写回；手动计算/导出会覆盖此标记、即用即恢复。
            await app.fileManager.processFrontMatter(file, (fm) => { fm['time-saver'] = { disabled: true }; });
            noteTotals.delete(file.path);
        }
        lastStatsFile = null;
        // 3. 重新扫描正文（统计块已删），刷新面板与状态栏（不写回 frontmatter，避免刚删又写回）
        const { totalMinutes, byTag, lines } = scanContent(editor.getValue());
        lastStats = {
            mode: 'current',
            totalMinutes,
            byTag,
            lines,
            notesWithTasks: totalMinutes > 0 ? 1 : 0,
            lastComputeTime: new Date().toLocaleString()
        };
        pushStatsToPanel();
        if (file) noteTotals.set(file.path, totalMinutes);
        refreshStatusBar();
    }
    new Notice(lang("removedFromNote"), 3000);
}

// 跨笔记聚合：重启被拒的 issue #1（跨笔记时间汇总 + Dataview 可查询）
async function computeTotalTimeInAllNotes(app: App) {
    const scope = pluginRef.settings.scope;
    const folder = pluginRef.settings.folder;
    let files = app.vault.getMarkdownFiles();
    if (scope === 'folder' && folder) {
        files = files.filter(f => f.path === folder || f.path.startsWith(folder + '/'));
    }
    if (files.length === 0) {
        new Notice(lang("noNotesInScope"), 6000);
        return;
    }
    new Notice(lang("scanning"), 3000);

    let grandTotal = 0;
    const grandByTag: Record<string, number> = {};
    let notesWithTasks = 0;
    let synced = 0;

    for (const file of files) {
        const content = await app.vault.cachedRead(file);
        const { totalMinutes, byTag } = scanContent(content);
        if (totalMinutes > 0) {
            notesWithTasks++;
            grandTotal += totalMinutes;
            noteTotals.set(file.path, totalMinutes);
            for (const [t, v] of Object.entries(byTag)) {
                grandByTag[t] = (grandByTag[t] || 0) + v;
            }
        } else {
            noteTotals.set(file.path, 0);
        }
        if (pluginRef.settings.syncToFrontmatter) {
            const existing = app.metadataCache.getFileCache(file)?.frontmatter?.['time-saver'];
            if (existing !== undefined || totalMinutes > 0) {
                await writeFrontmatter(app, file, totalMinutes, byTag);
                synced++;
            }
        }
    }

    lastStats = {
        mode: 'all',
        totalMinutes: grandTotal,
        byTag: grandByTag,
        lines: [],
        notesWithTasks,
        lastComputeTime: new Date().toLocaleString()
    };
    lastStatsFile = null; // 跨笔记汇总是全局视图，置空以便切回单笔记时重新重算聚焦文件
    pushStatsToPanel();
    refreshStatusBar();

    let msg = lang("allNotesScanned").replace("{{total}}", String(files.length)).replace("{{withTasks}}", String(notesWithTasks));
    if (scope === 'folder' && folder) msg += ` (${folder})`;
    if (pluginRef.settings.syncToFrontmatter) msg += `\n${lang("frontmatterSynced").replace("{{count}}", String(synced))}`;
    if (Object.keys(grandByTag).length > 0) {
        msg += `\n${lang("byTag")}: ` + Object.entries(grandByTag)
            .sort((a, b) => b[1] - a[1])
            .map(([t, v]) => `#${t} ${formatMinutes(v)}`).join(", ");
    }
    new Notice(msg, 10000);
}

// 判断文件名是否为 daily-note（YYYY-MM-DD 及其 / . 变体），并归一化日期键
const DAILY_NAME = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/;
function isDailyNote(file: TFile): boolean {
    return DAILY_NAME.test(file.basename);
}
function dailyDateKey(file: TFile): string {
    const m = DAILY_NAME.exec(file.basename);
    if (!m) return '';
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

// 收集范围内每篇笔记的耗时（供 daily 聚合与 CSV 导出复用）：优先 frontmatter（尊重 disabled 标记），否则扫描正文
async function collectNoteStats(app: App): Promise<{ path: string; date: string | null; minutes: number; byTag: Record<string, number> }[]> {
    const scope = pluginRef.settings.scope;
    const folder = pluginRef.settings.folder;
    let files = app.vault.getMarkdownFiles();
    if (scope === 'folder' && folder) {
        files = files.filter(f => f.path === folder || f.path.startsWith(folder + '/'));
    }
    const out: { path: string; date: string | null; minutes: number; byTag: Record<string, number> }[] = [];
    for (const file of files) {
        const fm = getTimeSaverFrontmatter(app, file);
        let minutes = 0;
        let byTag: Record<string, number> = {};
        if (fm && fm.disabled === true) {
            // 用户经「移除统计」显式退出：按 0 计，不计入聚合/导出
        } else if (fm && typeof fm.total_minutes === 'number') {
            minutes = fm.total_minutes;
            byTag = isNumberRecord(fm.by_tag) ? fm.by_tag : {};
        } else {
            const content = await app.vault.cachedRead(file);
            const r = scanContent(content);
            minutes = r.totalMinutes;
            byTag = r.byTag;
        }
        out.push({ path: file.path, date: isDailyNote(file) ? dailyDateKey(file) : null, minutes, byTag });
    }
    return out;
}

// 跨日期聚合：仅作用于 daily-notes（文件名 YYYY-MM-DD 形态）。非 daily 笔记无可靠日期锚点，明确排除。
async function computeDailyNotes(app: App) {
    const all = await collectNoteStats(app);
    const daily = all.filter(x => x.date && x.minutes > 0);
    if (daily.length === 0) {
        new Notice(lang("noDailyNotes"), 6000);
        return;
    }
    const byDateMap = new Map<string, { minutes: number; byTag: Record<string, number> }>();
    let grandTotal = 0;
    for (const x of daily) {
        const key = x.date as string;
        const cur = byDateMap.get(key) || { minutes: 0, byTag: {} };
        cur.minutes += x.minutes;
        grandTotal += x.minutes;
        for (const [t, v] of Object.entries(x.byTag)) cur.byTag[t] = (cur.byTag[t] || 0) + v;
        byDateMap.set(key, cur);
    }
    const byDate = Array.from(byDateMap.entries())
        .map(([date, v]) => ({ date, minutes: v.minutes, byTag: v.byTag }))
        .sort((a, b) => b.date.localeCompare(a.date)); // 降序：最近的日期在前
    const grandByTag: Record<string, number> = {};
    for (const g of byDate) for (const [t, v] of Object.entries(g.byTag)) grandByTag[t] = (grandByTag[t] || 0) + v;
    lastStats = {
        mode: 'daily',
        totalMinutes: grandTotal,
        byTag: grandByTag,
        lines: [],
        notesWithTasks: daily.length,
        lastComputeTime: new Date().toLocaleString(),
        byDate
    };
    lastStatsFile = null;
    pushStatsToPanel();
    refreshStatusBar();
    new Notice(lang("dailyNotesScanned").replace("{{count}}", String(daily.length)).replace("{{total}}", formatMinutes(grandTotal)), 10000);
}

// 导出统计为 CSV：基于范围内每篇笔记的耗时，输出逐笔记行（含 daily 日期列）。写入 vault 根并复制到剪贴板。
async function exportStatsCsv(app: App) {
    const all = await collectNoteStats(app);
    const rows = all.filter(x => x.minutes > 0);
    if (rows.length === 0) {
        new Notice(lang("noDailyNotes"), 6000);
        return;
    }
    const header = ['note', 'path', 'is_daily', 'date', 'total_minutes', 'total_human', 'by_tag'];
    const lines: string[] = [header.join(',')];
    for (const x of rows) {
        const human = `${Math.floor(x.minutes / 60)}h${x.minutes % 60}m`;
        const byTagStr = Object.entries(x.byTag).map(([t, v]) => `#${t}:${v}`).join('; ');
        lines.push([
            x.path.split('/').pop() || x.path,
            x.path,
            x.date ? '1' : '0',
            x.date || '',
            String(x.minutes),
            human,
            `"${byTagStr.replace(/"/g, '""')}"`
        ].join(','));
    }
    const csv = '﻿' + lines.join('\n'); // BOM 便于 Excel 正确识别 UTF-8

    // 数据先入剪贴板：无论文件是否写盘成功，统计结果都不会丢失
    try {
        await navigator.clipboard.writeText(csv);
    } catch (error) {
        console.error('[TimeSaver] Could not copy CSV to clipboard', error);
        new Notice(lang('copyFail'));
    }

    const fname = `time-saver-export-${new Date().toISOString().slice(0, 10)}.csv`;
    try {
        const existing = app.vault.getAbstractFileByPath(fname);
        if (existing instanceof TFile) {
            await app.vault.modify(existing, csv);
        } else if (existing) {
            throw new Error(`Cannot export CSV because "${fname}" is not a file.`);
        } else {
            await app.vault.create(fname, csv);
        }
        new Notice(lang("csvExported").replace("{{path}}", fname), 8000);
    } catch (e) {
        // 写盘失败（最常见：文件已在 Excel 等程序中打开被系统锁定）→ 明确反馈根因，数据已在剪贴板可无损取回
        new Notice(lang("csvExportFailed").replace("{{err}}", String(e)) + "（数据已复制到剪贴板）", 9000);
    }
}

function fmtH(min: number): string {
    return (min / 60).toFixed(1) + 'h';
}

// ---- 面板 / 状态栏 ----
function getStatsPanelView(): StatsPanelView | null {
    const leaves = pluginRef.app.workspace.getLeavesOfType(VIEW_TYPE_TIMESAVER_STATS);
    for (const l of leaves) {
        if (l.view instanceof StatsPanelView) return l.view;
    }
    return null;
}

function pushStatsToPanel() {
    const v = getStatsPanelView();
    if (v && lastStats) v.setData(lastStats);
}

function ensureStatusBar() {
    if (statusBarEl) return;
    if (Platform.isMobile) return;
    if (!pluginRef.settings.showStatusBar) return;
    statusBarEl = pluginRef.addStatusBarItem();
    statusBarEl.addClass('ts-status-bar-clickable');
    statusBarEl.setAttribute('aria-label', lang('statusBarMenuHint'));
    statusBarEl.addEventListener('click', (ev: MouseEvent) => showStatusBarMenu(ev));
    refreshStatusBar();
}

async function copyStatsToClipboard() {
    if (!lastStats) {
        new Notice(lang('noStatsYet'));
        return;
    }
    const text = buildStatsReport(lastStats, lang);
    try {
        await navigator.clipboard.writeText(text);
        new Notice(lang('copySuccess'));
    } catch {
        new Notice(lang('copyFail'));
    }
}

function showStatusBarMenu(ev: MouseEvent) {
    const menu = new Menu();
    menu.addItem((item) => {
        item.setTitle(lang('computeTotalTimeInCurrentNote'));
        item.setIcon('calculator');
        item.onClick(() => runAsync(lang('computeTotalTimeInCurrentNote'), () => computeActiveNote(pluginRef.app)));
    });
    menu.addItem((item) => {
        item.setTitle(lang('computeTotalTimeInAllNotes'));
        item.setIcon('list-todo');
        item.onClick(() => runAsync(lang('computeTotalTimeInAllNotes'), () => computeTotalTimeInAllNotes(pluginRef.app)));
    });
    menu.addItem((item) => {
        item.setTitle(lang('aggregateDailyNotes'));
        item.setIcon('calendar');
        item.onClick(() => runAsync(lang('aggregateDailyNotes'), () => computeDailyNotes(pluginRef.app)));
    });
    menu.addItem((item) => {
        item.setTitle(lang('exportStatsToNote'));
        item.setIcon('file-output');
        item.onClick(() => {
            const e = getMarkdownEditor(pluginRef.app);
            if (e) runAsync(lang('exportStatsToNote'), () => exportStatsToNote(e, pluginRef.app));
            else new Notice(lang('noActiveEditor'));
        });
    });
    menu.addItem((item) => {
        item.setTitle(lang('removeStatsFromNote'));
        item.setIcon('trash');
        item.onClick(() => {
            const e = getMarkdownEditor(pluginRef.app);
            if (e) runAsync(lang('removeStatsFromNote'), () => removeStatsFromNote(e, pluginRef.app));
            else new Notice(lang('noActiveEditor'));
        });
    });
    menu.addItem((item) => {
        item.setTitle(lang('copyStats'));
        item.setIcon('copy');
        item.onClick(() => {
            runAsync(lang('copyStats'), () => copyStatsToClipboard());
        });
    });
    menu.addItem((item) => {
        item.setTitle(lang('exportStatsCsv'));
        item.setIcon('table');
        item.onClick(() => {
            runAsync(lang('exportStatsCsv'), () => exportStatsCsv(pluginRef.app));
        });
    });
    menu.addItem((item) => {
        item.setTitle(lang('togglePanel'));
        item.setIcon('bar-chart-2');
        item.onClick(() => runAsync(lang('togglePanel'), () => togglePanel()));
    });
    menu.showAtMouseEvent(ev);
}

function refreshStatusBar() {
    if (!statusBarEl) return;
    const app = pluginRef.app;
    // 当前笔记总量：活动笔记在会话内已计算的值，否则其 frontmatter
    let currentMin = 0;
    const activeFile = app.workspace.getActiveFile();
    if (activeFile) {
        const cached = noteTotals.get(activeFile.path);
        if (cached !== undefined) currentMin = cached;
        else {
            const fm = getTimeSaverFrontmatter(app, activeFile);
            if (fm && typeof fm.total_minutes === 'number') currentMin = fm.total_minutes;
        }
    }
    // 已统计的笔记数（会话内累计，来自 noteTotals），取代无日期锚点的「全部总时长」累加
    const noteCount = noteTotals.size;
    const summary = `${lang('current')} ${fmtH(currentMin)}` + (noteCount > 0 ? ` · ${noteCount} ${lang('notesUnit')}` : '');
    statusBarEl.textContent = `⏱ ${summary}`;
    const tagStr = Object.entries(lastStats ? lastStats.byTag : {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([t, v]) => `#${t} ${fmtH(v)}`)
        .join(', ');
    statusBarEl.title =
        `${lang('panelTitle')}\n${summary}` + (tagStr ? `\n${tagStr}` : '');
}

async function togglePanel() {
    const { workspace } = pluginRef.app;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_TIMESAVER_STATS);
    if (leaves.length > 0) {
        leaves.forEach(l => l.detach());
    } else {
        const leaf = workspace.getRightLeaf(false);
        if (!leaf) return;
        await leaf.setViewState({ type: VIEW_TYPE_TIMESAVER_STATS, active: true });
        pushStatsToPanel();
    }
}

class TimeSaverSettingTab extends PluginSettingTab {
    plugin: TimeSaverPlugin;

    constructor(app: App, plugin: TimeSaverPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        // ===== 通用 =====
        new Setting(containerEl).setName(lang("groupGeneral")).setHeading();

        // 添加语言设置
        new Setting(containerEl)
            .setName(lang("interfaceLanguage"))
            .setDesc(lang("interfaceLanguageDesc"))
            .addDropdown((dropdown) => {
                dropdown
                    .addOption('en', 'English')
                    .addOption('zh_CN', '中文')
                    .setValue(this.plugin.settings.language)
                    .onChange(async (value) => {
                        this.plugin.settings.language = value;
                        await this.plugin.saveSettings();
                        await changeLanguage(value, this.app);
                    });
            });

        // ===== 图片缩放 =====
        new Setting(containerEl).setName(lang("groupImages")).setHeading();

        const imageResizeInsetSetting = new Setting(containerEl)
            .setName(`${lang("imageResizeInset")} (${this.plugin.settings.imageResizeInset}px)`)
            .setDesc(lang("imageResizeInsetDesc"));
        imageResizeInsetSetting.addSlider((slider) => {
            slider
                .setLimits(0, 120, 2)
                .setValue(this.plugin.settings.imageResizeInset)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.imageResizeInset = value;
                    imageResizeInsetSetting.setName(`${lang("imageResizeInset")} (${value}px)`);
                    setImageResizeInset(value);
                    await this.plugin.saveSettings();
                });
        });


        // ===== 统计与面板 =====
        new Setting(containerEl).setName(lang("groupStats")).setHeading();

        // 状态栏摘要
        new Setting(containerEl)
            .setName(lang("showStatusBar"))
            .setDesc(lang("showStatusBarDesc"))
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.settings.showStatusBar)
                    .onChange(async (value) => {
                        this.plugin.settings.showStatusBar = value;
                        await this.plugin.saveSettings();
                        if (value) {
                            if (!statusBarEl && !Platform.isMobile) ensureStatusBar();
                            if (statusBarEl) statusBarEl.removeClass('ts-status-bar-hidden');
                        } else if (statusBarEl) {
                            statusBarEl.addClass('ts-status-bar-hidden');
                        }
                    });
            });

        // 启动时打开面板
        new Setting(containerEl)
            .setName(lang("panelDefaultOpen"))
            .setDesc(lang("panelDefaultOpenDesc"))
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.settings.panelDefaultOpen)
                    .onChange(async (value) => {
                        this.plugin.settings.panelDefaultOpen = value;
                        await this.plugin.saveSettings();
                    });
            });

        // 右键菜单入口（默认关闭，避免冗余）
        new Setting(containerEl)
            .setName(lang("showContextMenu"))
            .setDesc(lang("showContextMenuDesc"))
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.settings.showContextMenu)
                    .onChange(async (value) => {
                        this.plugin.settings.showContextMenu = value;
                        await this.plugin.saveSettings();
                    });
            });

        // ===== 插入功能 =====
        new Setting(containerEl).setName(lang("groupInsert")).setHeading();

        new Setting(containerEl)
            .setName(lang("enableInsertTask"))
            .setDesc(lang("enableInsertTaskDesc"))
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.settings.enableInsertTask)
                    .onChange(async (value) => {
                        this.plugin.settings.enableInsertTask = value;
                        await this.plugin.saveSettings();
                    });
        });

        new Setting(containerEl)
            .setName(lang("enableInsertTime"))
            .setDesc(lang("enableInsertTimeDesc"))
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.settings.enableInsertTime)
                    .onChange(async (value) => {
                        this.plugin.settings.enableInsertTime = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName(lang("enableCopyLink"))
            .setDesc(lang("enableCopyLinkDesc"))
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.settings.enableCopyLink)
                    .onChange(async (value) => {
                        this.plugin.settings.enableCopyLink = value;
                        await this.plugin.saveSettings();
                    });
            });
            
        // ===== 跨笔记聚合 =====
        new Setting(containerEl).setName(lang("groupAggregation")).setHeading();

        // 跨笔记聚合范围
        new Setting(containerEl)
            .setName(lang("scope"))
            .setDesc(lang("scopeDesc"))
            .addDropdown((dropdown) => {
                dropdown
                    .addOption('all', lang("scopeAll"))
                    .addOption('folder', lang("scopeFolder"))
                    .setValue(this.plugin.settings.scope)
                    .onChange(async (value) => {
                        this.plugin.settings.scope = value as Scope;
                        await this.plugin.saveSettings();
                        this.display();
                    });
            });

        // 指定文件夹（仅 Scope = Folder 时生效）
        new Setting(containerEl)
            .setName(lang("folder"))
            .setDesc(lang("folderDesc"))
            .addText((text) => {
                text
                    .setPlaceholder("tasks/daily")
                    .setValue(this.plugin.settings.folder)
                    .onChange(async (value) => {
                        this.plugin.settings.folder = value;
                        await this.plugin.saveSettings();
                    });
            });

        // 同步到 frontmatter
        new Setting(containerEl)
            .setName(lang("syncFrontmatter"))
            .setDesc(lang("syncFrontmatterDesc"))
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.settings.syncToFrontmatter)
                    .onChange(async (value) => {
                        this.plugin.settings.syncToFrontmatter = value;
                        await this.plugin.saveSettings();
                    });
            });
    }
}

export default class TimeSaverPlugin extends Plugin {

	settings: TimeSaverPluginSettings;
	onload(): void {
		runAsync('Plugin initialization', () => this.initialize());
	}

	private async initialize(): Promise<void> {
		pluginRef = this;

		await this.loadSettings();
		setImageResizeInset(this.settings.imageResizeInset);
		this.registerEditorExtension(createImageResizeExtension());
		// 注册设置页面
		this.addSettingTab(new TimeSaverSettingTab(this.app, this));
        await changeLanguage(this.settings.language || 'en', this.app); // 根据设置加载语言
        setPanelI18n(lang);
        setPanelActions({
            computeCurrent: () => runAsync(lang('computeTotalTimeInCurrentNote'), () => computeActiveNote(this.app)),
            computeAll: () => runAsync(lang('computeTotalTimeInAllNotes'), () => computeTotalTimeInAllNotes(this.app)),
            computeDaily: () => runAsync(lang('aggregateDailyNotes'), () => computeDailyNotes(this.app)),
            exportToNote: () => {
                const e = getMarkdownEditor(this.app);
                if (e) runAsync(lang('exportStatsToNote'), () => exportStatsToNote(e, this.app));
                else new Notice(lang("noActiveEditor"));
            },
            removeStats: () => {
                const e = getMarkdownEditor(this.app);
                if (e) runAsync(lang('removeStatsFromNote'), () => removeStatsFromNote(e, this.app));
                else new Notice(lang("noActiveEditor"));
            }
        });

        // 注册右侧栏面板视图
        this.registerView(VIEW_TYPE_TIMESAVER_STATS, (leaf) => new StatsPanelView(leaf));
        this.addRibbonIcon('bar-chart-2', lang('openTimesaverPanel'), () => {
            runAsync(lang('togglePanel'), () => togglePanel());
        });

        // 自动计算：三态，绝不在输入时静默改写文档
        registerAutoCompute();

        /**
         * 注册编辑器右键监听事件
         */
        this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, view) => {
            addContextMenu(menu, editor, this.app);
        }));

        this.addCommand({
            id: "compute-total-time",
            name: lang("computeTotalTimeInCurrentNote"),
            callback: () => runAsync(lang('computeTotalTimeInCurrentNote'), () => computeActiveNote(this.app))
        });

        this.addCommand({
            id: "compute-total-time-all-notes",
            name: lang("computeTotalTimeInAllNotes"),
            callback: () => runAsync(lang('computeTotalTimeInAllNotes'), () => computeTotalTimeInAllNotes(this.app))
        });

        this.addCommand({
            id: "aggregate-daily-notes",
            name: lang("aggregateDailyNotes"),
            callback: () => runAsync(lang('aggregateDailyNotes'), () => computeDailyNotes(this.app))
        });

        this.addCommand({
            id: "export-stats-csv",
            name: lang("exportStatsCsv"),
            callback: () => runAsync(lang('exportStatsCsv'), () => exportStatsCsv(this.app))
        });

        this.addCommand({
            id: "export-stats-to-note",
            name: lang("exportStatsToNote"),
            callback: () => {
                const e = getMarkdownEditor(this.app);
                if (!e) { new Notice(lang("noActiveEditor")); return; }
                runAsync(lang('exportStatsToNote'), () => exportStatsToNote(e, this.app));
            }
        });

        this.addCommand({
            id: "remove-stats-from-note",
            name: lang("removeStatsFromNote"),
            callback: () => {
                const e = getMarkdownEditor(this.app);
                if (!e) { new Notice(lang("noActiveEditor")); return; }
                runAsync(lang('removeStatsFromNote'), () => removeStatsFromNote(e, this.app));
            }
        });

        this.addCommand({
            id: "toggle-timesaver-panel",
            name: lang("togglePanel"),
            callback: () => {
                runAsync(lang('togglePanel'), () => togglePanel());
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

        // 状态栏摘要（移动端自动跳过）
        if (this.settings.showStatusBar && !Platform.isMobile) ensureStatusBar();
        // 启动时打开面板
        if (this.settings.panelDefaultOpen) runAsync(lang('togglePanel'), () => togglePanel());
    }

    onunload() {
        statusBarEl = null;
        lastStats = null;
        noteTotals.clear();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

}

function registerAutoCompute() {
    const app = pluginRef.app;
    // 自动计算常开：打开笔记（含 Obsidian 启动恢复的记忆文件）、编辑器失焦、保存文件三种时机均静默计算。
    // 计算为只读扫描正文，绝不改写笔记正文；frontmatter 由 syncToFrontmatter 控制写入（保持 Dataview/Bases 实时刷新），
    // 但尊重「移除统计」留下的 disabled 标记——已显式移除的笔记不再被静默写回。
    pluginRef.registerEvent(
        app.workspace.on('active-leaf-change', debounce(() => {
            // 聚焦文件变化（打开笔记 / 切换已打开的标签 / Obsidian 启动恢复的记忆文件）时，对当前笔记静默重算。
            // 用 active-leaf-change 而非 file-open：后者在切换已打开标签时不可靠重发，会导致面板/状态栏不跟随聚焦文件。
            const file = app.workspace.getActiveFile();
            if (file && file.extension === 'md' && file.path !== lastStatsFile) {
                runAsync(lang('computeTotalTimeInCurrentNote'), () => computeActiveNote(app, true));
            }
        }, 300))
    );
    pluginRef.registerEvent(
        (app.workspace as unknown as WorkspaceEventSource).on('editor-blur', debounce(() => {
            runAsync(lang('computeTotalTimeInCurrentNote'), () => computeActiveNote(app, true));
        }, 500))
    );
    pluginRef.registerEvent(
        (app.vault as unknown as VaultEventSource).on('file-modified', debounce((file: TFile) => {
            const active = app.workspace.getActiveFile();
            if (active && active.path === file.path) {
                runAsync(lang('computeTotalTimeInCurrentNote'), () => computeActiveNote(app, true));
            }
        }, 800))
    );
}

interface WorkspaceEventSource {
	on(name: string, callback: (...args: never[]) => void): EventRef;
}

interface VaultEventSource {
	on(name: string, callback: (file: TFile) => void): EventRef;
}

function getInitialLanguage(pluginSettings: Partial<TimeSaverPluginSettings> = {}): string {
    // 优先级 1: 插件设置
    if (pluginSettings.language) {
        return pluginSettings.language;
    }

    const lang = navigator.language || 'en';
	return lang.startsWith('zh') ? 'zh_CN' : 'en';
}

function computeTaskTime(taskEventData: string): [string, number] {
    // 复用 timePattern 捕获组：每组时刻 6 个捕获组（年/月/日/时/分/秒），两个时刻共 12 组
    const moments: Date[] = [];
    let match;
    while ((match = timePattern.exec(taskEventData)) !== null) {
        const start = makeMoment(match[1], match[2], match[3], match[4], match[5], match[6]);
        const end = makeMoment(match[7], match[8], match[9], match[10], match[11], match[12]);
        if (start && end) {
            // 结束时刻省略日期 → 继承开始时刻的日期（保证同一天计算，避免跨午夜误判）
            if (!match[7] && match[1]) {
                end.setFullYear(start.getFullYear(), start.getMonth(), start.getDate());
            }
            moments.push(start);
            moments.push(end);
        }
    }

    // 提取任务名称（排除时间部分）
    const taskName = taskEventData.replace(timePattern, '').trim();

    // 时间计算逻辑（每两个为一组：开始、结束）
    let totalSumInMinutes = 0;
    for (let i = 0; i + 1 < moments.length; i += 2) {
        const diff = durationMinutes(moments[i], moments[i + 1]);
        totalSumInMinutes += isNaN(diff) ? 0 : diff;
    }

    return [taskName, totalSumInMinutes];
}

function formatMinutes(minutes: number): string {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m (${minutesToHours(minutes)} ${lang('hours')})`;
}

// 把一组捕获组（年/月/日/时/分/秒，后三者必填）解析为 Date；无日期部分时沿用今天
function makeMoment(y: string | undefined, mo: string | undefined, d: string | undefined, H: string | undefined, M: string | undefined, S: string | undefined): Date | null {
    const now = new Date();
    const year = y ? parseInt(y, 10) : now.getFullYear();
    const month = mo ? parseInt(mo, 10) : now.getMonth() + 1;
    const day = d ? parseInt(d, 10) : now.getDate();
    const hh = H ? parseInt(H, 10) : NaN;
    const mm = M ? parseInt(M, 10) : NaN;
    const ss = S ? parseInt(S, 10) : 0;
    if (isNaN(hh) || isNaN(mm)) return null;
    return new Date(year, month - 1, day, hh, mm, ss);
}

function durationMinutes(before: Date | null, after: Date | null): number {
    if (!before || !after) return 0;
    let diff = Math.round((after.getTime() - before.getTime()) / 60000);
    // 跨午夜或日期倒挂：结束早于开始时默认跨到次日（+24h）
    if (diff < 0) diff += 24 * 60;
    return diff;
}

function minutesToHours(minutes: number, toFixed = 2) {
	// 分钟数转换为小时数，精确到小数点后两位
	const diffInHours = (minutes / 60).toFixed(toFixed);
	return diffInHours;
}

interface MarkdownLinkInfo {
	url: string;
	text: string;
}

function getMarkdownUrlInfo(str: string): MarkdownLinkInfo {
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
function addContextMenu(menu: Menu, editor: Editor, app: App) {
	const markdownLinkFromActiveText = getMarkdownLinkFromCursorPoint(editor);
	// 复制链接：仅当命中链接且该命令开启
	if (markdownLinkFromActiveText && pluginRef.settings.enableCopyLink) {
		menu.addItem((menuItem) => {
			menuItem.setTitle(lang("copyMarkdownLinkInfo"));
			menuItem.setIcon("copy");
			menuItem.onClick(() => {
				copyMarkDownLinkTextAndInfoFromText(markdownLinkFromActiveText)
			});
		});
	}
	// 插入任务（未完成 / 已完成）：受 enableInsertTask 开关控制
	if (pluginRef.settings.enableInsertTask) {
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
	}
	// 插入当前时间：受 enableInsertTime 开关控制
	if (pluginRef.settings.enableInsertTime) {
		menu.addItem((menuItem) => {
			menuItem.setTitle(lang("insertClockTime"));
			menuItem.setIcon("timer");
			menuItem.onClick(() => {
				insertClockTime(editor)
			});
		});
	}
	// TimeSaver 统计入口：默认关闭，避免右键菜单冗余；在设置中开启 showContextMenu 后显示
	if (pluginRef.settings.showContextMenu) {
		menu.addItem((menuItem) => {
			menuItem.setTitle(lang("computeTotalTimeInCurrentNote"));
			menuItem.setIcon("calculator");
			menuItem.onClick(() => {
				runAsync(lang('computeTotalTimeInCurrentNote'), () => computeCurrentNote(editor, app))
			});
		});
		menu.addItem((menuItem) => {
			menuItem.setTitle(lang("computeTotalTimeInAllNotes"));
			menuItem.setIcon("list-todo");
			menuItem.onClick(() => {
				runAsync(lang('computeTotalTimeInAllNotes'), () => computeTotalTimeInAllNotes(app))
			});
		});
		menu.addItem((menuItem) => {
			menuItem.setTitle(lang("exportStatsToNote"));
			menuItem.setIcon("file-output");
			menuItem.onClick(() => {
				runAsync(lang('exportStatsToNote'), () => exportStatsToNote(editor, app))
			});
		});
		menu.addItem((menuItem) => {
			menuItem.setTitle(lang("removeStatsFromNote"));
			menuItem.setIcon("trash");
			menuItem.onClick(() => {
				runAsync(lang('removeStatsFromNote'), () => removeStatsFromNote(editor, app))
			});
		});
	}
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
function copyMarkDownLinkTextAndInfoFromText(linkInfo: MarkdownLinkInfo | null): void {
	if (linkInfo == null) {
		// new Notice("没有markdown链接");
		new Notice(lang("noMarkdownLink"));
		return;
	}

	// 复制markdown链接中的文本和url到剪切板
	void navigator.clipboard.writeText(linkInfo.text + " " + linkInfo.url).then(
		() => {
			new Notice(lang("copySuccess"));
		},
		() => {
			new Notice(lang("copyFail"));
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
