import React from 'react';
import {
	AbsoluteFill,
	Sequence,
	Img,
	Audio,
	staticFile,
	interpolate,
	spring,
	useCurrentFrame,
	useVideoConfig,
} from 'remotion';

// Total length = sum of the (audio-fitted) segment frames the server computed.
export const calculateStockMetadata = ({props}) => {
	const data = props.data;
	const fps = data.fps || 30;
	const totalFrames = data.segments.reduce(
		(a, s) => a + Math.max(1, Math.round(s.durationInFrames)),
		0,
	);
	return {
		durationInFrames: Math.max(1, totalFrames),
		fps,
		width: data.width || 1080,
		height: data.height || 1920,
	};
};

const UP = '#16C784';
const DOWN = '#EA3943';
const NEUTRAL = '#9AA4B2';
const INK = '#F4F7FB';
const SANS = 'Helvetica, Arial, sans-serif';
const MONO = '"SF Mono", "Roboto Mono", "Consolas", monospace';

const sentimentColor = (s) => (s === 'up' ? UP : s === 'down' ? DOWN : NEUTRAL);
const fmtPct = (p) =>
	typeof p === 'number' ? `${p >= 0 ? '+' : ''}${p.toFixed(2)}%` : '';
const fmtPrice = (p) => (typeof p === 'number' ? `$${p.toFixed(2)}` : '');

// Dark backdrop: a dimmed, slowly-zooming B-roll image if present, otherwise a
// sentiment-tinted gradient. Either way it stays subordinate to the data card.
const Backdrop = ({image, sentiment, durationInFrames}) => {
	const frame = useCurrentFrame();
	const scale = interpolate(frame, [0, durationInFrames], [1.05, 1.15], {
		extrapolateRight: 'clamp',
	});
	const tint = sentimentColor(sentiment);
	return (
		<AbsoluteFill style={{backgroundColor: '#0A0E1A', overflow: 'hidden'}}>
			{image ? (
				<Img
					src={staticFile(image)}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
						transform: `scale(${scale})`,
						filter: 'brightness(0.42) saturate(0.9)',
					}}
				/>
			) : (
				<AbsoluteFill
					style={{
						background: `radial-gradient(120% 80% at 50% 18%, ${tint}22 0%, #0A0E1A 55%, #070A12 100%)`,
					}}
				/>
			)}
			<AbsoluteFill
				style={{
					background:
						'linear-gradient(to bottom, rgba(5,8,16,0.55) 0%, rgba(5,8,16,0.15) 30%, rgba(5,8,16,0.35) 62%, rgba(5,8,16,0.85) 100%)',
				}}
			/>
		</AbsoluteFill>
	);
};

// Stylized directional sparkline — an abstract motion graphic (no axis labels /
// fake price points), so it conveys the *real* direction of the move without
// asserting data we don't have candles for.
const Sparkline = ({sentiment, width = 900, height = 260}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const color = sentimentColor(sentiment);
	const rng = React.useMemo(() => {
		// deterministic jagged path with an overall up/down bias
		const bias = sentiment === 'down' ? 1 : -1; // svg y grows downward
		const pts = [];
		let y = height * (sentiment === 'down' ? 0.35 : 0.65);
		const n = 14;
		for (let i = 0; i <= n; i++) {
			const x = (i / n) * width;
			y += bias * (height / n) * 0.55 + (Math.sin(i * 1.7) * height) / 26;
			const cy = Math.max(height * 0.12, Math.min(height * 0.88, y));
			pts.push([x, cy]);
		}
		return pts;
	}, [sentiment, width, height]);

	const draw = interpolate(frame, [0, Math.round(fps * 0.9)], [0, 1], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});
	const shown = Math.max(2, Math.round(draw * rng.length));
	const pathPts = rng.slice(0, shown);
	const d = pathPts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
	const area = `${d} L${pathPts[pathPts.length - 1][0].toFixed(1)},${height} L0,${height} Z`;

	return (
		<svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
			<defs>
				<linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stopColor={color} stopOpacity="0.35" />
					<stop offset="100%" stopColor={color} stopOpacity="0" />
				</linearGradient>
			</defs>
			<path d={area} fill="url(#fill)" />
			<path d={d} fill="none" stroke={color} strokeWidth="6" strokeLinejoin="round" strokeLinecap="round" />
		</svg>
	);
};

// Animated ticker/price/% card — the primary, original visual of each beat.
const TickerCard = ({ticker, name, price, changePct, sentiment}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const color = sentimentColor(sentiment);
	const enter = spring({frame, fps, config: {damping: 200}, durationInFrames: Math.round(fps * 0.5)});
	const countT = interpolate(frame, [0, Math.round(fps * 0.6)], [0, 1], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});
	const shownPrice = typeof price === 'number' ? price * countT : null;
	const shownPct = typeof changePct === 'number' ? changePct * countT : null;
	const arrow = sentiment === 'down' ? '▼' : '▲';

	return (
		<div
			style={{
				transform: `translateY(${interpolate(enter, [0, 1], [40, 0])}px)`,
				opacity: enter,
				background: 'rgba(12,17,30,0.72)',
				border: '1px solid rgba(255,255,255,0.10)',
				borderRadius: 28,
				padding: '38px 46px',
				boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
				backdropFilter: 'blur(8px)',
				minWidth: 760,
			}}
		>
			<div style={{display: 'flex', alignItems: 'baseline', gap: 20}}>
				<div style={{fontFamily: MONO, fontWeight: 700, fontSize: 88, color: INK, letterSpacing: 1}}>
					{ticker}
				</div>
				{name ? (
					<div style={{fontFamily: SANS, fontSize: 34, color: 'rgba(244,247,251,0.6)'}}>{name}</div>
				) : null}
			</div>
			<div style={{display: 'flex', alignItems: 'center', gap: 28, marginTop: 14}}>
				<div style={{fontFamily: MONO, fontWeight: 600, fontSize: 72, color: INK}}>
					{fmtPrice(shownPrice)}
				</div>
				<div
					style={{
						fontFamily: MONO,
						fontWeight: 700,
						fontSize: 54,
						color,
						display: 'flex',
						alignItems: 'center',
						gap: 10,
					}}
				>
					<span style={{fontSize: 40}}>{arrow}</span>
					{fmtPct(shownPct)}
				</div>
			</div>
		</div>
	);
};

// Lower caption, timed to fade over its segment. Segment captions are short
// (≤ ~40 chars) so we show the whole line with a fade in/out.
const Caption = ({text, durationInFrames}) => {
	const frame = useCurrentFrame();
	if (!text) return null;
	const fade = Math.min(8, Math.floor(durationInFrames / 5));
	const opacity = interpolate(
		frame,
		[0, fade, durationInFrames - fade, durationInFrames],
		[0, 1, 1, 0],
		{extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
	);
	return (
		<AbsoluteFill style={{alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 470}}>
			<div
				style={{
					opacity,
					maxWidth: 940,
					fontFamily: SANS,
					fontWeight: 700,
					fontSize: 60,
					lineHeight: 1.28,
					color: INK,
					textAlign: 'center',
					textShadow: '0 3px 18px rgba(0,0,0,0.9)',
				}}
			>
				{text}
			</div>
		</AbsoluteFill>
	);
};

const HookCard = ({text, durationInFrames}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const enter = spring({frame, fps, config: {damping: 200}, durationInFrames: Math.round(fps * 0.6)});
	const opacity = interpolate(
		frame,
		[0, 8, durationInFrames - 8, durationInFrames],
		[0, 1, 1, 1],
		{extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
	);
	return (
		<AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', padding: 90}}>
			<div
				style={{
					opacity,
					transform: `translateY(${interpolate(enter, [0, 1], [30, 0])}px)`,
					fontFamily: SANS,
					fontWeight: 800,
					fontSize: 84,
					lineHeight: 1.15,
					color: INK,
					textAlign: 'center',
					textShadow: '0 4px 24px rgba(0,0,0,0.8)',
				}}
			>
				{text}
			</div>
		</AbsoluteFill>
	);
};

const OutroCard = ({cta, disclaimer, channelName}) => (
	<AbsoluteFill
		style={{
			background: 'radial-gradient(120% 80% at 50% 30%, #131A2E 0%, #0A0E1A 60%, #070A12 100%)',
			alignItems: 'center',
			justifyContent: 'center',
			padding: 90,
		}}
	>
		<div style={{fontFamily: SANS, fontWeight: 800, fontSize: 70, color: INK, textAlign: 'center', lineHeight: 1.2}}>
			{cta}
		</div>
		{channelName ? (
			<div
				style={{
					marginTop: 44,
					fontFamily: SANS,
					fontSize: 30,
					letterSpacing: 3,
					color: 'rgba(244,247,251,0.55)',
					textTransform: 'uppercase',
				}}
			>
				{channelName}
			</div>
		) : null}
		{disclaimer ? (
			<div
				style={{
					position: 'absolute',
					bottom: 150,
					fontFamily: SANS,
					fontSize: 24,
					color: 'rgba(244,247,251,0.4)',
					textAlign: 'center',
				}}
			>
				{disclaimer}
			</div>
		) : null}
	</AbsoluteFill>
);

// Persistent disclaimer strip during content beats (compliance).
const DisclaimerStrip = ({text}) =>
	text ? (
		<AbsoluteFill style={{alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 60}}>
			<div style={{fontFamily: SANS, fontSize: 22, color: 'rgba(244,247,251,0.42)'}}>{text}</div>
		</AbsoluteFill>
	) : null;

export const StockVideo = ({data}) => {
	const {fps} = useVideoConfig();
	let startFrame = 0;

	const sequences = data.segments.map((seg, i) => {
		const durationInFrames = Math.max(1, Math.round(seg.durationInFrames));
		const content =
			seg.kind === 'hook' ? (
				<AbsoluteFill>
					<Backdrop sentiment={seg.sentiment} durationInFrames={durationInFrames} />
					<HookCard text={seg.text} durationInFrames={durationInFrames} />
				</AbsoluteFill>
			) : seg.kind === 'cta' ? (
				<OutroCard cta={seg.text} disclaimer={data.disclaimer} channelName={data.channelName} />
			) : (
				<AbsoluteFill>
					<Backdrop image={seg.image} sentiment={seg.sentiment} durationInFrames={durationInFrames} />
					<AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', paddingBottom: 120}}>
						<Sparkline sentiment={seg.sentiment} />
						<div style={{height: 40}} />
						<TickerCard
							ticker={seg.ticker}
							name={seg.name}
							price={seg.price}
							changePct={seg.changePct}
							sentiment={seg.sentiment}
						/>
					</AbsoluteFill>
					<Caption text={seg.caption} durationInFrames={durationInFrames} />
					<DisclaimerStrip text={data.disclaimer} />
				</AbsoluteFill>
			);

		const seq = (
			<Sequence key={i} from={startFrame} durationInFrames={durationInFrames}>
				{content}
				{seg.audio ? <Audio src={staticFile(seg.audio)} /> : null}
			</Sequence>
		);
		startFrame += durationInFrames;
		return seq;
	});

	return <AbsoluteFill style={{backgroundColor: '#070A12'}}>{sequences}</AbsoluteFill>;
};
