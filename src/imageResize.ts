import { EditorView, PluginValue, ViewPlugin } from '@codemirror/view';

interface EmbedRange {
	from: number;
	to: number;
	text: string;
}

interface ActiveResize {
	image: HTMLImageElement;
	corner: string;
	startX: number;
	startY: number;
	startWidth: number;
	startHeight: number;
	pointerId: number;
}

const IMAGE_PATTERN = /!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)]*\)/g;
const MARKDOWN_IMAGE_PATTERN = /^!\[((?:\\.|[^\]])*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)$/;
const MIN_IMAGE_WIDTH = 32;
type HandleCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

const HANDLE_CORNERS: HandleCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const resizeOverlays = new Set<() => void>();
let imageResizeInset = 0;
let getHandleLabel = (corner: HandleCorner) => `Resize image from ${corner.replace('-', ' ')}`;

export function setImageResizeInset(inset: number) {
	imageResizeInset = Math.max(0, Math.min(120, inset));
	resizeOverlays.forEach((updateOverlay) => updateOverlay());
}

export function setImageResizeHandleLabels(labels: Record<HandleCorner, string>) {
	getHandleLabel = (corner) => labels[corner];
	resizeOverlays.forEach((updateOverlay) => updateOverlay());
}

function findEmbedRange(view: EditorView, image: HTMLImageElement): EmbedRange | null {
	if (!view.dom.contains(image)) return null;

	const imagePosition = view.posAtDOM(image);
	const line = view.state.doc.lineAt(imagePosition);
	const lineText = line.text;
	let match: RegExpExecArray | null;
	let nearest: EmbedRange | null = null;
	let nearestDistance = Infinity;

	IMAGE_PATTERN.lastIndex = 0;
	while ((match = IMAGE_PATTERN.exec(lineText)) !== null) {
		const distance = Math.abs(line.from + match.index - imagePosition);
		if (distance < nearestDistance) {
			nearest = {
				from: line.from + match.index,
				to: line.from + match.index + match[0].length,
				text: match[0]
			};
			nearestDistance = distance;
		}
	}

	return nearest;
}

function withImageWidth(embed: string, width: number): string {
	if (!embed.startsWith('![[')) {
		const match = MARKDOWN_IMAGE_PATTERN.exec(embed);
		if (!match) return embed;

		const source = match[2].startsWith('<') && match[2].endsWith('>')
			? match[2].slice(1, -1)
			: match[2];
		const title = match[3] ?? match[4];
		const escapeAttribute = (value: string) => value
			.replace(/&/g, '&amp;')
			.replace(/"/g, '&quot;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
		const titleAttribute = title === undefined ? '' : ` title="${escapeAttribute(title)}"`;
		const alt = match[1].replace(/\\([\\\]])/g, '$1');

		return `<img src="${escapeAttribute(source)}" alt="${escapeAttribute(alt)}" width="${width}"${titleAttribute}>`;
	}

	const content = embed.slice(3, -2);
	const pipeIndex = content.lastIndexOf('|');
	const size = String(width);

	if (pipeIndex < 0) return `![[${content}|${size}]]`;

	const currentSize = content.slice(pipeIndex + 1);
	if (/^\s*\d+(?:x\d+)?\s*$/.test(currentSize)) {
		return `![[${content.slice(0, pipeIndex)}|${size}]]`;
	}

	return `![[${content}|${size}]]`;
}

class ImageResizePlugin implements PluginValue {
	private overlay: HTMLDivElement;
	private activeResize: ActiveResize | null = null;
	private hoveredImage: HTMLImageElement | null = null;

	constructor(private view: EditorView) {
		this.overlay = document.createElement('div');
		this.overlay.className = 'ts-image-resize-overlay';
		this.overlay.setAttribute('aria-hidden', 'true');

		HANDLE_CORNERS.forEach((corner) => {
			const handle = document.createElement('button');
			handle.type = 'button';
			handle.className = `ts-image-resize-handle ts-image-resize-${corner}`;
			handle.addEventListener('pointerdown', this.onPointerDown);
			this.overlay.appendChild(handle);
		});

		document.body.appendChild(this.overlay);
		resizeOverlays.add(this.updateOverlay);
		this.view.dom.addEventListener('pointerover', this.onPointerMove);
		this.view.dom.addEventListener('scroll', this.updateOverlay, true);
		window.addEventListener('pointermove', this.onPointerMove);
		window.addEventListener('pointerup', this.onPointerUp);
		window.addEventListener('pointercancel', this.onPointerUp);
		window.addEventListener('resize', this.updateOverlay);
	}

	update() {
		this.updateOverlay();
	}

	destroy() {
		this.view.dom.removeEventListener('pointerover', this.onPointerMove);
		this.view.dom.removeEventListener('scroll', this.updateOverlay, true);
		window.removeEventListener('pointermove', this.onPointerMove);
		window.removeEventListener('pointerup', this.onPointerUp);
		window.removeEventListener('pointercancel', this.onPointerUp);
		window.removeEventListener('resize', this.updateOverlay);
		resizeOverlays.delete(this.updateOverlay);
		this.overlay.remove();
	}

	private onPointerMove = (event: PointerEvent) => {
		if (this.activeResize) {
			this.resizeImage(event);
			return;
		}

		const target = document.elementFromPoint(event.clientX, event.clientY);
		if (target instanceof Element && this.overlay.contains(target)) {
			this.updateOverlay();
			return;
		}

		const image = target instanceof Element ? target.closest('img') : null;
		this.hoveredImage = image instanceof HTMLImageElement &&
			this.view.dom.contains(image) &&
			findEmbedRange(this.view, image)
			? image
			: null;
		this.updateOverlay();
	};

	private updateOverlay = () => {
		const image = this.hoveredImage;
		if (!image?.isConnected || !this.view.dom.contains(image)) {
			this.hoveredImage = null;
			this.overlay.style.display = 'none';
			return;
		}

		const rect = image.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) {
			this.overlay.style.display = 'none';
			return;
		}

		this.overlay.style.display = 'block';
		this.overlay.style.left = `${rect.left}px`;
		this.overlay.style.top = `${rect.top}px`;
		this.overlay.style.width = `${rect.width}px`;
		this.overlay.style.height = `${rect.height}px`;
		const maxInset = Math.max(0, Math.min(rect.width / 2 - 11, rect.height / 2 - 11));
		this.overlay.style.setProperty('--ts-image-resize-inset', `${Math.min(imageResizeInset, maxInset)}px`);
		this.overlay.querySelectorAll<HTMLButtonElement>('.ts-image-resize-handle').forEach((handle) => {
			const corner = HANDLE_CORNERS.find((value) => handle.classList.contains(`ts-image-resize-${value}`));
			if (!corner) return;
			const label = getHandleLabel(corner);
			handle.setAttribute('aria-label', label);
			handle.title = label;
		});
	};

	private onPointerDown = (event: PointerEvent) => {
		const handle = event.currentTarget;
		const image = this.hoveredImage;
		if (!(handle instanceof HTMLElement) || !image) return;

		const range = findEmbedRange(this.view, image);
		const rect = image.getBoundingClientRect();
		if (!range || rect.width <= 0 || rect.height <= 0) return;

		event.preventDefault();
		event.stopPropagation();
		this.activeResize = {
			image,
			corner: HANDLE_CORNERS.find((corner) => handle.classList.contains(`ts-image-resize-${corner}`)) || 'bottom-right',
			startX: event.clientX,
			startY: event.clientY,
			startWidth: rect.width,
			startHeight: rect.height,
			pointerId: event.pointerId
		};
	};

	private resizeImage(event: PointerEvent) {
		const resize = this.activeResize;
		if (!resize || event.pointerId !== resize.pointerId) return;

		const horizontalDirection = resize.corner.includes('left') ? -1 : 1;
		const verticalDirection = resize.corner.includes('top') ? -1 : 1;
		const ratio = resize.startHeight / resize.startWidth;
		const deltaX = (event.clientX - resize.startX) * horizontalDirection;
		const deltaY = ((event.clientY - resize.startY) * verticalDirection) / ratio;
		const width = Math.max(MIN_IMAGE_WIDTH, resize.startWidth + (deltaX + deltaY) / 2);

		resize.image.style.width = `${width}px`;
		resize.image.style.height = 'auto';
		this.hoveredImage = resize.image;
		this.updateOverlay();
	}

	private onPointerUp = (event: PointerEvent) => {
		const resize = this.activeResize;
		if (!resize || event.pointerId !== resize.pointerId) return;

		this.activeResize = null;
		const width = Math.max(MIN_IMAGE_WIDTH, Math.round(resize.image.getBoundingClientRect().width));
		resize.image.style.removeProperty('width');
		resize.image.style.removeProperty('height');

		const range = resize.image.isConnected ? findEmbedRange(this.view, resize.image) : null;
		if (!range) {
			this.hoveredImage = null;
			this.updateOverlay();
			return;
		}

		this.view.dispatch({
			changes: {
				from: range.from,
				to: range.to,
				insert: withImageWidth(range.text, width)
			}
		});
		this.updateOverlay();
	};
}

export function createImageResizeExtension() {
	return ViewPlugin.fromClass(ImageResizePlugin);
}
