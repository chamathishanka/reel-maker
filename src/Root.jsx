import React from 'react';
import {Composition} from 'remotion';
import {NostalgiaVideo, calculateNostalgiaMetadata} from './NostalgiaVideo.jsx';
import {StockVideo, calculateStockMetadata} from './StockVideo.jsx';
import defaultData from '../data/slides.example.json';

// Minimal placeholder so the Stock composition is selectable in Studio; real
// props come from renderStock.mjs at render time.
const stockDefault = {
	fps: 30,
	width: 1080,
	height: 1920,
	channelName: 'Market Minute',
	disclaimer: 'For information only — not financial advice.',
	segments: [
		{kind: 'hook', text: 'Moderna jumped over 10% today.', sentiment: 'up', durationInFrames: 60},
		{
			kind: 'beat',
			ticker: 'MRNA',
			name: 'Moderna',
			price: 79.76,
			changePct: 10.01,
			sentiment: 'up',
			caption: 'MRNA +10% on FDA vote',
			durationInFrames: 90,
		},
		{kind: 'cta', text: 'Watching any of these?', durationInFrames: 60},
	],
};

export const RemotionRoot = () => {
	return (
		<>
			<Composition
				id="NostalgiaVideo"
				component={NostalgiaVideo}
				durationInFrames={300}
				fps={30}
				width={1080}
				height={1920}
				defaultProps={{data: defaultData}}
				calculateMetadata={calculateNostalgiaMetadata}
			/>
			<Composition
				id="StockVideo"
				component={StockVideo}
				durationInFrames={210}
				fps={30}
				width={1080}
				height={1920}
				defaultProps={{data: stockDefault}}
				calculateMetadata={calculateStockMetadata}
			/>
		</>
	);
};
