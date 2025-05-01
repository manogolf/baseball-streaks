import cron from 'node-cron';

// ✅ Define and export the main function
export const updateAndSyncProps = async () => {
    console.log('🔄 Running update and sync logic...');
    // TODO: Add your combined updatePropStatuses and syncTrainingData logic here
    // e.g., await updatePropStatuses(); await syncTrainingData();
};

console.log('⏳ Cron job starting...');

// Determine in-season status (March = 2, October = 9)
const month = new Date().getUTCMonth(); // 0 = January
const inSeason = month >= 2 && month <= 9;

const cronExpression = inSeason ? '*/30 * * * *' : '0 10 * * *';
console.log(`📅 Scheduling cron job: ${inSeason ? 'every 30 minutes (in-season)' : 'daily at 10:00 UTC (off-season)'}`);

const isGitHubAction = process.env.GITHUB_ACTIONS === 'true';

if (isGitHubAction) {
    // 🔁 Manual run for GitHub Actions — don't start cron
    (async () => {
        console.log('🚀 GitHub Action: running updateAndSyncProps...');
        await updateAndSyncProps();
        console.log('✅ GitHub Action: job complete. Exiting...');
        process.exit(0);
    })();
} else {
    // 🔁 Local or server: run once and start cron
    (async () => {
        console.log('🚀 Local run: updateAndSyncProps...');
        await updateAndSyncProps();
    })();

    cron.schedule(cronExpression, async () => {
        const now = new Date().toISOString();
        console.log(`🕒 Cron triggered at ${now}`);
        await updateAndSyncProps();
        console.log('✅ Cron job complete.\n');
    });
}


