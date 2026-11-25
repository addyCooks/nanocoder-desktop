import * as React from 'react';
import {Icon} from '@/renderer/icons';
import {clampSize, ResizeHandle, usePanelSizes} from '@/renderer/resize-handle';
import {Button} from '@/renderer/ui';

const defaults = {rail: 260, bottom: 360};

const readViewport = () => ({
	width: globalThis.innerWidth ?? 1280,
	height: globalThis.innerHeight ?? 800,
});

function useViewport() {
	const [size, setSize] = React.useState(readViewport);
	React.useEffect(() => {
		const update = () => setSize(readViewport());
		globalThis.addEventListener('resize', update);
		return () => globalThis.removeEventListener('resize', update);
	}, []);
	return size;
}

export function AppShell({
	title,
	logoSrc,
	threadTitle,
	projectName,
	statusBadges,
	projectRail,
	threadRail,
	sidebarFooter,
	onOpenThreadMenu,
	streamTools,
	composer,
	composerPlacement = 'bottom',
	approvalShelf,
	palette,
	workbench,
	bottomPanel,
	children,
}: {
	title: React.ReactNode;
	logoSrc?: string;
	// Undefined on the welcome page, which shows the local workspace eyebrow.
	threadTitle?: string;
	projectName?: string;
	// Header turn status slot.
	statusBadges?: React.ReactNode;
	projectRail?: React.ReactNode;
	threadRail?: React.ReactNode;
	// Sidebar footer slot. Its rows are styled by the sidebar.
	sidebarFooter?: React.ReactNode;
	// Shows the thread actions button after the title when set.
	onOpenThreadMenu?: () => void;
	streamTools?: React.ReactNode;
	composer?: React.ReactNode;
	composerPlacement?: 'centred' | 'bottom';
	approvalShelf?: React.ReactNode;
	palette?: React.ReactNode;
	workbench?: {title: string; children: React.ReactNode; onClose(): void};
	bottomPanel?: React.ReactNode;
	children: React.ReactNode;
}) {
	const inThread = threadTitle !== undefined;
	const [sizes, setSize] = usePanelSizes();
	const viewport = useViewport();
	// A saved size is kept between the limits the handles use, so a stored 1 cannot hide a panel.
	const railMax = Math.min(420, viewport.width - 480);
	const rail = sizes.rail ? clampSize(sizes.rail, 180, railMax) : defaults.rail;
	const workbenchDefault = Math.min(
		720,
		Math.round((viewport.width - rail) * 0.42),
	);
	const workbenchMax = viewport.width - rail - 420;
	const workbenchSize = sizes.workbench
		? clampSize(sizes.workbench, 280, workbenchMax)
		: workbenchDefault;
	const bottomMax = Math.round(viewport.height * 0.75);
	const bottom = sizes.bottom
		? clampSize(sizes.bottom, 160, bottomMax)
		: defaults.bottom;
	const style = {
		...(sizes.rail && {'--shell-rail-width': `${rail}px`}),
		...(sizes.workbench && {'--shell-workbench-width': `${workbenchSize}px`}),
		...(sizes.bottom && {'--shell-bottom-height': `${bottom}px`}),
	} as React.CSSProperties;
	return (
		<div className="app-shell" style={style}>
			<aside className="shell-project-rail" aria-label="project rail">
				<ResizeHandle
					label="resize sidebar"
					axis="x"
					direction={1}
					className="shell-rail-resize"
					size={rail}
					min={180}
					max={railMax}
					onResize={size => setSize('rail', size)}
					onReset={() => setSize('rail', undefined)}
				/>
				<h1 className="shell-brand">
					{logoSrc && <img className="official-logo" src={logoSrc} alt="" />}
					{title}
				</h1>
				<div data-shell-slot="project-rail">{projectRail}</div>
				<div data-shell-slot="thread-rail">{threadRail}</div>
				{sidebarFooter && (
					<footer className="shell-sidebar-footer">{sidebarFooter}</footer>
				)}
			</aside>
			<div className="shell-main-area">
				<header className="shell-title-bar">
					<div className="shell-identity">
						<h2>{inThread ? threadTitle : 'your projects'}</h2>
						<p className="shell-breadcrumb">
							{inThread
								? (projectName ?? 'selected project')
								: 'local workspace'}
						</p>
						{inThread && onOpenThreadMenu && (
							<button
								type="button"
								className="shell-menu-button"
								aria-label="thread actions"
								aria-haspopup="dialog"
								onClick={onOpenThreadMenu}
							>
								more
							</button>
						)}
					</div>
					<div className="shell-header-actions">
						{statusBadges}
						{palette}
					</div>
				</header>
				<div className="shell-canvas" data-workbench-open={Boolean(workbench)}>
					<main
						className="shell-stream"
						aria-label="conversation workspace"
						data-composer-placement={composerPlacement}
					>
						<div
							className="shell-stream-scroll"
							role="region"
							aria-label="conversation"
							tabIndex={0}
						>
							{streamTools && (
								<div
									className="shell-stream-tools"
									data-shell-slot="stream-tools"
								>
									{streamTools}
								</div>
							)}
							<div className="technical-gate">{children}</div>
						</div>
						<div className="shell-conversation-footer">
							{approvalShelf && (
								<div
									className="shell-approval-shelf"
									aria-label="approval shelf"
								>
									{approvalShelf}
								</div>
							)}
							{composer && <div className="shell-composer">{composer}</div>}
						</div>
					</main>
					{workbench && (
						<aside
							className="shell-workbench"
							aria-label={workbench.title}
							data-shell-slot="workbench"
						>
							<ResizeHandle
								label="resize side panel"
								axis="x"
								direction={-1}
								className="shell-workbench-resize"
								size={workbenchSize}
								min={280}
								max={workbenchMax}
								onResize={size => setSize('workbench', size)}
								onReset={() => setSize('workbench', undefined)}
							/>
							<header className="shell-workbench-header">
								<h2>{workbench.title}</h2>
								<Button
									className="close-button"
									aria-label={
										viewport.width <= 840 ? 'back to chat' : 'close panel'
									}
									onClick={workbench.onClose}
								>
									<Icon name="close" size={16} />
								</Button>
							</header>
							{workbench.children}
						</aside>
					)}
				</div>
				{bottomPanel && (
					<section
						className="shell-bottom-panel"
						aria-label="project tools"
						data-shell-slot="bottom-panel"
					>
						<ResizeHandle
							label="resize bottom panel"
							axis="y"
							direction={-1}
							className="shell-bottom-resize"
							size={bottom}
							min={160}
							max={bottomMax}
							onResize={size => setSize('bottom', size)}
							onReset={() => setSize('bottom', undefined)}
						/>
						{bottomPanel}
					</section>
				)}
			</div>
		</div>
	);
}
