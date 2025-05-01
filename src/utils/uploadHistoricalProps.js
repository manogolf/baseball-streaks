// src/utils/uploadHistoricalProps.js
import fs from 'fs';
import crypto from 'crypto';
import { supabase } from '../utils/supabaseClient.js';
import streamJson from 'stream-json';
const { parser } = streamJson;
import StreamArray from 'stream-json/streamers/StreamArray.js';
const { streamArray } = StreamArray;
import streamChain from 'stream-chain';
const { chain } = streamChain;



const FILE_PATH = './data/historical_player_props.json';
const CHUNK_SIZE = 500;

const uploadHistoricalProps = async () => {
    console.log('🚚 Starting streamed upload...');

    const pipeline = chain([
        fs.createReadStream(FILE_PATH),
        parser(),
        streamArray()
    ]);

    let chunk = [];
    let index = 0;

    pipeline.on('data', async ({ value }) => {
        const rowWithId = { ...value, id: crypto.randomUUID() };
        if (index < 3) {
            console.log('🧪 Sample row:', rowWithId);
        }

        chunk.push(rowWithId);

        if (chunk.length >= CHUNK_SIZE) {
            pipeline.pause();

            const { error } = await supabase.from('model_training_props').insert(chunk);
            if (error) {
                console.error(`❌ Failed at index ${index}:`, error.message);
                pipeline.destroy();
                return;
            }

            console.log(`✅ Uploaded props ${index} to ${index + chunk.length - 1}`);
            index += chunk.length;
            chunk = [];
            pipeline.resume();
        }
    });

    pipeline.on('end', async () => {
        if (chunk.length > 0) {
            const { error } = await supabase.from('model_training_props').insert(chunk);
            if (error) {
                console.error('❌ Final chunk failed:', error.message);
            } else {
                console.log(`✅ Final chunk uploaded: ${chunk.length} props`);
            }
        }
        console.log('🏁 Streamed upload complete!');
    });

    pipeline.on('error', (err) => {
        console.error('❌ Stream error:', err.message);
    });
};

uploadHistoricalProps();
