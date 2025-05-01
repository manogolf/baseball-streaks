import fs from 'fs';
import crypto from 'crypto';

const FILE_PATH = './data/historical_player_props.json';

const inspectProps = () => {
    const raw = fs.readFileSync(FILE_PATH, 'utf-8');
    const props = JSON.parse(raw);

    console.log(`📦 Total props in file: ${props.length}`);

    const sample = props.slice(0, 5).map(p => {
        return {
            ...p,
            generated_id: crypto.randomUUID()
        };
    });

    console.log('🧪 Sample with generated IDs:');
    console.dir(sample, { depth: null });
};

inspectProps();
