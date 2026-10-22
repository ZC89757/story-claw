import {startGpu, stopGpu} from "../utils/gpu-lifecycle.js";

try {
  if (process.argv[2] === "start") await startGpu();
  else if (process.argv[2] === "stop") await stopGpu();
  else throw new Error("Usage: tsx scripts/gpu-service.ts start|stop");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
