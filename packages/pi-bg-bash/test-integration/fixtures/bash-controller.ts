import { join } from "node:path";
import { BashJobRegistry } from "../../src/bash-jobs.js";
import { BashExecutionLedger } from "../../src/bash-ledger.js";

const directory = process.argv[2];
if (directory === undefined) throw new Error("Missing execution directory");
const ledger = new BashExecutionLedger(join(directory, "bash.sqlite"));
const jobs = new BashJobRegistry(undefined, {
	ledger,
	onError: (message) => {
		throw new Error(message);
	},
});
const job = jobs.start({
	command: "printf 'effect\n' >> effects.txt; echo $$ > shell.pid; sleep 30",
	cwd: directory,
	background: true,
	logPath: join(directory, "execution.log"),
});
process.send?.({ id: job.id });
