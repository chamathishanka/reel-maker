import React from 'react';
import {Composition} from 'remotion';
import {NostalgiaVideo, calculateNostalgiaMetadata} from './NostalgiaVideo.jsx';
import defaultData from '../data/slides.example.json';

export const RemotionRoot = () => {
	return (
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
	);
};
