import {stopGpu} from "../utils/gpu-lifecycle.js";

stopGpu().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
