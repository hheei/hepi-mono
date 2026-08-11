// Test-isolation guard — runs before test files. Production Pi MCTX storage is
// `${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions/pi-mctx`; tests use this
// throwaway XDG root only while NODE_ENV=test. Do not remove.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isolatedDataHome = mkdtempSync(join(tmpdir(), "mc-pi-test-xdg-"));

// Bulletproof DB guard (see @magic-context/core resolveDatabasePath): never
// mutated by any test, so a bare openDatabase() can never reach the real DB.
process.env.MAGIC_CONTEXT_TEST_DATA_DIR = isolatedDataHome;
process.env.XDG_DATA_HOME = isolatedDataHome;
