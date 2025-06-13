// scripts/syncUserAddedPropsNow.js

import { copyUserAddedPropsToTraining } from "../backend/scripts/shared/modelTrainingUtils.js";

await copyUserAddedPropsToTraining(30); // ⏱️ sync last 30 days (or change as needed)
