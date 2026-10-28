import { StandaloneControllerError, startStandaloneController } from "./controller.js";
import { STANDALONE_CONTROLLER_ENV_KEY } from "./domain.js";

process.env[STANDALONE_CONTROLLER_ENV_KEY] = "1";

const workspace = process.argv[2];
const agentDir = process.argv[3];
if (workspace === undefined || agentDir === undefined) {
	console.error("usage: controller <workspace> <agent-dir>");
	process.exit(2);
}

try {
	const controller = await startStandaloneController({ workspace, agentDir });
	console.log(`ready ${controller.socketPath}`);
	const stop = (): void => {
		void controller.dispose().then(
			() => process.exit(0),
			(error: unknown) => {
				console.error(error instanceof Error ? error.message : String(error));
				process.exit(1);
			},
		);
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(error instanceof StandaloneControllerError ? `${error.code} ${message}` : message);
	process.exit(1);
}
