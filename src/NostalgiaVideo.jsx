import React, {useMemo} from 'react';
import {
	AbsoluteFill,
	Sequence,
	Img,
	Audio,
	staticFile,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
} from 'remotion';

// --- Dynamic duration: total video length is derived from the slide data
// (which the server has already fitted to the narration audio length). ---
export const calculateNostalgiaMetadata = ({props}) => {
	const data = props.data;
	const fps = data.fps || 30;
	const outroSeconds = data.engagementPrompt ? data.outroDuration || 2.2 : 0;
	const slideFrames = data.slides.map((s) => Math.max(1, Math.round(s.duration * fps)));
	const totalFrames =
		slideFrames.reduce((a, b) => a + b, 0) + Math.round(outroSeconds * fps);

	return {
		durationInFrames: totalFrames,
		fps,
		width: data.width || 1080,
		height: data.height || 1920,
	};
};

const FRAME_FADE = 12; // frames used for cross-fade in/out on each slide

// Ken Burns pans/zooms around the slide's marked focal point (set in the
// frontend by clicking the thumbnail). Defaults to the image centre.
const KenBurnsSlide = ({src, direction = 'zoom-in', durationInFrames, sepia, focalX, focalY}) => {
	const frame = useCurrentFrame();

	const zoomDirections = {
		'zoom-in': {from: 1.0, to: 1.16, panFrom: 0, panTo: 0},
		'zoom-out': {from: 1.16, to: 1.0, panFrom: 0, panTo: 0},
		'pan-left': {from: 1.12, to: 1.12, panFrom: 3, panTo: -3},
		'pan-right': {from: 1.12, to: 1.12, panFrom: -3, panTo: 3},
	};
	const cfg = zoomDirections[direction] || zoomDirections['zoom-in'];

	const scale = interpolate(frame, [0, durationInFrames], [cfg.from, cfg.to], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});
	const panX = interpolate(frame, [0, durationInFrames], [cfg.panFrom, cfg.panTo], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});

	const fadeOpacity = interpolate(
		frame,
		[0, FRAME_FADE, durationInFrames - FRAME_FADE, durationInFrames],
		[0, 1, 1, 0],
		{extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
	);

	const originX = focalX ?? 50;
	const originY = focalY ?? 50;

	return (
		<AbsoluteFill style={{overflow: 'hidden', opacity: fadeOpacity}}>
			<Img
				src={src}
				style={{
					width: '100%',
					height: '100%',
					objectFit: 'cover',
					filter: sepia ? 'sepia(0.25) contrast(1.05) saturate(0.9)' : 'contrast(1.03)',
					transformOrigin: `${originX}% ${originY}%`,
					transform: `scale(${scale}) translateX(${panX}%)`,
				}}
			/>
			<AbsoluteFill
				style={{
					background:
						'linear-gradient(to bottom, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0) 24%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.6) 100%)',
				}}
			/>
		</AbsoluteFill>
	);
};

// Large, centred, top-of-frame year/heading — sized and positioned to read
// clearly for an older audience and to sit clear of the profile/title area
// most platforms overlay near the very top of a vertical video.
const YearStamp = ({year}) => {
	if (!year) return null;
	return (
		<AbsoluteFill style={{alignItems: 'center', top: '34%'}}>
			<div
				style={{
					fontFamily: 'Helvetica, Arial, sans-serif',
					fontWeight: 400,
					fontSize: 82,
					letterSpacing: 1,
					color: '#d8d3c8',
					textAlign: 'center',
					textShadow: '0 3px 14px rgba(0,0,0,0.6)',
					padding: '4px 36px',
				}}
			>
				{year}
			</div>
		</AbsoluteFill>
	);
};

// Splits a caption into readable chunks so long lines never get cramped or
// run off the safe area — each chunk gets screen time proportional to its
// length within the slide's duration.
function splitCaptionIntoChunks(text, maxChars = 38) {
	const clean = (text || '').trim();
	if (!clean) return [''];
	const words = clean.split(/\s+/);
	const chunks = [];
	let current = '';
	for (const word of words) {
		const candidate = current ? `${current} ${word}` : word;
		if (candidate.length > maxChars && current) {
			chunks.push(current);
			current = word;
		} else {
			current = candidate;
		}
	}
	if (current) chunks.push(current);
	return chunks.length ? chunks : [clean];
}

// Caption text, second-largest on screen, centred in the lower-middle band —
// clear of the bottom safe zone most platforms reserve for username/music/
// action buttons on a Reels-style vertical video.
const TimedCaption = ({text, durationInFrames, fps}) => {
	const frame = useCurrentFrame(); // relative to this slide's Sequence
	const chunks = useMemo(() => splitCaptionIntoChunks(text), [text]);

	const weights = chunks.map((c) => Math.max(10, c.length));
	const weightSum = weights.reduce((a, b) => a + b, 0) || 1;
	const minFrames = Math.round(1.1 * fps);
	let chunkFrames = weights.map((w) => Math.max(minFrames, Math.round((w / weightSum) * durationInFrames)));
	const rawSum = chunkFrames.reduce((a, b) => a + b, 0) || 1;
	chunkFrames = chunkFrames.map((f) => Math.max(1, Math.round((f * durationInFrames) / rawSum)));

	let acc = 0;
	const boundaries = chunkFrames.map((f) => {
		const start = acc;
		acc += f;
		return [start, acc];
	});

	let activeIndex = boundaries.findIndex(([start, end]) => frame >= start && frame < end);
	if (activeIndex === -1) activeIndex = boundaries.length - 1;
	const [start, end] = boundaries[activeIndex];
	const local = frame - start;
	const segLen = Math.max(1, end - start);
	const fadeFrames = Math.min(8, Math.floor(segLen / 4));

	const opacity = interpolate(
		local,
		[0, fadeFrames, Math.max(fadeFrames, segLen - fadeFrames), segLen],
		[0, 1, 1, 0],
		{extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
	);

	return (
		<AbsoluteFill style={{alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 480}}>
			<div
				style={{
					opacity,
					maxWidth: 940,
					fontFamily: 'Georgia, serif',
					fontWeight: 600,
					fontSize: 66,
					lineHeight: 1.32,
					color: '#FBF6EC',
					textAlign: 'center',
					textShadow: '0 3px 16px rgba(0,0,0,0.9), 0 0 5px rgba(0,0,0,0.85)',
				}}
			>
				{chunks[activeIndex]}
			</div>
		</AbsoluteFill>
	);
};

const EngagementOutro = ({prompt, channelName}) => (
	<AbsoluteFill
		style={{
			backgroundColor: '#141210',
			justifyContent: 'center',
			alignItems: 'center',
			padding: 90,
		}}
	>
		<div
			style={{
				fontFamily: 'Georgia, serif',
				fontWeight: 600,
				fontSize: 50,
				color: '#F2E9D8',
				textAlign: 'center',
				lineHeight: 1.35,
			}}
		>
			{prompt}
		</div>
		{channelName ? (
			<div
				style={{
					marginTop: 40,
					fontFamily: 'Georgia, serif',
					fontSize: 26,
					letterSpacing: 3,
					color: 'rgba(242,233,216,0.6)',
					textTransform: 'uppercase',
				}}
			>
				{channelName}
			</div>
		) : null}
	</AbsoluteFill>
);

export const NostalgiaVideo = ({data}) => {
	const {fps} = useVideoConfig();
	let startFrame = 0;

	const slideSequences = data.slides.map((slide, i) => {
		const durationInFrames = Math.max(1, Math.round(slide.duration * fps));
		const seq = (
			<Sequence key={i} from={startFrame} durationInFrames={durationInFrames}>
				<AbsoluteFill>
					<KenBurnsSlide
						src={staticFile(slide.image)}
						direction={slide.kenBurns}
						durationInFrames={durationInFrames}
						sepia={slide.sepia !== false}
						focalX={slide.focalX}
						focalY={slide.focalY}
					/>
					<YearStamp year={slide.year} />
					<TimedCaption text={slide.caption} durationInFrames={durationInFrames} fps={fps} />
				</AbsoluteFill>
			</Sequence>
		);
		startFrame += durationInFrames;
		return seq;
	});

	const outroDurationInFrames = Math.round((data.outroDuration || 2.2) * fps);

	return (
		<AbsoluteFill style={{backgroundColor: '#000'}}>
			{slideSequences}
			{data.engagementPrompt ? (
				<Sequence from={startFrame} durationInFrames={outroDurationInFrames}>
					<EngagementOutro prompt={data.engagementPrompt} channelName={data.channelName} />
				</Sequence>
			) : null}

			{data.narrationAudio ? <Audio src={staticFile(data.narrationAudio)} volume={1} /> : null}
			{data.musicAudio ? (
				<Audio src={staticFile(data.musicAudio)} volume={data.musicVolume ?? 0.12} />
			) : null}
		</AbsoluteFill>
	);
};
